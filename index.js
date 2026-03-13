const express = require('express');
const line = require('@line/bot-sdk');
const { GoogleGenAI } = require('@google/genai');

const app = express();

// ===== 設定 =====
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(lineConfig);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SHOPIFY_DOMAIN       = process.env.SHOPIFY_DOMAIN || 'printeez-jp.myshopify.com';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION  = '2024-01';

// ===== DB（インメモリ）=====
const users = new Map();
const processedEvents = new Set();
const eventTimestamps = new Map();
const processingUsers = new Set();

const EVENT_TTL_MS     = 10 * 60 * 1000;
const STAFF_TIMEOUT_MS = 60 * 60 * 1000;

function saveEventId(eventId) {
  processedEvents.add(eventId);
  eventTimestamps.set(eventId, Date.now());
}
function isProcessed(eventId) {
  return processedEvents.has(eventId);
}
setInterval(() => {
  const now = Date.now();
  for (const [eventId, ts] of eventTimestamps) {
    if (now - ts > EVENT_TTL_MS) {
      processedEvents.delete(eventId);
      eventTimestamps.delete(eventId);
    }
  }
}, 5 * 60 * 1000);

function getUser(userId) {
  if (!users.has(userId)) {
    users.set(userId, { mode: 'bot', staffSince: null, lastBotReply: null });
  }
  return users.get(userId);
}
function aiOn(userId) {
  const user = getUser(userId);
  user.mode = 'bot';
  user.staffSince = null;
  processingUsers.delete(userId);
  console.log(`[${userId}] AI復帰`);
}
function aiOff(userId) {
  const user = getUser(userId);
  user.mode = 'staff';
  user.staffSince = Date.now();
  console.log(`[${userId}] スタッフモードON`);
}

// ===== HPスクレイピング（料金・FAQ用）=====
let cachedSiteInfo = null;
let cacheUpdatedAt = 0;
const CACHE_TTL = 60 * 60 * 1000;

const SCRAPE_PAGES = [
  { url: 'https://printeez.jp/pages/about-price', label: '料金ページ' },
  { url: 'https://printeez.jp/pages/faq',         label: 'よくある質問' },
];

async function fetchPageText(url) {
  const res = await fetch(url);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, '\n')
    .trim()
    .slice(0, 4000);
}

async function getSiteInfo() {
  const now = Date.now();
  if (cachedSiteInfo && now - cacheUpdatedAt < CACHE_TTL) return cachedSiteInfo;
  console.log('HPから最新情報を取得中...');
  let result = '';
  for (const page of SCRAPE_PAGES) {
    try {
      const text = await fetchPageText(page.url);
      result += `\n=== ${page.label}（${page.url}）===\n${text}\n`;
    } catch (e) {
      console.error(`取得失敗: ${page.url}`, e.message);
    }
  }
  cachedSiteInfo = result;
  cacheUpdatedAt = now;
  return result;
}

// ===== Shopify Admin API 商品取得 =====
let cachedProducts = null;
let productsCacheUpdatedAt = 0;
const PRODUCTS_CACHE_TTL = 60 * 60 * 1000;

const SHOPIFY_COLLECTIONS = [
  { handle: 't-shirts',      label: 'Tシャツ' },
  { handle: 'sweat',         label: 'スウェット' },
  { handle: 'hoody-sweat',   label: 'パーカー' },
  { handle: 'long-t-shirts', label: 'ロンT' },
  { handle: 'polo-shirts',   label: 'ドライ/ポロシャツ' },
  { handle: 'cap-hat',       label: 'キャップ/ハット' },
  { handle: 'bag-totebag',   label: 'バッグ/トートバッグ' },
];

function stripHtml(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 300);
}

async function fetchCollectionId(handle) {
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/custom_collections.json?handle=${handle}`;
  const res = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
  });
  const data = await res.json();
  if (data.custom_collections && data.custom_collections.length > 0) {
    return data.custom_collections[0].id;
  }
  const url2 = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/smart_collections.json?handle=${handle}`;
  const res2 = await fetch(url2, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
  });
  const data2 = await res2.json();
  if (data2.smart_collections && data2.smart_collections.length > 0) {
    return data2.smart_collections[0].id;
  }
  return null;
}

