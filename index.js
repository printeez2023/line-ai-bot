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
const PRODUCTS_CACHE_TTL = 60 * 60 * 1000; // 1時間

const PRODUCT_PAGES = [
  { url: 'https://printeez.jp/collections/t-shirts',     label: 'Tシャツ' },
  { url: 'https://printeez.jp/collections/sweat',        label: 'スウェット' },
  { url: 'https://printeez.jp/collections/hoody-sweat',  label: 'パーカー' },
  { url: 'https://printeez.jp/collections/long-t-shirts',label: 'ロンT' },
  { url: 'https://printeez.jp/collections/polo-shirts',  label: 'ドライ/ポロシャツ' },
  { url: 'https://printeez.jp/collections/cap-hat',      label: 'キャップ/ハット' },
  { url: 'https://printeez.jp/collections/bag-totebag',  label: 'バッグ/トートバッグ' },
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
      const text = await fetchPageText(page.url);
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

// ===== システムプロンプト =====
const BASE_SYSTEM_PROMPT = `
あなたはPrinteez（プリントTシャツ通販）の公式LINEアシスタント「キキ」です。
狐の女の子のキャラクターで、明るく親しみやすい口調で話します。
挨拶や自己紹介の時だけ🦊の絵文字を使ってください。それ以外では🦊は使わないでください。
自己紹介を求められた場合は「PrinteezのAI、キキ🦊です！」と答えてください。

以下の情報をもとに正確に答えてください。
わからないことや情報にないことは「詳しくはスタッフに確認しますね！」と答えてください。
LINEなので返答は短めに。絵文字も適度に使ってください。１テキストに1-3個以内。
マークダウン記法（**太字**、番号リストなど）は使わないでください。プレーンテキストのみ。

返答は必ず以下のJSON形式で返してください。他のテキストは一切含めないでください。
{
  "text": "返答テキスト",
  "quickReplies": ["選択肢1", "選択肢2", "選択肢3"]
}

quickRepliesは会話の流れに合わせて2〜4個の次の質問候補を提案してください。
各選択肢は13文字以内にしてください（LINEの制限）。
明らかに会話が終了している場合（お礼・解決済みなど）はquickRepliesを空配列にしてください。

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
・フルカラープリント：フルカラーOK、写真・小ロット向き（インクジェットプリントはわかりにくいのでフルカラー
プリントに変換）
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
`;


// ===== 会話履歴 =====
const conversationHistory = new Map();

// ===== Geminiに問い合わせる関数 =====
async function askGemini(userId, userMessage) {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId);

  let systemPrompt = BASE_SYSTEM_PROMPT;
  if (needsSiteInfo(userMessage) || needsProductInfo(userMessage)) {
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

  // JSONパース（失敗時はtextのみで返す）
  let parsed = { text: rawText, quickReplies: [] };
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
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
    text: parsed.text,
  };

  // AIフッターを追加
  msg.text = msg.text + '\n\n※ AIキキが返答しています';

  // クイックリプライがある場合は追加
  if (parsed.quickReplies && parsed.quickReplies.length > 0) {
    msg.quickReply = {
      items: parsed.quickReplies.map(label => ({
        type: 'action',
        action: {
          type: 'message',
          label: label.slice(0, 20), // 念のため20文字でカット
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

      try {
        
          // 通常の質問：ローディング表示 → reply「回答＋クイックリプライ」
          await client.showLoadingAnimation(userId, { loadingSeconds: 30 });
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
