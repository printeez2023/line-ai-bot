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

// ===== HPスクレイピング =====
let cachedSiteInfo = null;
let cacheUpdatedAt = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1時間

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

async function fetchProductList(url) {
  const res = await fetch(url);
  const html = await res.text();

  const items = [];
  const blocks = html.split(/(?=<h3)/);
  for (const block of blocks) {
    const nameMatch = block.match(/href="(\/products\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const priceMatch = block.match(/¥([\d,]+)/);
    if (nameMatch && priceMatch) {
      const name = nameMatch[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const price = priceMatch[1];
      const path = nameMatch[1];
      if (name && price && name.length > 3) {
        items.push(`・${name} ¥${price} https://printeez.jp${path}`);
      }
    }
  }

  const unique = [...new Set(items)];
  return unique.join('\n').slice(0, 6000);
}

async function getSiteInfo() {
  const now = Date.now();
  if (cachedSiteInfo && now - cacheUpdatedAt < CACHE_TTL) {
    return cachedSiteInfo;
  }
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

// ===== 商品情報スクレイピング =====
let cachedProducts = null;
let productsCacheUpdatedAt = 0;
const PRODUCTS_CACHE_TTL = 60 * 60 * 1000;

const PRODUCT_PAGES = [
  { url: 'https://printeez.jp/collections/t-shirts',      label: 'Tシャツ' },
  { url: 'https://printeez.jp/collections/sweat',         label: 'スウェット' },
  { url: 'https://printeez.jp/collections/hoody-sweat',   label: 'パーカー' },
  { url: 'https://printeez.jp/collections/long-t-shirts', label: 'ロンT' },
  { url: 'https://printeez.jp/collections/polo-shirts',   label: 'ドライ/ポロシャツ' },
  { url: 'https://printeez.jp/collections/cap-hat',       label: 'キャップ/ハット' },
  { url: 'https://printeez.jp/collections/bag-totebag',   label: 'バッグ/トートバッグ' },
];

async function getProductInfo() {
  const now = Date.now();
  if (cachedProducts && now - productsCacheUpdatedAt < PRODUCTS_CACHE_TTL) {
    return cachedProducts;
  }
  console.log('HPから商品情報を取得中...');
  let result = '';
  for (const page of PRODUCT_PAGES) {
    try {
      const text = await fetchProductList(page.url);
      result += `\n=== ${page.label}（${page.url}）===\n${text}\n`;
    } catch (e) {
      console.error(`商品取得失敗: ${page.url}`, e.message);
    }
  }
  cachedProducts = result;
  productsCacheUpdatedAt = now;
  return result;
}

const PRODUCT_KEYWORDS = [
  'おすすめ', 'お勧め', 'どれ', 'どんな', '商品', 'ボディ', 'Tシャツ', 'パーカー',
  'トレーナー', 'ポロシャツ', 'タンクトップ', 'キャップ', 'バッグ', 'トートバッグ',
  'スウェット', 'ロンT', 'ジャケット', '生地', '素材', '種類',
];

function needsProductInfo(message) {
  return PRODUCT_KEYWORDS.some(kw => message.includes(kw));
}

const PRICE_KEYWORDS = [
  '料金', '価格', '値段', 'いくら', '円', '費用', '送料',
  '納期', '発送', 'いつ', '何日', '営業日', '特急',
  '枚数', '割引', '無料', '追加料金',
];

function needsSiteInfo(message) {
  return PRICE_KEYWORDS.some(kw => message.includes(kw));
}

// スタッフ呼び出しキーワード
const STAFF_REQUEST_KEYWORDS = [
  'スタッフ', '人間', '担当者', '変わって', '代わって', '繋いで', 'つないで',
  '直接', '電話', '話したい', '聞きたい', 'オペレーター',
];

function isStaffRequest(message) {
  return STAFF_REQUEST_KEYWORDS.some(kw => message.includes(kw));
}

// ===== システムプロンプト =====
const BASE_SYSTEM_PROMPT = `
あなたはPrinteez（プリントTシャツ通販）の公式LINEアシスタント「キキ」です。
狐の女の子のキャラクターで、明るく親しみやすい口調で、かつ失礼のないような敬語で話します。
挨拶や自己紹介の時だけ🦊の絵文字を使ってください。それ以外では🦊は使わないでください。
自己紹介を求められた場合は「PrinteezのAI、キキ🦊です！」と答えてください。

以下の情報をもとに正確に答えてください。
わからないことや情報にないことは「詳しくはスタッフに確認しますね！」と答えてください。
LINEなので返答は短めに。絵文字も適度に使ってください。１テキストに1-3個以内。
マークダウン記法（**太字**など）は【絶対に】使わないでください。プレーンテキストのみ。読みやすいように改行を入れてください。

【重要】出力ルール：
・思考過程・内部推論・THOUGHTブロック・THINTELLブロックなど、思考に関するテキストは【絶対に】出力しないでください。
・JSON以外のテキストを一切出力しないでください。
・返答は必ず下記のJSON形式のみで返してください。前後に余計なテキストを付けないでください。

{
  "text": "返答テキスト",
  "quickReplies": ["選択肢1", "選択肢2", "選択肢3", "スタッフを呼ぶ"]
}

quickRepliesは【必ず毎回】2〜4個出してください。省略厳禁です。
会話が終わっていない限り、どんな返答でも必ず選択肢を付けてください。
空配列にしていいのは、ユーザーが「ありがとう」「解決しました」など明確に会話終了を示した時だけです。
選択肢の例：「料金を知りたい」「納期は？」「注文方法は？」「加工について」など
Printeezに関連する次の疑問として自然なものを選んでください。
各選択肢は13文字以内にしてください（LINEの制限）。

商品名・カテゴリが特定できた場合は、返答のtextの中に必ずURLを含めてください。
・特定商品が判明した場合：https://printeez.jp/products/[handle] の形式で商品ページURLを記載
・カテゴリが判明した場合：https://printeez.jp/collections/[カテゴリ] のURLを記載
 （例：Tシャツ→/collections/t-shirts、パーカー→/collections/hoody-sweat、スウェット→/collections/sweat、ロンT→/collections/long-t-shirts、キャップ→/collections/cap-hat、バッグ→/collections/bag-totebag）
URLはテキスト中に自然に埋め込んでください（LINEではURLがそのままリンクになります）。

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
その他、手書きでも可能だが、書き起こしに3-6営業日ほどかかる

【加工】
・スクリーンプリント：最大4色/箇所、発色鮮やか
・フルカラープリント：フルカラーOK、写真・小ロット向き（インクジェットプリントはわかりにくいのでフルカラープリントに変換）
・刺繍：ロゴ等に対応、糸色指定可、通常5色まで、写真や1mm以下の細かい部分が含まれるデザインは対応不可。
・生地両面の位置合わせプリント：不可
・袖や、ポケット上なども可能だがスタッフによるデザイン確認必要
・持ち込みタグの縫い付けも可能
・袋詰めも可能

【その他】
・1枚から注文OK
・直接受け取り不可（配送のみ）
・電話対応不可
・領収書：アカウント画面のご注文詳細からダウンロード
・大口注文（数百〜数千枚）：contact@printeez.jp へ

=== Printeez 定番商品・おすすめ商品 ===

商品について聞かれたら下記の商品とリンクを伝えてください。
定番やおすすめを聞かれたら必ず答えてください。
その他のジャンルは商品ページを見て適当なものをおすすめしてください。

【定番Tシャツ】
・United Athle 5.6oz ハイクオリティTシャツ（UA-5001）
  よれない・透けない・長持ちの代表的定番Tシャツ
  https://printeez.jp/products/ua-5001-01

・United Athle 6.2oz プレミアムTシャツ（5942-01）
  5001より厚手・高品質。アパレル物販でよく採用
  https://printeez.jp/products/5942-01

・Printstar 5.6oz ヘビーウェイトTシャツ（00085-CVT）
  プリント業界で最も定番の綿100%Tシャツ
  https://printeez.jp/products/00085-cvt

・Printstar 7.4oz スーパーヘビーTシャツ（00148-HVT）
  7.4ozの厚手綿100%ヘビーウェイトTシャツ
  https://printeez.jp/products/00148-hvt

・D-FACTORY 6.6oz プレミアムコンフォートTシャツ（DF-1101）
  透けにくくプリント適性の高い厚手ベーシックTシャツ
  https://printeez.jp/products/df-1101

・D-FACTORY 6.6oz プレミアムガーメントダイTシャツ（DF-1101D）
  ピグメント染めでヴィンテージ感のある風合いのTシャツ
  https://printeez.jp/products/df-1101d

【定番ロングスリーブTシャツ】
・United Athle 5.6oz ロングスリーブTシャツ（5011-01）
  5001と同生地・袖リブ付きの定番ロンT
  https://printeez.jp/products/5011-01

・United Athle 6.2oz プレミアムロングスリーブTシャツ（5913-01）
  6.2oz厚手・太めリブでストリート感のあるプレミアムロンT
  https://printeez.jp/products/5913-01

・Printstar 5.6oz ヘビーウェイトLS-Tシャツ（00110-CLL）
  5.6oz綿100%・袖リブ付きの定番ロンT
  https://printeez.jp/products/00110-cll

・Printstar 7.4oz スーパーヘビー長袖Tシャツ（00149-HVL）
  7.4oz肉厚生地・袖リブ仕様の耐久性重視ロンT
  https://printeez.jp/products/00149-hvl

・D-FACTORY 6.6oz プレミアムコンフォートロングスリーブTシャツ（DF-1102）
  6.6oz厚手の透けにくいベーシック長袖Tシャツ
  https://printeez.jp/products/df-1102

・D-FACTORY 6.6oz プレミアムコンフォートロングスリーブTシャツ リブ付き（DF-1103）
  6.6oz厚手・袖リブ付きのストリート系長袖Tシャツ
  https://printeez.jp/products/df-1103

【定番クルーネックスウェット】
・United Athle 10.0oz クルーネックスウェットシャツ（5044-01）
  10.0oz裏パイル・ダブルステッチの定番クルーネック
  https://printeez.jp/products/5044-01

・D-FACTORY 10.0oz プレミアムコンフォートクルーネックスウェット（DF-1001）
  10.0oz度詰め裏毛・型崩れしにくいヘビーウェイトクルーネック
  https://printeez.jp/products/df-1001

・CROSS & STITCH 10.0oz レギュラーウェイトクルーネックスウェット（CS2210）
  10.0oz裏パイル・スタンダードシルエットのベーシックスウェット
  https://printeez.jp/products/cs2210

【定番パーカー】
・United Athle 10.0oz スウェットプルオーバーパーカー（5214-01）
  10.0oz裏パイル・二重フードの定番プルオーバーパーカー
  https://printeez.jp/products/5214-01

・D-FACTORY 12oz プラチナプルオーバーパーカー（DF-1407）
  12oz厚手・ベロア調裏地で保温性と高級感のあるパーカー
  https://printeez.jp/products/df-1407

・CROSS & STITCH 10.0oz レギュラーウェイトスウェットP/Oパーカー（SP2252）
  10.0oz裏パイル・ベーシックシルエットの定番プルオーバーパーカー
  https://printeez.jp/products/sp2252

【定番キャップ・ハット】
・NEWHATTAN コットンウォッシュドキャップ（NH-1400）
  https://printeez.jp/products/nh-1400

・FLEXFIT カフドニットビーニー（FL-1501KC）
  https://printeez.jp/products/fl-1501kc

・United Athle コットンツイルバケットハット（UA-967501）
  https://printeez.jp/products/ua-967501
`;

// ===== 会話履歴 & スタッフ対応管理 =====
const conversationHistory = new Map();

// staffHandling: Map<userId, { since: timestamp }>
const staffHandling = new Map();
const STAFF_TIMEOUT_MS = 60 * 60 * 1000; // 1時間でタイムアウト

function isStaffMode(userId) {
  const state = staffHandling.get(userId);
  if (!state) return false;
  const expired = Date.now() - state.since > STAFF_TIMEOUT_MS;
  if (expired) {
    staffHandling.delete(userId);
    console.log(`[${userId}] スタッフモードがタイムアウトで解除されました`);
    return false;
  }
  return true;
}

// ===== 会話要約を生成してスタッフモードへ移行 =====
async function handoffToStaff(userId, history) {
  // 会話履歴をテキスト化
  const historyText = history
    .map(h => `${h.role === 'user' ? 'お客様' : 'キキ'}: ${h.parts[0].text}`)
    .join('\n');

  // Geminiで要約生成
  let summary = '（要約取得失敗）';
  try {
    const res = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: `以下の会話を2〜3行で要約してください。スタッフへの引き継ぎメモとして使います。敬語不要、箇条書きOK。\n\n${historyText}` }] }],
    });
    summary = res.text.trim().slice(0, 200);
  } catch (e) {
    console.error('要約生成エラー:', e.message);
  }

  // スタッフモードをオン
  staffHandling.set(userId, { since: Date.now() });

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
      systemPrompt += `\n=== 取扱商品情報（HP最新）===\n${productInfo}`;
      console.log(`[${userId}] 商品情報を注入`);
    } catch (e) {
      console.error('商品取得エラー:', e.message);
    }
  }

  history.push({ role: 'user', parts: [{ text: userMessage }] });

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: history,
    config: { systemInstruction: systemPrompt },
  });

  const rawText = response.text.trim();

  // 思考ブロック（THOUGHT / THINTELL など）を除去してからJSONパース
  const cleaned = rawText
    .replace(/^[\s\S]*?(THOUGHT|THINTELL|THINK|THINKING|内部推論|思考)[\s\S]*?(?=\{)/i, '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim();

  let parsed = { text: cleaned, quickReplies: [] };
  try {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error('JSONパース失敗:', e.message);
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
      if (event.type !== 'message' || event.message.type !== 'text') continue;

      const userId = event.source.userId;
      const userMessage = event.message.text;

      // ===== スタッフコマンド（手動操作用）=====
      if (userMessage === '/ai-off') {
        staffHandling.set(userId, { since: Date.now() });
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '🔕 AIをオフにしました。スタッフ対応モードです。',
        });
        continue;
      }
      if (userMessage === '/ai-on') {
        staffHandling.delete(userId);
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '🤖 AIキキが復帰しました！',
        });
        continue;
      }

      // ===== スタッフモード確認（タイムアウト自動解除あり）=====
      if (isStaffMode(userId)) continue;

      try {
        await showLoadingAnimation(userId, 30);

        // ===== ユーザーがスタッフ呼び出しを要求した場合 =====
        if (isStaffRequest(userMessage)) {
          const history = conversationHistory.get(userId) || [];
          const handoffText = await handoffToStaff(userId, history);
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: handoffText,
          });
          console.log(`[${userId}] スタッフモードに移行（ユーザー要求）`);
          continue;
        }

        // ===== 通常AI応答 =====
        const parsed = await askGemini(userId, userMessage);
        await client.replyMessage(event.replyToken, buildMessage(parsed));

      } catch (err) {
        console.error('エラー:', err);
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '申し訳ありません、少し時間をおいて再度お試しください🙏',
        });
      }
    }
  }
);

// ===== ヘルスチェック =====
app.get('/health', (req, res) => {
  res.sendStatus(200);
});

// ===== サーバー起動 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバー起動中: port ${PORT}`);
});
