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
const SHOPIFY_API_VERSION  = '2025-01';

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
    users.set(userId, { mode: 'bot', staffSince: null, lastBotReply: null, pendingHandoff: false });
  }
  return users.get(userId);
}
function aiOn(userId) {
  const user = getUser(userId);
  user.mode = 'bot';
  user.staffSince = null;
  user.pendingHandoff = false;
  processingUsers.delete(userId);
  console.log(`[${userId}] AI復帰`);
}
function aiOff(userId) {
  const user = getUser(userId);
  user.mode = 'staff';
  user.staffSince = Date.now();
  user.pendingHandoff = false;
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
let cachedProductImages = new Map();
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
  // どちらにも見つからない場合、レスポンス内容をログに出して原因を特定しやすくする
  console.warn(`コレクション未発見: handle="${handle}" / custom=${JSON.stringify(data)} / smart=${JSON.stringify(data2)}`);
  return null;
}

async function fetchProductsByCollectionId(collectionId) {
  const products = [];
  let url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products.json?collection_id=${collectionId}&limit=250&published_status=published&fields=id,title,handle,body_html,variants`;

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

// 商品のメタフィールド画像URLをGraphQL referenceで直接取得
async function fetchProductMetafields(productId) {
  try {
    const gid = `gid://shopify/Product/${productId}`;
    const query = `{
      product(id: "${gid}") {
        colorChart: metafield(namespace: "custom", key: "color_chart_image") {
          reference {
            ... on MediaImage {
              image { url }
            }
          }
        }
        sizeChart: metafield(namespace: "custom", key: "size_chart_image") {
          reference {
            ... on MediaImage {
              image { url }
            }
          }
        }
      }
    }`;

    const res = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();

    if (data.errors) {
      console.error(`GraphQLエラー(${productId}):`, JSON.stringify(data.errors));
      return { colorUrl: null, sizeUrl: null };
    }

    const product = data?.data?.product;
    const colorUrl = product?.colorChart?.reference?.image?.url || null;
    const sizeUrl  = product?.sizeChart?.reference?.image?.url  || null;

    if (colorUrl || sizeUrl) {
      console.log(`[メタフィールド取得成功] ${productId} color=${colorUrl} size=${sizeUrl}`);
    }

    return { colorUrl, sizeUrl };
  } catch (e) {
    console.error(`メタフィールド取得失敗: ${productId}`, e.message);
    return { colorUrl: null, sizeUrl: null };
  }
}

// resolveFileUrl は不要になったため削除（後方互換のためスタブのみ残す）
async function resolveFileUrl(value) {
  return value?.startsWith('https://') ? value : null;
}

function hasAvailableStock(variants) {
  if (!variants || variants.length === 0) return false;
  return variants.some(v => {
    if (v.inventory_management === null || v.inventory_management === undefined) return true;
    if (v.inventory_policy === 'continue') return true;
    return v.inventory_quantity > 0;
  });
}

async function getProductInfo() {
  const now = Date.now();
  if (cachedProducts && now - productsCacheUpdatedAt < PRODUCTS_CACHE_TTL) {
    return cachedProducts;
  }
  console.log('Shopify APIから商品情報を取得中...');

  let result = '';
  const newImageMap = new Map();

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
        if (!hasAvailableStock(p.variants)) {
          console.log(`[在庫なし除外] ${p.title}`);
          continue;
        }

        const prices = (p.variants || []).map(v => parseFloat(v.price)).filter(n => !isNaN(n));
        const minPrice = prices.length > 0 ? Math.min(...prices) : null;
        const priceStr = minPrice !== null ? `¥${minPrice.toLocaleString()}〜` : '価格不明';

        const desc    = stripHtml(p.body_html);
        const pageUrl = `https://printeez.jp/products/${p.handle}`;

        const { colorUrl, sizeUrl } = await fetchProductMetafields(p.id);
        if (colorUrl || sizeUrl) {
          newImageMap.set(p.handle, { colorUrl, sizeUrl });
        }

        result += `・${p.title}\n`;
        result += `  価格：${priceStr}\n`;
        result += `  説明：${desc}\n`;
        result += `  URL：${pageUrl}\n`;
        if (colorUrl) result += `  カラー表画像あり：handle=${p.handle}\n`;
        if (sizeUrl)  result += `  サイズチャート画像あり：handle=${p.handle}\n`;
        result += '\n';
      }
    } catch (e) {
      console.error(`商品取得失敗: ${col.handle}`, e.message);
    }
  }

  cachedProducts = result;
  cachedProductImages = newImageMap;
  productsCacheUpdatedAt = now;
  return result;
}

