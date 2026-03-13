const express = require('express');
const line = require('@line/bot-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

// ===== 設定 =====
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(lineConfig);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ===== システムプロンプト（ここを編集してボットの人格を変える） =====
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
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });

  // 会話履歴を取得（なければ初期化）
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId);

  // チャットセッション開始
  const chat = model.startChat({
    history: history,
    systemInstruction: {
      role: 'user',
      parts: [{ text: SYSTEM_PROMPT }],
    },
  });

  // 返答を取得
  const result = await chat.sendMessage(userMessage);
  const reply = result.response.text();

  // 履歴に追加（直近10件だけ保持）
  history.push({ role: 'user', parts: [{ text: userMessage }] });
  history.push({ role: 'model', parts: [{ text: reply }] });
  if (history.length > 20) history.splice(0, 2);

  return reply;
}

// ===== Webhookエンドポイント =====
app.post('/webhook',
  line.middleware(lineConfig),
  async (req, res) => {
    res.sendStatus(200); // LINEにすぐ200を返す

    const events = req.body.events;
    for (const event of events) {
      if (event.type !== 'message' || event.message.type !== 'text') continue;

      const userId = event.source.userId;
      const userMessage = event.message.text;

      try {
        // 手動モードのユーザーはスキップ（後で実装）
        // const isManual = await checkManualMode(userId);
        // if (isManual) continue;

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