async function fetchProductsByCollectionId(collectionId) {
  const products = [];
  let url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products.json?collection_id=${collectionId}&limit=250&fields=id,title,handle,body_html,variants`;

  while (url) {
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
    });
    const data = await res.json();
    if (data.products) products.push(...data.products);

    const linkHeader = res.headers.get('Link');
    const nextMatch = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }
  return products;
}

async function getProductInfo() {
  const now = Date.now();
  if (cachedProducts && now - productsCacheUpdatedAt < PRODUCTS_CACHE_TTL) {
    return cachedProducts;
  }
  console.log('Shopify APIから商品情報を取得中...');

  let result = '';

  for (const col of SHOPIFY_COLLECTIONS) {
    try {
      const collectionId = await fetchCollectionId(col.handle);
      if (!collectionId) {
        console.warn(`コレクションID取得失敗: ${col.handle}`);
        continue;
      }

      const products = await fetchProductsByCollectionId(collectionId);
      if (products.length === 0) continue;

      result += `\n=== ${col.label} ===\n`;

      for (const p of products) {
        // 最安値を取得
        const prices = (p.variants || []).map(v => parseFloat(v.price)).filter(n => !isNaN(n));
        const minPrice = prices.length > 0 ? Math.min(...prices) : null;
        const priceStr = minPrice !== null ? `¥${minPrice.toLocaleString()}〜` : '価格不明';

        const desc    = stripHtml(p.body_html);
        const pageUrl = `https://printeez.jp/products/${p.handle}`;

        result += `・${p.title}\n`;
        result += `  価格：${priceStr}\n`;
        result += `  説明：${desc}\n`;
        result += `  URL：${pageUrl}\n`;
        result += '\n';
      }
    } catch (e) {
      console.error(`商品取得失敗: ${col.handle}`, e.message);
    }
  }

  cachedProducts = result;
  productsCacheUpdatedAt = now;
  return result;
}

// ===== キーワード判定 =====

// 商品情報が必要なキーワード（価格系も含む）
const PRODUCT_KEYWORDS = [
  'おすすめ', 'お勧め', 'どれ', 'どんな', '商品', 'ボディ',
  'Tシャツ', 'パーカー', 'トレーナー', 'ポロシャツ', 'タンクトップ',
  'キャップ', 'バッグ', 'トートバッグ', 'スウェット', 'ロンT',
  'ジャケット', '生地', '素材', '種類',
  // 価格系：商品の値段を聞く場合は商品情報も必要
  '値段', '価格', 'いくら', '円', '安い', '高い',
];
function needsProductInfo(message) {
  return PRODUCT_KEYWORDS.some(kw => message.includes(kw));
}

// サイト情報が必要なキーワード（送料・納期・割引など）
const SITE_KEYWORDS = [
  '料金', '送料', '納期', '発送', 'いつ', '何日', '営業日', '特急',
  '枚数', '割引', '無料', '追加料金', '費用',
  // 計算系
  '合計', '総額', '計算', '見積', 'トータル', '全部で', 'いくらになる',
  'プリント', 'スクリーン', 'フルカラー', '刺繍', '加工',
];
function needsSiteInfo(message) {
  return SITE_KEYWORDS.some(kw => message.includes(kw));
}

const STAFF_REQUEST_KEYWORDS = [
  'スタッフ', '人間', '担当者', '変わって', '代わって', '繋いで', 'つないで',
  '直接', '話したい', 'オペレーター',
];

// 再生産・追加注文キーワード
const REORDER_KEYWORDS = [
  '再生産', '追加注文', '追加生産', '再注文', 'また頼みたい', 'また注文',
  '同じものを', '前回と同じ', 'リピート', '追加で',
];
function isReorderRequest(message) {
  return REORDER_KEYWORDS.some(kw => message.includes(kw));
}
function isStaffRequest(message) {
  return STAFF_REQUEST_KEYWORDS.some(kw => message.includes(kw));
}

