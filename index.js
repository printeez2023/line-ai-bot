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

// ===== システムプロンプト =====
const SYSTEM_PROMPT = `
あなたはPrinteez（プリントTシャツ通販）の公式LINEアシスタントです。
以下のことを丁寧かつ簡潔に答えてください。

- 商品・アイテムの案内（Tシャツ、パーカー、キャップなど）
- プリント方法の説明（スクリーンプリント、インクジェット、刺繍）
- 料金・納期の目安
- 注文方法・データ入稿の案内
- よくある質問への回答

LINEでのやり取りなので、返答は短めに、絵文字も適度に使ってください。
わからないことは「担当スタッフに確認します」と答えてください。
`;

// ===== 会話履歴（ユーザーごとに保持） =====
const conversationHistory = new Map();

// ===== Geminiに問い合わせる関数 =====
async function askGemini(userId, userMessage) {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId);

  history.push({ role: 'user', parts: [{ text: userMessage }] });

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: history,
    config: {
      systemInstruction: SYSTEM_PROMPT,
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
