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
// 価格・納期情報をキャッシュ（1時間ごとに更新）
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
    .slice(0, 4000); // トークン節約のため4000文字まで
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

// 価格・納期に関係するキーワード
const PRICE_KEYWORDS = [
  '料金', '価格', '値段', 'いくら', '円', '費用', '送料',
  '納期', '発送', 'いつ', '何日', '営業日', '特急',
  '枚数', '割引', '無料', '追加料金',
];

function needsSiteInfo(message) {
  return PRICE_KEYWORDS.some(kw => message.includes(kw));
}

// ===== システムプロンプト（固定知識） =====
const BASE_SYSTEM_PROMPT = `
あなたはPrinteez（プリントTシャツ通販）の公式LINEアシスタント「キキ」です。
狐の女の子のキャラクターで、明るく親しみやすい口調で話します。
挨拶や自己紹介の時だけ🦊の絵文字を使ってください。それ以外では🦊は使わないでください。
自己紹介を求められた場合は「PrinteezのAI、キキ🦊です！」と答えてください。

以下の情報をもとに正確に答えてください。
わからないことや情報にないことは「詳しくはスタッフに確認しますね！」と答えてください。
LINEなので返答は短めに。絵文字も控えめに使ってください。最低1個ぐらい。
マークダウン記法（**太字**、番号リストなど）は使わないでください。プレーンテキストのみ。

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
製作開始後のキャンセル不可。決済前はキャンセル可能。

【データ形式】
AI・PSD・PNG・JPEGなどに対応。

【プリント】
・スクリーンプリント：最大4色/箇所、発色鮮やか
・フルカラープリント：フルカラーOK、写真や小ロット向き
・刺繍：ロゴ等に対応、糸色指定可 5色まで追加料金なし
・生地両面の位置合わせプリント：不可

【その他】
・1枚から注文OK
・直接受け取り不可（配送のみ）
・領収書：アカウント画面のご注文詳細からダウンロード
・大口注文（50〜数千枚）：contact@printeez.jp へ
`;

// ===== 会話履歴（ユーザーごとに保持） =====
const conversationHistory = new Map();

// ===== Geminiに問い合わせる関数 =====
async function askGemini(userId, userMessage) {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId);

  // 価格・納期が関係する質問ならHPを取得してプロンプトに追加
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

  history.push({ role: 'user', parts: [{ text: userMessage }] });

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: history,
    config: {
      systemInstruction: systemPrompt,
    },
  });

  const reply = response.text;

  history.push({ role: 'model', parts: [{ text: reply }] });
  if (history.length > 20) history.splice(0, 2);

  return reply;
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
        const reply = await askGemini(userId, userMessage);

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: reply,
        });

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

// ===== サーバー起動 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバー起動中: port ${PORT}`);
});