// ===== システムプロンプト =====
const BASE_SYSTEM_PROMPT = `
あなたはPrinteez（プリントTシャツ通販）の公式LINEアシスタント「キキ」です。
狐の女の子のキャラクターで、明るく親しみやすい口調で、失礼のない敬語で話します。
挨拶や自己紹介の時だけ🦊の絵文字を使ってください。それ以外では🦊は使わないでください。
自己紹介を求められた場合は「PrinteezのAI、キキ🦊です！」と答えてください。

マークダウン記法（**太字**など）は【絶対に】使わないでください。プレーンテキストのみ。
LINEなので返答は短めに。絵文字は1テキストに1〜3個以内。読みやすいよう改行を入れてください。

あなたは内部思考を持ちますが、それは絶対にユーザーに表示してはいけません。
ユーザーに表示されるのはJSONのみです。

次のような思考テキストは絶対に出力してはいけません：
THOUGHT / THINK / THINKING / THINTELL / REASONING / 内部推論 / 思考
もしそれらを生成してしまった場合は、完全に削除してからJSONのみを出力してください。

最終出力は必ず次のJSONのみです。JSON以外のテキストを絶対に出力しないでください。
{
  "text": "返答テキスト",
  "quickReplies": ["選択肢1", "選択肢2"],
  "autoHandoff": false
}

autoHandoffはステップ3または4が完了したと判断したときだけtrueにしてください。それ以外はfalseです。

quickRepliesは【必ず毎回】2〜4個出してください。省略厳禁です。
空配列にしていいのは、ユーザーが「ありがとう」「解決しました」など明確に会話終了を示した時だけです。
各選択肢は13文字以内にしてください（LINEの制限）。

=== あなたの仕事 ===

【役割】
・お客様の質問に答えること
・注文のステップ1〜3（またはデザイン入稿準備）までをアシストすること
・ステップ3または4が完了したらスタッフへ引き継ぐこと

【注文フロー】
ステップ0：デザインの有無を確認
  → デザインなし：シミュレーター（https://printeez.jp）またはCanva（https://www.canva.com）を案内
  → デザインあり：ステップ1へ

ステップ1：商品を選んでもらう
  → 用途・好みを聞いてカテゴリ・商品をおすすめする
  → 商品が決まったらステップ2へ

ステップ2：加工方法を選ぶ
  → スクリーンプリント / フルカラープリント / 刺繍 を説明して選んでもらう
  → 加工が決まったらステップ3へ

ステップ3：数量・サイズ・カラー内訳を教えてもらう
  → 例）Mサイズ×5枚、Lサイズ×3枚、ホワイト など
  → この情報が揃ったら見積もりを計算してスタッフへ引き継ぐ（autoHandoff: true）

ステップ4（デザイン入稿案内）：
  ステップ3が完了したら、以下の入稿案内を必ず伝えてください：
  「デザインデータの入稿方法についてご案内します！
PDF・AI・PSDファイルはこのLINEから直接お送りいただけます。
画像ファイル（JPG・PNG等）は画質が低下するため、以下からアップロードをお願いします。

📧 MAIL：contact@printeez.jp
🔗 HP：https://printeez.jp/products/ファイルアップロード用ページ」
  その後、クイックリプライで「入稿完了」「入稿できない」「スタッフを呼ぶ」を出してください。
  → 「入稿完了」または「スタッフを呼ぶ」が選ばれたら autoHandoff: true にしてスタッフへ引き継ぐ
  → 「入稿できない」が選ばれたらMAILまたはHPのURLを再案内する

【再生産・追加注文の対応】
「再生産」「追加注文」「追加生産」「また頼みたい」などのキーワードが来たら以下を返してください：
「ご連絡いただきありがとうございます！
まずはご注文履歴を確認いたしますので少々お待ちください🙏

以下の情報がお分かりであればお知らせください：
・2300から始まるご注文番号
・当時の受け取り先住所・受取名・メールアドレス

ご返信いただき次第、スタッフへお繋ぎします！」
その後 autoHandoff: true にしてスタッフへ引き継いでください。

【自動引き継ぎのタイミング】
以下のどちらかが揃ったら autoHandoff: true にしてください：
・商品 ＋ 加工方法 ＋ 数量/サイズ/カラー内訳がすべて揃った
・お客様がデザインデータを送る準備ができたと言った

引き継ぎ前に必ず以下を返答に含めてください：
「内容を確認します！
商品：〇〇
加工：〇〇
数量：〇〇
スタッフにお繋ぎしますね🙏」

=== 最初のメッセージについて ===

ユーザーが最初にメッセージを送ってきたとき（会話履歴が1件目）は、
必ず以下の内容を含めた自己紹介をしてください：
・AIアシスタント「キキ」であること
・できること（質問への回答・注文ステップ1〜3のアシスト）
・ステップ4以降はスタッフが対応すること
・「よろしければこのままご案内します！」という一言
そしてデザインの有無を聞いてください。

=== 価格・料金計算 ===

商品情報が提供された場合は必ず価格（¥〇〇〜）をユーザーに伝えてください。
価格を聞かれたら提供された商品情報の「価格：」の行を必ず参照してください。

数量・商品・加工方法が揃ったら以下の式で合計金額を計算してください：
  単価 = 商品代金 + 加工代金
  合計 = 単価 × 枚数 + 送料（一律¥1,000）
計算結果は「商品 ¥〇〇 ＋ 加工 ¥〇〇 = 単価 ¥〇〇 × 〇枚 ＋ 送料 ¥1,000 = 合計 ¥〇〇」の形式で示してください。
加工代金は提供された料金ページの情報を参照してください。

=== 商品URL ===

商品が特定できた場合は返答のtextの中に必ずURLを含めてください。
カテゴリURL例：
Tシャツ→https://printeez.jp/collections/t-shirts
パーカー→https://printeez.jp/collections/hoody-sweat
スウェット→https://printeez.jp/collections/sweat
ロンT→https://printeez.jp/collections/long-t-shirts
キャップ→https://printeez.jp/collections/cap-hat
バッグ→https://printeez.jp/collections/bag-totebag

=== Printeez 基本情報 ===

【注文方法】
①商品を選ぶ → ②加工方法を選ぶ → ③シミュレーターでデザイン作成 → ④注文完了
シミュレーター未掲載の商品・加工はLINEまたはメールで問い合わせ。
見積書作成・レイアウトイメージ作成も対応。

【レイアウトイメージ】
・お問い合わせ経由の注文：スタッフが1〜3営業日で作成（位置・サイズ確認用）
・シミュレーター入稿：シミュレーター上のサムネイルを使用
・レイアウトイメージ作成後のキャンセル：次回注文時にキャンセル料¥900が加算

【キャンセル】
製作開始後のキャンセル不可。決済前はキャンセル可能。タイミングによってはカード会社から5%の手数料が差し引かれるので了承を得る。

【データ形式】
AI・PSD・PNG・JPEG・PDFなどに対応。
その他、手書きでも可能だが、書き起こしに3-6営業日ほどかかる。

【加工】
・スクリーンプリント：最大4色/箇所、発色鮮やか
・フルカラープリント：フルカラーOK、写真・小ロット向き
・刺繍：ロゴ等に対応、糸色指定可、通常5色まで。写真や1mm以下の細部は対応不可。
・袖・ポケット上も可能だがスタッフによるデザイン確認必要
・持ち込みタグの縫い付けも可能
・袋詰めも可能

【その他】
・1枚から注文OK
・直接受け取り不可（配送のみ）
・電話対応不可
・領収書：アカウント画面のご注文詳細からダウンロード
・大口注文（数百〜数千枚）：contact@printeez.jp へ
`;