// ===== キーワード判定 =====

const PRODUCT_KEYWORDS = [
  'おすすめ', 'お勧め', 'どれ', 'どんな', '商品', 'ボディ',
  'Tシャツ', 'パーカー', 'トレーナー', 'ポロシャツ', 'タンクトップ',
  'キャップ', 'バッグ', 'トートバッグ', 'スウェット', 'ロンT',
  'ジャケット', '生地', '素材', '種類',
  '値段', '価格', 'いくら', '円', '安い', '高い',
];
function needsProductInfo(message) {
  return PRODUCT_KEYWORDS.some(kw => message.includes(kw));
}

const SITE_KEYWORDS = [
  '料金', '送料', '納期', '発送', 'いつ', '何日', '営業日', '特急',
  '枚数', '割引', '無料', '追加料金', '費用',
  '合計', '総額', '計算', '見積', 'トータル', '全部で', 'いくらになる',
  'プリント', 'スクリーン', 'フルカラー', '刺繍', '加工',
  '注文する', '注文したい', '注文方法', 'お願いしたい', '頼みたい', '申し込み',
];
function needsSiteInfo(message) {
  return SITE_KEYWORDS.some(kw => message.includes(kw));
}

const STAFF_REQUEST_KEYWORDS = [
  'スタッフ', '人間', '担当者', '変わって', '代わって', '繋いで', 'つないで',
  '直接', '話したい', 'オペレーター',
];

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

autoHandoffはステップ4が完了したと判断したときだけtrueにしてください。それ以外はfalseです。

quickRepliesは【必ず毎回】2〜4個出してください。省略厳禁です。
空配列にしていいのは、ユーザーが「ありがとう」「解決しました」など明確に会話終了を示した時だけです。
各選択肢は13文字以内にしてください（LINEの制限）。
スタッフへの引き継ぎ選択肢は必ず「スタッフを呼ぶ」という文言にしてください。
AIキキへの復帰選択肢は必ず「キキを呼ぶ」という文言にしてください。

=== あなたの仕事 ===

【役割】
・お客様の質問に答えること
・お客様の注文をステップ0～ステップ４までアシストすること
・ステップ4が完了したらスタッフへ引き継ぐこと
・見積を算出して教えること（見積時はAI見積と伝えること）
・何かあればスタッフに引き継ぐので安心してもらうこと

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
  → この情報が揃ったら見積もりを計算する（autoHandoffはまだtrueにしない）
  → 見積もりを伝えたらステップ4へ

ステップ4（デザイン入稿案内）：
  ステップ3が完了したら、以下の入稿案内を必ず伝えてください：
  「デザインデータの入稿方法についてご案内します！
PDF・AI・PSDファイルはこのLINEから直接お送りいただけます。
画像ファイル（JPG・PNG等）は画質が低下するため、以下からアップロードをお願いします。

📧 MAIL：contact@printeez.jp
🔗 HP：https://printeez.jp/products/ファイルアップロード用ページ」
  その後、クイックリプライで「入稿完了」「入稿できない」「スタッフを呼ぶ」を出してください。
  → ユーザーが画像やファイル（PDF/PNG/AI/PSD/JPG等）をLINEに直接送ってきた場合も入稿とみなす
  → 「入稿完了」が選ばれた・画像やファイルが送られてきた・「スタッフを呼ぶ」が選ばれた場合：
     autoHandoff: true を返す（引き継ぎはシステム側でご不明点確認を挟む）
  → 「入稿できない」が選ばれたらMAILまたはHPのURLを再案内する

【再生産・追加注文の対応】
「再生産」「追加注文」「追加生産」「また頼みたい」などのキーワードが来たら以下を返してください：
「ご連絡いただきありがとうございます！
まずはご注文履歴を確認いたしますので少々お待ちください😊