// ===== 会話履歴 =====
const conversationHistory = new Map();

// ===== 会話要約＆スタッフ引き継ぎ =====
async function handoffToStaff(userId) {
  const history = conversationHistory.get(userId) || [];
  const historyText = history
    .map(h => `${h.role === 'user' ? 'お客様' : 'キキ'}: ${h.parts[0].text}`)
    .join('\n');

  let summary = '（要約取得失敗）';
  try {
    const res = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [{ text: `以下の会話を2〜3行で要約してください。スタッフへの引き継ぎメモとして使います。敬語不要、箇条書きOK。\n\n${historyText}` }],
      }],
    });
    summary = res.text.trim().slice(0, 200);
  } catch (e) {
    console.error('要約生成エラー:', e.message);
  }

  aiOff(userId);
  return `スタッフにお繋ぎします！少々お待ちください🙏\n\nご要件メモ：\n${summary}`;
}

// ===== ローディングアニメーション =====
async function showLoadingAnimation(userId, seconds = 30) {
  await fetch('https://api.line.me/v2/bot/chat/loading/start', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ chatId: userId, loadingSeconds: seconds }),
  });
}

// ===== 思考ブロック除去フィルタ =====
function filterThought(rawText) {
  return rawText
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .replace(/THOUGHT[\s\S]*?\}/gi, '}')
    .replace(/THINTELL[\s\S]*?\}/gi, '}')
    .replace(/THINK[\s\S]*?\}/gi, '}')
    .replace(/THINKING[\s\S]*?\}/gi, '}')
    .replace(/REASONING[\s\S]*?\}/gi, '}')
    .replace(/内部推論[\s\S]*?\}/gi, '}')
    .replace(/思考[\s\S]*?\}/gi, '}')
    .trim();
}