以下の情報がお分かりであればお知らせください：
・2300から始まるご注文番号
・当時の受け取り先住所・受取名・メールアドレス

ご返信いただき次第、スタッフへお繋ぎします！」
その後 autoHandoff: true にしてスタッフへ引き継いでください。

【自動引き継ぎのタイミング】
ステップ4が完了したら autoHandoff: true にしてください。
（ステップ3完了時点ではautoHandoffをtrueにしないこと）

引き継ぎ前に必ず以下を返答に含めてください：
「内容を確認します！
商品：〇〇
加工：〇〇
数量：〇〇
AI見積：〇〇
スタッフにお繋ぎしますね😊」

=== 最初のメッセージについて ===

ユーザーが最初にメッセージを送ってきたとき（会話履歴が1件目）は、
必ず以下の内容を含めた自己紹介をしてください：
・AIアシスタント「キキ」であること
・できること（質問への回答・商品選びからご入稿までのアシスト）
・ご入稿完了以降はスタッフが対応すること
・「よろしければこのままご案内します！」という一言
そしてデザインの有無を聞いてください。

=== カラー表・サイズチャート画像の送信 ===

商品情報に「カラー表画像あり：handle=〇〇」と記載がある商品が確定したら、
必ずJSONの imageActions フィールドに以下を含めてください：

{
  "text": "返答テキスト",
  "quickReplies": [...],
  "autoHandoff": false,
  "imageActions": [
    { "type": "color", "handle": "商品のhandle名" },
    { "type": "size",  "handle": "商品のhandle名" }
  ]
}

imageActionsはシステムが画像を自動送信するためのトリガーです。
カラー表とサイズチャートは【同時に】送信します（ステップ1の商品確定直後）。
カラー表画像あり・サイズチャート画像あり、両方ある場合は両方をimageActionsに含めてください。
どちらか一方しかない場合は、あるもののみ含めてください。
画像がない商品はimageActionsを省略またはnullにしてください。

=== 価格・料金計算 ===

【金額の表記ルール】
・金額は必ず「〇〇円」と言い切ってください。「〇〇円〜」「〇〇円から」などの表記は使わないでください。
・単価は「¥」ではなく「円」を使ってください。例：1,500円
・計算に使った単価が商品情報の最安値であるなど、実際の金額と異なる可能性がある場合は、金額の前に「おおよそ」をつけてください。例：おおよそ 合計 12,000円
・根拠が明確な場合（商品情報に明記されている場合など）は「おおよそ」は不要です。

商品情報が提供された場合は必ず価格をユーザーに伝えてください。
価格を聞かれたら提供された商品情報の「価格：」の行を必ず参照してください。

数量・商品・加工方法が揃ったら以下の式で合計金額を計算してください：
  単価 = 商品代金 + 加工代金
  合計 = 単価 × 枚数 + 送料（一律1,000円）
計算結果は「商品 〇〇円 ＋ 加工 〇〇円 = 単価 〇〇円 × 〇枚 ＋ 送料 1,000円 = 合計 〇〇円」の形式で示してください。
加工代金は提供された料金ページの情報を参照してください。

=== 商品URL ===

【重要】商品名・URL・価格は必ず提供された商品情報（Shopifyデータ）から参照してください。
推測・補完・生成は絶対に禁止です。
商品情報に載っていない商品名やURLを自分で作らないでください。
例：「5001」と言われても、商品情報に該当商品がなければ「商品情報を確認できませんでした」と答えてください。

商品が特定できた場合は、商品情報の「URL：」の行のURLをそのまま使用してください。
カテゴリのみ分かる場合はカテゴリURLを案内してください：
Tシャツ→https://printeez.jp/collections/t-shirts
パーカー→https://printeez.jp/collections/hoody-sweat
スウェット→https://printeez.jp/collections/sweat
ロンT→https://printeez.jp/collections/long-t-shirts
キャップ→https://printeez.jp/collections/cap-hat
バッグ→https://printeez.jp/collections/bag-totebag
ショートパンツ・ハーフパンツ→https://printeez.jp/collections/short-pants
パンツ・ロングパンツ・ボトムス→https://printeez.jp/collections/long-pants
グッズ・タグ・エプロン・ワッペンその他→https://admin.shopify.com/store/printeez-jp/collections/508239839513
ポロ・ドライ→https://printeez.jp/collections/polo-shirts

=== Printeez 基本情報 ===

【注文方法】
①商品を選ぶ → ②加工方法を選ぶ → ③シミュレーターでデザイン作成 → ④注文完了
シミュレーター未掲載の商品・加工はLINEまたはメールで問い合わせ。
見積書作成・レイアウトイメージ作成も対応。

【「注文する」「注文したい」と言われた場合】
お客様から「注文する」とだけ言われたら、
以下の流れを丁寧に説明してください：

「AIのキキ🦊です！お問い合わせありがとうございます！スタッフへの引継ぎまでサポートしますね。
まずは、ご注文の流れをご説明しますね😊

①商品を選ぶ
　→ ご希望の商品・カラー・サイズを決めます

②加工方法を選ぶ
　→ スクリーンプリント / フルカラープリント / 刺繍 からお選びください
　→この時点でキキ🦊が簡易お見積りをします

③デザインを入稿する
　→ このLINEにPDF・AI・PSDファイルを直接送るか、
　　 HPのアップロードページ・メールからお送りください

④スタッフが確認・お見積り
　→ レイアウトイメージを1〜3営業日でご用意します

⑤ご確認・お支払い
　→ 内容をご確認いただき、決済完了で製作開始です！」

その後、まだ商品・加工・数量が決まっていなければ、ステップ0からご案内を続けてください。

【納期】
HP情報から得るが、答える内容は「現在のところ、通常は〇営業日後の発送です」という趣旨で答える
数量や加工内容によって異なりますので、詳細をおしえてください

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

【商品別加工制限】

キャップ・帽子類：
・加工方法：刺繍またはフルカラープリントのみ（スクリーンプリント不可）
・加工サイズは聞かなくてよい（商品ごとに決まっているため）
  - キャップ・ハット：フロントへの加工でおおむね10cm幅以内。フロント・サイド・バックに加工可能
  - ビーニー・ニット帽：折り返し部分におおむね6cm幅以内。結構どこでも加工可能
  - バケットハット：フロント・サイド・バック・トップに加工可能

ポケット付き商品（ポロシャツ・バッグなど）：
・ポケット部分への刺繍は基本不可（刺繍枠が入らないため）
・スクリーンプリントならポケット部分も可能

特定箇所のプリントサイズ目安（商品によって異なる）：
・袖：おおむね W90×H400mm以内
・ロングパンツ・スウェットパンツ裾：おおむね W140×H400mm以内
・ジップ付き商品フロント：おおむね W135×H200mm
・フードトップ：おおむね W200×H100mm以内
・フードサイド（左右）：おおむね W180×H230mm以内
・フードのスクリーンプリント：絶対1色まで（2色以降はフルカラープリント）

撥水加工商品：
・スクリーンプリント不可
・DTFプリントまたは刺繍のみ対応

【ワッペン・タグ】
・ワッペン：10個セット販売のみ（1個販売なし）
・ワッペン縫い付け：1か所 ¥500
・タグ縫い付け：¥120
・タグの保管：最終注文から6か月有効、それ以降は破棄
・再生産時はタグNo.が必要（タグNo.はこちらから連絡）→ タグNo.を聞いてからスタッフへ引き継ぐ