// ===== Geminiに問い合わせる関数 =====
async function askGemini(userId, userMessage) {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId);

  let systemPrompt = BASE_SYSTEM_PROMPT;

  if (needsSiteInfo(userMessage)) {
    try {
      const siteInfo = await getSiteInfo();
      systemPrompt += `\n=== 公式サイト最新情報（自動取得）===\n${siteInfo}`;
      console.log(`[${userId}] HPから最新情報を注入`);
    } catch (e) {
      console.error('HP取得エラー:', e.message);
    }
  }

  if (needsProductInfo(userMessage)) {
    try {
      const productInfo = await getProductInfo();
      systemPrompt += `\n=== 取扱商品情報（Shopify最新・価格含む）===\n${productInfo}`;
      console.log(`[${userId}] 商品情報を注入`);
    } catch (e) {
      console.error('商品取得エラー:', e.message);
    }
  }

  history.push({ role: 'user', parts: [{ text: userMessage }] });

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: history,
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: 'application/json',
    },
  });

  const rawText = response.text.trim();
  const cleaned = filterThought(rawText);

  let parsed = { text: cleaned, quickReplies: [] };
  try {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error('JSONパース失敗:', e.message);
    parsed.text = '少し問題が発生しました。もう一度お試しください🙏';
  }

  history.push({ role: 'model', parts: [{ text: parsed.text }] });
  if (history.length > 20) history.splice(0, 2);

  return parsed;
}

// ===== LINEメッセージ組み立て =====
function buildMessage(parsed) {
  const msg = {
    type: 'text',
    text: parsed.text + '\n\n※ AIキキが返答しています',
  };

  if (parsed.quickReplies && parsed.quickReplies.length > 0) {
    msg.quickReply = {
      items: parsed.quickReplies.map(label => ({
        type: 'action',
        action: {
          type: 'message',
          label: label.slice(0, 20),
          text: label,
        },
      })),
    };
  }

  return msg;
}