【その他】
・1枚から注文OK
・直接受け取り不可（配送のみ）
・電話対応不可
・領収書：アカウント画面のご注文詳細からダウンロード
・大口注文（数百〜数千枚）：contact@printeez.jp へ
`;

// ===== 会話履歴 =====
const conversationHistory = new Map();

// ===== 会話要約 =====
async function generateSummary(userId) {
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
  return summary;
}

// ===== pre-handoff メッセージを送り、pendingHandoff 状態にする =====
async function sendPreHandoffMessage(userId, replyToken, summary, triggerType) {
  const user = getUser(userId);
  user.pendingHandoff = true;

  const baseText =
    `内容をまとめますね😊\n\n${summary}\n\n` +
    `このままスタッフに変わりますので少々お待ちください。\n` +
    `他にご不明点はございますか？`;

  await client.replyMessage(replyToken, {
    type: 'text',
    text: baseText + '\n\nbyAI🦊キキ',
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: 'ない', text: 'ない' } },
        { type: 'action', action: { type: 'message', label: 'ある', text: 'ある' } },
      ],
    },
  });
  console.log(`[${userId}] pre-handoff メッセージ送信（${triggerType}）`);
}

// ===== 実際のスタッフ引き継ぎ =====
async function executeHandoff(userId, replyToken) {
  aiOff(userId);
  await client.replyMessage(replyToken, {
    type: 'text',
    text: 'スタッフにお繋ぎします！少々お待ちください🙏',
  });
  console.log(`[${userId}] スタッフへ引き継ぎ完了`);
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

  // 503エラー時は最大3回リトライ（指数バックオフ）
  let response;
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: history,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json',
        },
      });
      break;
    } catch (e) {
      const is503 = e.message && e.message.includes('503');
      if (is503 && attempt < MAX_RETRIES) {
        const wait = attempt * 3000;
        console.warn(`[${userId}] Gemini 503 リトライ ${attempt}/${MAX_RETRIES} (${wait}ms後)`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        // 失敗確定 → historyに追加したuserMessageをロールバック
        history.pop();
        console.error(`[${userId}] Gemini呼び出し失敗（リトライ上限 or 503以外）:`, e.message);
        throw e;
      }
    }
  }

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
    parsed.text = '少し問題が発生しました。もう一度お試しください。';
  }

  history.push({ role: 'model', parts: [{ text: parsed.text }] });
  if (history.length > 20) history.splice(0, 2);

  return parsed;
}

// ===== LINEメッセージ組み立て =====
function buildTextMessage(parsed) {
  const msg = {
    type: 'text',
    text: parsed.text + '\n\nbyAI🦊キキ',
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

function buildMessage(parsed) {
  return buildTextMessage(parsed);
}

function buildMessages(parsed) {
  const messages = [];
  messages.push(buildTextMessage(parsed));

  if (parsed.imageActions && parsed.imageActions.length > 0) {
    for (const action of parsed.imageActions) {
      const imgData = cachedProductImages.get(action.handle);
      if (!imgData) continue;

      const url = action.type === 'color' ? imgData.colorUrl : imgData.sizeUrl;
      if (!url) continue;

      const label = action.type === 'color' ? 'カラーバリエーション' : 'サイズチャート';
      messages.push({ type: 'text', text: `【${label}】` });
      messages.push({
        type: 'image',
        originalContentUrl: url,
        previewImageUrl: url,
      });
    }
  }

  return messages;
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

      if (isProcessed(eventId)) {
        console.log(`[${userId}] 重複eventIdをスキップ: ${eventId}`);
        continue;
      }
      saveEventId(eventId);

      if (processingUsers.has(userId)) {
        console.log(`[${userId}] 処理中のためスキップ: ${eventId}`);
        continue;
      }
      processingUsers.add(userId);

      try {
        const user = getUser(userId);

        // ③ スタンプ → AI復帰
        if (event.type === 'message' && event.message.type === 'sticker') {
          console.log(`[${userId}] スタンプ受信 → AI復帰処理 (mode=${user.mode})`);
          aiOn(userId);
          await client.replyMessage(replyToken, {
            type: 'text',
            text: 'キキ🦊です！また会えましたね！何でもお気軽にどうぞ😊',
          });
          continue;
        }

        // ④ 画像・ファイル受信 → 入稿とみなす
        if (
          event.type === 'message' &&
          (event.message.type === 'image' || event.message.type === 'file')
        ) {
          if (user.mode === 'staff') continue;

          await showLoadingAnimation(userId, 15);

          if (user.pendingHandoff) {
            await executeHandoff(userId, replyToken);
            continue;
          }

          const summary = await generateSummary(userId);
          await sendPreHandoffMessage(userId, replyToken, summary, 'nyuukou');
          continue;
        }

        if (event.type !== 'message' || event.message.type !== 'text') continue;

        const userMessage = event.message.text;

        // ⑤ pendingHandoff 中の「ある」「ない」を処理
        if (user.pendingHandoff) {
          if (userMessage === 'ない') {
            await executeHandoff(userId, replyToken);
          } else {
            user.pendingHandoff = false;
            await showLoadingAnimation(userId, 30);
            const parsed = await askGemini(userId, userMessage);
            await client.replyMessage(replyToken, buildMessages(parsed));
            user.lastBotReply = Date.now();
          }
          continue;
        }

        // ⑥ テキストコマンド
        const isAiOff = userMessage === 'スタッフを呼ぶ' || userMessage === '/ai-off';
        const isAiOn  = userMessage === 'キキを呼ぶ'     || userMessage === '/ai-on';

        if (isAiOn) {
          aiOn(userId);
          await client.replyMessage(replyToken, {
            type: 'text',
            text: 'キキ🦊です！また会えましたね！何でもお気軽にどうぞ😊',
          });
          continue;
        }

        // ⑦ staffモード確認 & タイムアウト確認
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

        // ⑧ 「スタッフを呼ぶ」→ pre-handoff フローへ
        if (isAiOff || isStaffRequest(userMessage)) {
          await showLoadingAnimation(userId, 15);
          const summary = await generateSummary(userId);
          await sendPreHandoffMessage(userId, replyToken, summary, 'staff_request');
          user.lastBotReply = Date.now();
          console.log(`[${userId}] pre-handoff 開始（スタッフ要求）`);
          continue;
        }

        // ⑨ Gemini呼び出し & 返信
        await showLoadingAnimation(userId, 30);

        if (isReorderRequest(userMessage)) {
          console.log(`[${userId}] 再生産・追加注文リクエスト検知`);
        }

        const parsed = await askGemini(userId, userMessage);

        if (parsed.autoHandoff === true) {
          const summary = await generateSummary(userId);
          user.pendingHandoff = true;

          const confirmText =
            parsed.text +
            `\n\n---\n内容をまとめますね😊\n\n${summary}\n\n` +
            `このままスタッフに変わりますので少々お待ちください。\n` +
            `他にご不明点はございますか？`;

          await client.replyMessage(replyToken, {
            type: 'text',
            text: confirmText + '\n\nbyAI🦊キキ',
            quickReply: {
              items: [
                { type: 'action', action: { type: 'message', label: 'ない', text: 'ない' } },
                { type: 'action', action: { type: 'message', label: 'ある', text: 'ある' } },
              ],
            },
          });
          user.lastBotReply = Date.now();
          console.log(`[${userId}] autoHandoff → pre-handoff 状態へ移行`);
        } else {
          await client.replyMessage(replyToken, buildMessages(parsed));
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
    cachedProducts = null;
    productsCacheUpdatedAt = 0;
    const info = await getProductInfo();
    res.type('text/plain; charset=utf-8').send(info || '（商品情報なし）');
  } catch (e) {
    res.status(500).send(`エラー: ${e.message}`);
  }
});

// ===== デバッグ：メタフィールド画像URLを確認 =====
app.get('/debug-images', async (req, res) => {
  try {
    cachedProducts = null;
    productsCacheUpdatedAt = 0;
    await getProductInfo();

    if (cachedProductImages.size === 0) {
      return res.type('text/plain; charset=utf-8').send('画像URLが1件も取得できていません。\nメタフィールドが登録されているか確認してください。');
    }

    let out = `取得件数: ${cachedProductImages.size}件\n\n`;
    for (const [handle, urls] of cachedProductImages) {
      out += `【${handle}】\n`;
      out += `  カラー表: ${urls.colorUrl || '（なし）'}\n`;
      out += `  サイズチャート: ${urls.sizeUrl || '（なし）'}\n\n`;
    }
    res.type('text/plain; charset=utf-8').send(out);
  } catch (e) {
    res.status(500).send(`エラー: ${e.message}\n${e.stack}`);
  }
});

// ===== デバッグ：特定商品のメタフィールド生データを確認 =====
app.get('/debug-metafields/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products/${productId}/metafields.json`;
    const response = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