// ===== Webhookエンドポイント =====
app.post('/webhook',
  line.middleware(lineConfig),
  async (req, res) => {
    res.sendStatus(200);

    const events = req.body.events;
    for (const event of events) {

      const userId     = event.source.userId;
      const eventId    = event.webhookEventId;
      const replyToken = event.replyToken;

      // 【最優先】スタンプ → AI復帰
      if (event.type === 'message' && event.message.type === 'sticker') {
        aiOn(userId);
        saveEventId(eventId);
        await client.replyMessage(replyToken, {
          type: 'text',
          text: '🤖 AIキキが復帰しました！',
        });
        continue;
      }

      if (event.type !== 'message' || event.message.type !== 'text') continue;

      const userMessage = event.message.text;

      // 【最優先】テキストコマンド
      if (userMessage === '/ai-off') {
        aiOff(userId);
        saveEventId(eventId);
        await client.replyMessage(replyToken, {
          type: 'text',
          text: '🔕 AIをオフにしました。スタッフ対応モードです。',
        });
        continue;
      }
      if (userMessage === '/ai-on') {
        aiOn(userId);
        saveEventId(eventId);
        await client.replyMessage(replyToken, {
          type: 'text',
          text: '🤖 AIキキが復帰しました！',
        });
        continue;
      }

      // 通常ユーザーメッセージ処理
      const user = getUser(userId);

      if (user.mode === 'staff') {
        const expired = Date.now() - user.staffSince > STAFF_TIMEOUT_MS;
        if (!expired) {
          console.log(`[${userId}] スタッフモード中のためスキップ`);
          continue;
        }
        user.mode = 'bot';
        user.staffSince = null;
        console.log(`[${userId}] スタッフモードがタイムアウト解除 → bot復帰`);
      }

      if (processingUsers.has(userId)) {
        console.log(`[${userId}] 処理中のためスキップ: ${eventId}`);
        continue;
      }

      processingUsers.add(userId);

      try {
        if (isProcessed(eventId)) {
          console.log(`[${userId}] 重複イベントをスキップ: ${eventId}`);
          continue;
        }

        saveEventId(eventId);
        await showLoadingAnimation(userId, 30);

        if (isStaffRequest(userMessage)) {
          const handoffText = await handoffToStaff(userId);
          user.lastBotReply = Date.now();
          await client.replyMessage(replyToken, {
            type: 'text',
            text: handoffText,
          });
          console.log(`[${userId}] スタッフモードに移行（ユーザー要求）`);
          continue;
        }

        // 再生産・追加注文キーワード → Geminiに処理させてautoHandoffで引き継ぎ
        // （プロンプトに再生産対応フローが含まれているのでそのままaskGeminiに流す）
        if (isReorderRequest(userMessage)) {
          // needsSiteInfo/needsProductInfoに関わらず両方注入して確実に対応
          console.log(`[${userId}] 再生産・追加注文リクエスト検知`);
        }

        const parsed = await askGemini(userId, userMessage);

        // autoHandoff: true → スタッフへ自動引き継ぎ
        if (parsed.autoHandoff === true) {
          aiOff(userId);
          user.lastBotReply = Date.now();
          await client.replyMessage(replyToken, buildMessage(parsed));
          console.log(`[${userId}] 自動引き継ぎ（ステップ3/4完了）`);
        } else {
          await client.replyMessage(replyToken, buildMessage(parsed));
          user.lastBotReply = Date.now();
        }

      } catch (err) {
        console.error('エラー:', err);
        try {
          await client.replyMessage(replyToken, {
            type: 'text',
            text: '申し訳ありません、少し時間をおいて再度お試しください🙏',
          });
        } catch (replyErr) {
          console.error('エラー返信失敗:', replyErr.message);
        }
      } finally {
        processingUsers.delete(userId);
      }
    }
  }
);

// ===== Shopifyテスト =====
app.get('/test-shopify', async (req, res) => {
  try {
    const response = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=3`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
    );
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ===== デバッグ：Geminiに渡している商品情報を確認 =====
app.get('/debug-products', async (req, res) => {
  try {
    // キャッシュを強制リセットして最新を取得
    cachedProducts = null;
    productsCacheUpdatedAt = 0;
    const info = await getProductInfo();
    res.type('text/plain; charset=utf-8').send(info || '（商品情報なし）');
  } catch (e) {
    res.status(500).send(`エラー: ${e.message}`);
  }
});

// ===== ヘルスチェック =====
app.get('/health', (req, res) => {
  res.sendStatus(200);
});

// ===== サーバー起動 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバー起動中: port ${PORT}`);
});
