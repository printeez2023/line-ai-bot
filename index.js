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
const STAFF_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24時間

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
    users.set(userId, {
      mode: 'bot',
      staffSince: null,
      lastBotReply: null,
      pendingHandoff: false,
      awaitingNyuukou: false,
    });
  }
  return users.get(userId);
}
function aiOn(userId) {
  const user = getUser(userId);
  user.mode = 'bot';
  user.staffSince = null;
  user.pendingHandoff = false;
  user.awaitingNyuukou = false;
  processingUsers.delete(userId);
  console.log(`[${userId}] AI復帰`);
}
function aiOff(userId) {
  const user = getUser(userId);
  user.mode = 'staff';
  user.staffSince = Date.now(); // 24時間タイムアウト計測用
  user.pendingHandoff = false;
  user.awaitingNyuukou = false;
  console.log(`[${userId}] スタッフモードON`);
}

// ===== HPスクレイピング =====
const CACHE_TTL = 60 * 60 * 1000;

// 料金ページ：常時キャッシュ（見積もり精度に直結するため必須）
let cachedPriceInfo = null;
let priceInfoUpdatedAt = 0;

// インクページ：キーワード検知時のみ取得
let cachedInkInfo = null;
let inkInfoUpdatedAt = 0;

// FAQページ：キーワード検知時のみ取得（抜粋して返す）
let cachedFaqInfo = null;
let faqInfoUpdatedAt = 0;

async function fetchPageText(url, maxLen = 4000) {
  const res = await fetch(url);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, '\n')
    .trim()
    .slice(0, maxLen);
}

// 料金ページ（常時・1時間キャッシュ）
async function getPriceInfo() {
  const now = Date.now();
  if (cachedPriceInfo && now - priceInfoUpdatedAt < CACHE_TTL) return cachedPriceInfo;
  console.log('料金ページを取得中...');
  try {
    const text = await fetchPageText('https://printeez.jp/pages/about-price', 5000);
    cachedPriceInfo = text;
    priceInfoUpdatedAt = now;
  } catch (e) {
    console.error('料金ページ取得失敗:', e.message);
    cachedPriceInfo = cachedPriceInfo || '';
  }
  return cachedPriceInfo;
}

// インクページ（キーワード検知時・1時間キャッシュ）
async function getInkInfo() {
  const now = Date.now();
  if (cachedInkInfo && now - inkInfoUpdatedAt < CACHE_TTL) return cachedInkInfo;
  console.log('インクページを取得中...');
  try {
    const text = await fetchPageText('https://printeez.jp/pages/about-ink', 3000);
    cachedInkInfo = text;
    inkInfoUpdatedAt = now;
  } catch (e) {
    console.error('インクページ取得失敗:', e.message);
    cachedInkInfo = cachedInkInfo || '';
  }
  return cachedInkInfo;
}

// FAQページ（キーワード検知時・1時間キャッシュ）
async function getFaqInfo() {
  const now = Date.now();
  if (cachedFaqInfo && now - faqInfoUpdatedAt < CACHE_TTL) return cachedFaqInfo;
  console.log('FAQページを取得中...');
  try {
    const text = await fetchPageText('https://printeez.jp/pages/faq', 4000);
    cachedFaqInfo = text;
    faqInfoUpdatedAt = now;
  } catch (e) {
    console.error('FAQページ取得失敗:', e.message);
    cachedFaqInfo = cachedFaqInfo || '';
  }
  return cachedFaqInfo;
}

// 後方互換：getSiteInfo は料金+FAQを返す（既存コードとの互換）
async function getSiteInfo() {
  const [price, faq] = await Promise.all([getPriceInfo(), getFaqInfo()]);
  return `\n=== 料金ページ ===\n${price}\n\n=== よくある質問 ===\n${faq}`;
}

// ===== Shopify Admin API 商品取得 =====
let cachedProducts = null;
let cachedProductImages = new Map();
let productsCacheUpdatedAt = 0;
const PRODUCTS_CACHE_TTL = 60 * 60 * 1000;

// [修正①] 全商品キャッシュ（初回セッション用・軽量版）
let cachedAllProducts = null;
let allProductsCacheUpdatedAt = 0;

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

function hasAvailableStock(variants) {
  if (!variants || variants.length === 0) return false;
  return variants.some(v => {
    if (v.inventory_management === null || v.inventory_management === undefined) return true;
    if (v.inventory_policy === 'continue') return true;
    return v.inventory_quantity > 0;
  });
}

// ===== 全商品取得（all-itemsコレクション経由・顧客向け商品のみ・JSON形式）=====
async function getAllProductsWithMetafields() {
  const now = Date.now();
  if (cachedAllProducts && now - allProductsCacheUpdatedAt < PRODUCTS_CACHE_TTL) {
    return cachedAllProducts;
  }
  console.log('全商品取得中（all-itemsコレクション経由）...');

  const productList = [];

  try {
    const collectionId = await fetchCollectionId('all-items');
    if (!collectionId) {
      console.warn('all-itemsコレクションが見つかりません');
      return cachedAllProducts || '[]';
    }

    // all-itemsはbody_htmlなしで取得（軽量化）
    let url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products.json?collection_id=${collectionId}&limit=250&published_status=published&fields=id,title,handle,vendor,tags,variants`;

    while (url) {
      const res = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
      });
      const data = await res.json();

      for (const p of (data.products || [])) {
        if (!hasAvailableStock(p.variants)) continue;

        const prices = (p.variants || []).map(v => parseFloat(v.price)).filter(n => !isNaN(n));
        const minPrice = prices.length > 0 ? Math.min(...prices) : null;
        const tags = p.tags ? p.tags.split(',').map(t => t.trim()).filter(Boolean) : [];

        productList.push({
          title: p.title,
          brand: p.vendor || '',
          handle: p.handle,
          price_min: minPrice,
          url: `https://printeez.jp/products/${p.handle}`,
          tags,
        });
      }

      const linkHeader = res.headers.get('Link');
      const nextMatch = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = nextMatch ? nextMatch[1] : null;
    }
  } catch (e) {
    console.error('全商品取得エラー:', e.message);
  }

  console.log(`全商品取得完了: ${productList.length}件（顧客向けのみ）`);
  const result = JSON.stringify(productList);
  cachedAllProducts = result;
  allProductsCacheUpdatedAt = now;
  return result;
}

// ===== [修正①] 個別コレクション詳細取得（ジャンル・型番指定後）=====
async function getProductInfo() {
  const now = Date.now();
  if (cachedProducts && now - productsCacheUpdatedAt < PRODUCTS_CACHE_TTL) {
    return cachedProducts;
  }
  console.log('Shopify APIから商品情報を取得中（カテゴリ別詳細）...');

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
        const priceStr = minPrice !== null ? `${minPrice.toLocaleString()}円` : '価格不明';

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
        // [修正②] 画像があるhandleのみ明示。ない場合は記載しない
        if (colorUrl) result += `  カラー表画像あり：handle=${p.handle}\n`;
        if (sizeUrl)  result += `  サイズチャート画像あり：handle=${p.handle}\n`;
        result += '\n';
      }
    } catch (e) {
      console.error(`商品取得失敗: ${col.handle}`, e.message);
    }
  }

  cachedProducts = result;
  // newImageMapをcachedProductImagesにマージ
  for (const [handle, urls] of newImageMap) {
    cachedProductImages.set(handle, urls);
  }
  productsCacheUpdatedAt = now;
  return result;
}

// 再試行後に見つかったhandleのメタフィールドを取得してキャッシュに追加
async function fetchAndCacheMetafieldsForHandle(handle) {
  if (cachedProductImages.has(handle)) return;
  try {
    const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products.json?handle=${handle}&fields=id`;
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
    });
    const data = await res.json();
    const product = data.products?.[0];
    if (!product) return;

    const { colorUrl, sizeUrl } = await fetchProductMetafields(product.id);
    if (colorUrl || sizeUrl) {
      cachedProductImages.set(handle, { colorUrl, sizeUrl });
      console.log(`[メタフィールドキャッシュ追加] ${handle}`);
    }
  } catch (e) {
    console.error(`handle→メタフィールド取得失敗: ${handle}`, e.message);
  }
}

// ===== キーワード判定 =====

const PRODUCT_KEYWORDS = [
  // 日本語
  'おすすめ', 'お勧め', 'どれ', 'どんな', '商品', 'ボディ',
  'Tシャツ', 'パーカー', 'トレーナー', 'ポロシャツ', 'タンクトップ',
  'キャップ', 'バッグ', 'トートバッグ', 'スウェット', 'ロンT',
  'ジャケット', '生地', '素材', '種類',
  '値段', '価格', 'いくら', '円', '安い', '高い',
  // English
  'recommend', 't-shirt', 'tshirt', 'hoodie', 'sweatshirt', 'cap', 'hat',
  'bag', 'tote', 'polo', 'jacket', 'product', 'item', 'price', 'cheap',
  'fabric', 'material', 'color', 'colour', 'size',
];
function needsProductInfo(message) {
  return PRODUCT_KEYWORDS.some(kw => message.includes(kw));
}

const SITE_KEYWORDS = [
  // 日本語
  '料金', '送料', '納期', '発送', 'いつ', '何日', '営業日', '特急',
  '枚数', '割引', '無料', '追加料金', '費用',
  '合計', '総額', '計算', '見積', 'トータル', '全部で', 'いくらになる',
  'プリント', 'スクリーン', 'フルカラー', '刺繍', '加工',
  '注文する', '注文したい', '注文方法', 'お願いしたい', '頼みたい', '申し込み',
  // English
  'shipping', 'delivery', 'days', 'business day', 'express', 'rush',
  'quantity', 'discount', 'free', 'fee', 'cost', 'total', 'quote', 'estimate',
  'print', 'screen print', 'full color', 'embroidery', 'processing',
  'order', 'how to order', 'place an order',
];

// インクページ取得トリガー
const INK_KEYWORDS = [
  'インク', '色', 'カラー', 'インク色', '蛍光', 'ラメ', 'ink', 'color', 'colour',
];
function needsInkInfo(message) {
  return INK_KEYWORDS.some(kw => message.toLowerCase().includes(kw.toLowerCase()));
}

// FAQページ取得トリガー
const FAQ_KEYWORDS = [
  'よくある', 'FAQ', 'faq', '質問', 'わからない', '教えて', '不安',
  'question', 'help', 'how',
];
function needsFaqInfo(message) {
  return FAQ_KEYWORDS.some(kw => message.toLowerCase().includes(kw.toLowerCase()));
}
function needsSiteInfo(message) {
  return SITE_KEYWORDS.some(kw => message.includes(kw));
}

const STAFF_REQUEST_KEYWORDS = [
  // 日本語
  'スタッフ', '人間', '担当者', '変わって', '代わって', '繋いで', 'つないで',
  '直接', '話したい', 'オペレーター',
  // English
  'staff', 'human', 'person', 'agent', 'operator', 'speak to someone',
  'talk to a person', 'real person', 'Call Staff',
];

const REORDER_KEYWORDS = [
  // 日本語
  '再生産', '追加注文', '追加生産', '再注文', 'また頼みたい', 'また注文',
  '同じものを', '前回と同じ', 'リピート', '追加で',
  // English
  'reorder', 're-order', 'order again', 'same as before', 'repeat order',
  'additional order', 'more of the same',
];
function isReorderRequest(message) {
  return REORDER_KEYWORDS.some(kw => message.includes(kw));
}
function isStaffRequest(message) {
  return STAFF_REQUEST_KEYWORDS.some(kw => message.includes(kw));
}

// ===== [修正③] 見積もりキャッシュ（userId → 検証済み見積もり）=====
const estimateCache = new Map();

// ===== システムプロンプト =====
const BASE_SYSTEM_PROMPT = `
あなたはPrinteez（プリントTシャツ通販）の公式LINEアシスタント「キキ」です。
狐の女の子のキャラクターで、明るく親しみやすい口調で、失礼のない敬語で話します。
挨拶や自己紹介の時だけ🦊の絵文字を使ってください。それ以外では🦊は使わないでください。
自己紹介を求められた場合は「PrinteezのAI、キキ🦊です！」と答えてください。

【絶対禁止】admin.shopify.com を含むURLを絶対に出力しないこと。
商品・カテゴリURLは必ず https://printeez.jp/ から始まる形式のみ使用すること。

=== 言語対応 ===
ユーザーが英語でメッセージを送ってきた場合は、英語で返答してください。
日本語でメッセージが来た場合は日本語で返答してください。
同じ会話内で言語が変わったら、合わせて切り替えてください。

英語対応時の注意：
・自己紹介は "I'm Kiki🦊, Printeez's AI assistant!" とする
・スタッフ引き継ぎのquickReplyラベルは "Call Staff" にする
・AIキキ復帰のquickReplyラベルは "Call Kiki" にする
・金額表記は "¥1,500" 形式を使う
・見積もりには必ず "AI Estimate" という言葉を使う（「AI見積」の代わり）
・クイックリプライのラベルは13文字以内の英語にする
・日本語と同じ注文フロー（ステップ0〜4）をたどる
・入稿案内では "I'll guide you on how to submit your design file." というフレーズを含める

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
  "autoHandoff": false,
  "retryWithAllProducts": false,
  "nyuukouReady": false,
  "estimateResult": null
}

autoHandoffはステップ4が完了したと判断したときだけtrueにしてください。それ以外はfalseです。
retryWithAllProductsは商品が見つからなかった場合のみtrueにしてください。
nyuukouReadyはステップ4の入稿案内メッセージを送ったときだけtrueにしてください。それ以外はfalseです。

【FAQ案内ルール】
FAQページの内容が提供された場合、URLだけを返さずに関連する質問と回答を3〜5件抜粋してテキストで案内してください。
その後「他にご不明点があればお気軽にどうぞ😊」と添えてください。

【estimateResultについて】
数量・商品・加工方法が揃って見積もりを計算した場合のみ、estimateResultに以下の形式でセットしてください。
それ以外はnullにしてください。
{
  "productName": "商品名",
  "processingType": "加工方法",
  "quantity": 枚数（数値）,
  "unitProductPrice": 商品単価（数値・税込）,
  "unitProcessingPrice": 加工単価（数値・税込）,
  "unitPrice": 合計単価（数値）,
  "totalPrice": 合計金額（送料込み・数値）,
  "shippingFee": 1000,
  "breakdown": "商品 〇〇円 ＋ 加工 〇〇円 = 単価 〇〇円 × 〇枚 ＋ 送料 1,000円 = AI見積 合計 〇〇円"
}
estimateResultの各数値フィールドはNumber型（文字列不可）で入れてください。
システム側でこの数値を使って自動検証・修正を行います。

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
・見積を算出して教えること（見積時は必ず「AI見積」という言葉を使うこと）
・何かあればスタッフに引き継ぐので安心してもらうこと

【注文フロー】
ステップ0：デザインの有無を確認
  まず「デザインはお持ちですか？」と聞いてください。
  → 「ない」「持っていない」と言われたら、すぐにシミュレーターを案内するのではなく、
     「手書きのイラストや写真などはありますか？」と確認してください。
     - 手書き・写真などがある → デザインあり扱いでステップ1へ（データ化に3〜6営業日かかることを伝える）
     - 何もない → シミュレーター（https://printeez.jp）またはCanva（https://www.canva.com）を案内
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
  → 見積もりを伝えるときは必ず「AI見積」という言葉を使うこと
  → 見積もりを伝えたらステップ4へ

ステップ4（デザイン入稿案内）：
  ステップ3が完了したら、以下の入稿案内を必ず伝えてください：
  「デザインデータの入稿方法についてご案内します！
PDF・AI・PSDファイルはこのLINEから直接お送りいただけます。
画像ファイル（JPG・PNG等）は画質が低下するため、以下からアップロードをお願いします。

📧 MAIL：contact@printeez.jp
🔗 HP：https://printeez.jp/products/ファイルアップロード用ページ」
  その後、クイックリプライで「入稿完了」「入稿できない」「スタッフを呼ぶ」を出してください。
  この入稿案内を送る際は必ず "nyuukouReady": true にしてください。
  → 「入稿完了」が選ばれた・「スタッフを呼ぶ」が選ばれた場合：
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

コード側から【重要・最優先指示】が付いている場合は、必ずその指示に従って自己紹介してください。
自己紹介なしにいきなり商品の話や質問をすることは禁止です。
自己紹介の後は必ずデザインの有無を聞いてください。

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
【重要】商品情報に「カラー表画像あり」の記載がない商品はimageActionsにcolorを含めないでください。
【重要】商品情報に「サイズチャート画像あり」の記載がない商品はimageActionsにsizeを含めないでください。
画像がない商品はimageActionsを省略またはnullにしてください。
※画像が取得できない場合はシステム側でHP案内に自動切り替えするため、あなたはimageActionsを正しく設定するだけでOKです。

=== 価格・料金計算 ===

【金額の表記ルール】
・金額は必ず「〇〇円」と言い切ってください。「〇〇円〜」「〇〇円から」などの表記は使わないでください。
・単価は「¥」ではなく「円」を使ってください。例：1,500円
・見積もりには必ず「AI見積」という言葉を入れてください。
・計算に使った単価が商品情報の最安値であるなど、実際の金額と異なる可能性がある場合も、「AI見積」をつけてください。例：AI見積 合計 12,000円
・根拠が明確な場合も「AI見積」は必ずつけてください。

商品情報が提供された場合は必ず価格をユーザーに伝えてください。
価格を聞かれたら提供された商品情報の「価格：」の行を必ず参照してください。

数量・商品・加工方法が揃ったら以下の式で合計金額を計算してください：
  単価 = 商品代金 + 加工代金
  合計 = 単価 × 枚数 + 送料（一律1,000円）
計算結果は「商品 〇〇円 ＋ 加工 〇〇円 = 単価 〇〇円 × 〇枚 ＋ 送料 1,000円 = AI見積 合計 〇〇円」の形式で示してください。
加工代金は提供された料金ページの情報を参照してください。

=== 商品URL ===

【重要】商品名・URL・価格は必ず提供された商品データ（JSON配列）から参照してください。
推測・補完・生成は絶対に禁止です。
商品データに載っていない商品名やURLを自分で作らないでください。

商品データの構造：
- title: 商品名
- brand: ブランド名（例：United Athle、Printstar）
- handle: 商品識別子（URLの末尾に使用）
- price_min: 最低価格（円）
- url: 商品ページURL（このURLをそのまま使ってください）
- tags: 商品タグ（素材・特徴・カテゴリなど）

【商品検索の優先順位】
商品を検索する際は必ず以下の順番で探してください：
1. title（商品名）に一致・部分一致するものを最優先
2. tags に一致するものを次に参照
3. brand（ブランド名）で絞り込む
4. handle（型番・識別子）で一致するものを参照

URLは必ず該当商品の url フィールドをそのまま使うこと。絶対に自分でURLを生成・推測しないこと。
商品が特定できない場合は「商品情報を確認できませんでした」と答え、retryWithAllProducts: true を返してください。

カテゴリのみ分かる場合はカテゴリURLを案内してください：
Tシャツ→https://printeez.jp/collections/t-shirts
パーカー→https://printeez.jp/collections/hoody-sweat
スウェット→https://printeez.jp/collections/sweat
ロンT→https://printeez.jp/collections/long-t-shirts
キャップ→https://printeez.jp/collections/cap-hat
バッグ→https://printeez.jp/collections/bag-totebag
ショートパンツ・ハーフパンツ→https://printeez.jp/collections/short-pants
パンツ・ロングパンツ・ボトムス→https://printeez.jp/collections/long-pants
ポロ・ドライ→https://printeez.jp/collections/polo-shirts

エプロン・ワッペン・タグ・その他グッズ（上記カテゴリに該当しない商品）：
→カテゴリURLは存在しません。商品データ（JSON配列）のtitleから該当する商品を検索し、商品名とURLを直接提案してください。
→例：「エプロン」と聞かれたら、titleに「エプロン」を含む商品を3〜5件リストアップしてください。
→例：「ワッペン」と聞かれたら、titleに「ワッペン」を含む商品を3〜5件リストアップしてください。
→例：「タグを作りたい」と聞かれたら、titleに「オリジナルタグ」を含む商品を3〜5件リストアップしてください。

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
・フルカラープリント：フルカラーOK、写真・小ロット向き。加工サイズによる価格変動なし。
・刺繍：ロゴ等に対応、糸色指定可、通常5色まで。写真や1mm以下の細部は対応不可。
  刺繍料金はサイズ3種類のみで価格が変わる：
  - 小：8×8cm以内
  - 中：16×16cm以内
  - 大：24×24cm以内
  小物・キャップ・帽子類への刺繍は8×8cm（小）と同等の扱い。
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
・ワッペン：オリジナル刺繍ワッペン 10枚セット(WP-001) 5,000円　商品URL：https://printeez.jp/products/wappen-001　※10個セット販売のみ（1個販売なし）
・ワッペン縫い付け：1か所 ¥500
・タグ：オリジナルプリントネームタグ 30枚セット(PT-001) 2,550円　商品URL：https://printeez.jp/products/printtag-001
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

// ===== [修正③] 見積もり検証用システムプロンプト =====
const ESTIMATE_VERIFY_SYSTEM = `
あなたは見積もり検証AIです。
渡された見積もりデータの計算が正しいかチェックしてください。

検証ルール：
1. unitPrice = unitProductPrice + unitProcessingPrice であること
2. totalPrice = unitPrice × quantity + shippingFee であること
3. shippingFee は必ず1000であること
4. 計算が間違っている場合は corrected フィールドに正しい値をセットしてください
5. 計算が合っている場合は corrected を null にしてください

出力は必ず以下のJSONのみ（他のテキスト不可）：
{
  "isValid": true または false,
  "corrected": null または {
    "unitPrice": 正しい合計単価（数値）,
    "totalPrice": 正しい合計金額（数値）,
    "breakdown": "商品 〇〇円 ＋ 加工 〇〇円 = 単価 〇〇円 × 〇枚 ＋ 送料 1,000円 = AI見積 合計 〇〇円"
  }
}
`;

// ===== 会話履歴 =====
const conversationHistory = new Map();

// ===== 会話要約 =====
async function generateSummary(userId) {
  const history = conversationHistory.get(userId) || [];
  const historyText = history
    .map(h => `${h.role === 'user' ? 'お客様' : 'キキ'}: ${h.parts[0].text}`)
    .join('\n');

  // キャッシュされた見積もり情報があれば要約に含める
  const est = estimateCache.get(userId);
  const estimateNote = est
    ? `\n【AI見積情報】${est.breakdown}`
    : '';

  let summary = '（要約取得失敗）';
  try {
    const res = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [{ text: `以下の会話を2〜3行で要約してください。スタッフへの引き継ぎメモとして使います。敬語不要、箇条書きOK。${estimateNote}\n\n${historyText}` }],
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
    text: baseText + '\n\nby AI🦊キキ',
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
  const user = getUser(userId);
  // replyを先に送ってからモード変更（返信欠落防止）
  await client.replyMessage(replyToken, {
    type: 'text',
    text: 'スタッフにお繋ぎします！少々お待ちください🙏
ご用件がある場合は「キキを呼ぶ」とメッセージをお送りください。',
  });
  user.pendingHandoff = false;
  aiOff(userId);
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

// ===== [修正③] 見積もり検証（Gemini 2回目呼び出し）=====
async function verifyEstimate(userId, estimateResult) {
  if (!estimateResult) return null;

  try {
    const verifyInput = JSON.stringify(estimateResult);
    const res = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: `以下の見積もりデータを検証してください：\n${verifyInput}` }] }],
      config: {
        systemInstruction: ESTIMATE_VERIFY_SYSTEM,
        responseMimeType: 'application/json',
      },
    });

    const raw = res.text.trim().replace(/```json/gi, '').replace(/```/g, '').trim();
    const result = JSON.parse(raw);
    console.log(`[${userId}] 見積もり検証結果:`, JSON.stringify(result));

    if (!result.isValid && result.corrected) {
      // 修正版をキャッシュに保存
      const corrected = {
        ...estimateResult,
        unitPrice: result.corrected.unitPrice,
        totalPrice: result.corrected.totalPrice,
        breakdown: result.corrected.breakdown,
        timestamp: Date.now(),
      };
      estimateCache.set(userId, corrected);
      console.log(`[${userId}] 見積もり修正完了: ${result.corrected.breakdown}`);
      return result.corrected; // 修正版を返す（テキスト差し替え用）
    }

    // 正しい場合もキャッシュに保存
    estimateCache.set(userId, { ...estimateResult, timestamp: Date.now() });
    return null; // 修正なし
  } catch (e) {
    console.error(`[${userId}] 見積もり検証エラー:`, e.message);
    // エラーでもキャッシュには保存
    estimateCache.set(userId, { ...estimateResult, timestamp: Date.now() });
    return null;
  }
}

// ===== Gemini呼び出しの共通ロジック =====
async function callGemini(history, systemPrompt) {
  const MAX_RETRIES = 3;
  let response;
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
        console.warn(`Gemini 503 リトライ ${attempt}/${MAX_RETRIES} (${wait}ms後)`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw e;
      }
    }
  }
  return response;
}

// ===== Geminiに問い合わせる関数 =====
async function askGemini(userId, userMessage) {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId);

  let systemPrompt = BASE_SYSTEM_PROMPT;

  // 初回メッセージ判定
  const isFirstMessage = history.length === 0;
  const allProductsCacheExpired = !cachedAllProducts ||
    (Date.now() - allProductsCacheUpdatedAt >= PRODUCTS_CACHE_TTL);

  // 初回は必ず自己紹介するようコード側から明示指示（AIの判断に任せない）
  if (isFirstMessage) {
    systemPrompt += `\n\n【重要・最優先指示】これは会話の最初のメッセージです。必ず自己紹介から始めてください。自己紹介の内容：AIアシスタント「キキ」であること、できること（質問への回答・商品選びからご入稿までのアシスト）、ご入稿完了以降はスタッフが対応すること、「よろしければこのままご案内します！」という一言。自己紹介の後にデザインの有無を聞いてください。`;
    console.log(`[${userId}] 初回メッセージ：自己紹介指示を注入`);
  }

  if (isFirstMessage || allProductsCacheExpired) {
    try {
      const allProducts = await getAllProductsWithMetafields();
      if (allProducts) {
        systemPrompt += `\n\n以下は取扱商品データ（JSON配列）です。ユーザーの質問に最も合う商品を選んで回答してください。title/brand/tags を使って商品を検索・絞り込みしてください。\n${allProducts}`;
        console.log(`[${userId}] 全商品一覧を注入（初回=${isFirstMessage} キャッシュ切れ=${allProductsCacheExpired}）`);
      }
    } catch (e) {
      console.error('全商品取得エラー:', e.message);
    }
  }

  // 料金ページは常時注入（見積もり精度に直結）
  try {
    const priceInfo = await getPriceInfo();
    if (priceInfo) {
      systemPrompt += `\n=== 加工料金ページ（必ず参照すること）===\n${priceInfo}`;
      console.log(`[${userId}] 料金ページを注入`);
    }
  } catch (e) {
    console.error('料金ページ注入エラー:', e.message);
  }

  // インクページ：キーワード検知時のみ
  if (needsInkInfo(userMessage)) {
    try {
      const inkInfo = await getInkInfo();
      if (inkInfo) {
        systemPrompt += `\n=== スクリーンプリント インク一覧 ===\n${inkInfo}`;
        console.log(`[${userId}] インクページを注入`);
      }
    } catch (e) {
      console.error('インクページ注入エラー:', e.message);
    }
  }

  // FAQページ：キーワード検知時のみ（抜粋案内）
  if (needsFaqInfo(userMessage) || needsSiteInfo(userMessage)) {
    try {
      const faqInfo = await getFaqInfo();
      if (faqInfo) {
        systemPrompt += `\n=== よくある質問（関連する質問を3〜5件抜粋して案内すること）===\n${faqInfo}`;
        console.log(`[${userId}] FAQページを注入`);
      }
    } catch (e) {
      console.error('FAQページ注入エラー:', e.message);
    }
  }

  // 初回以外でジャンル/型番キーワードが来たらカテゴリ別詳細を追加注入
  // ※ retryモード中はカテゴリ注入しない（プロンプト肥大防止）
  if (!isFirstMessage && needsProductInfo(userMessage)) {
    try {
      const productInfo = await getProductInfo();
      systemPrompt += `\n=== 取扱商品情報（カテゴリ別詳細・説明・画像情報含む）===\n${productInfo}`;
      console.log(`[${userId}] 商品情報を注入（カテゴリ別詳細）`);
    } catch (e) {
      console.error('商品取得エラー:', e.message);
    }
  }

  history.push({ role: 'user', parts: [{ text: userMessage }] });

  let response;
  try {
    response = await callGemini(history, systemPrompt);
  } catch (e) {
    history.pop();
    console.error(`[${userId}] Gemini呼び出し失敗:`, e.message);
    throw e;
  }

  const rawText = response.text.trim();
  const cleaned = filterThought(rawText);

  let parsed = { text: cleaned, quickReplies: [], estimateResult: null };
  try {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error('JSONパース失敗:', e.message);
    parsed.text = '少し問題が発生しました。もう一度お試しください。';
  }

  // [修正③] 見積もりが返ってきたら検証して必要なら修正テキストで上書き
  if (parsed.estimateResult) {
    const correction = await verifyEstimate(userId, parsed.estimateResult);
    if (correction) {
      console.log(`[${userId}] 見積もりテキストを修正版で上書き`);
      const replaced = parsed.text.replace(
        /商品\s*[\d,]+円\s*[＋+]\s*加工\s*[\d,]+円[\s\S]*?AI見積\s*合計\s*[\d,]+円/,
        correction.breakdown
      );
      parsed.text = replaced !== parsed.text ? replaced : parsed.text + `\n\n${correction.breakdown}`;
    }
  }

  // [修正①] retryWithAllProducts: true → カテゴリ注入なしで全商品のみで再試行
  if (parsed.retryWithAllProducts === true) {
    console.log(`[${userId}] 商品が見つからず → 全商品のみで再試行（カテゴリ注入なし）`);

    try {
      await client.pushMessage(userId, {
        type: 'text',
        text: '少々お待ちください、全商品を確認してみますね！\n\nby AI🦊キキ',
      });
    } catch (e) {
      console.error('pushMessage失敗:', e.message);
    }

    try {
      // retryモードではBASE_SYSTEM_PROMPT + 全商品JSONのみ（カテゴリ詳細・HP情報を追加しない）
      const allProducts = await getAllProductsWithMetafields();
      const retryPrompt = BASE_SYSTEM_PROMPT +
        `\n\n以下は取扱商品データ（JSON配列・完全版）です。ユーザーの質問に最も合う商品を選んでください。\n${allProducts}`;

      const retryResponse = await callGemini(history, retryPrompt);
      const retryRaw     = retryResponse.text.trim();
      const retryCleaned = filterThought(retryRaw);

      let retryParsed = { text: retryCleaned, quickReplies: [], estimateResult: null };
      try {
        const m = retryCleaned.match(/\{[\s\S]*\}/);
        if (m) retryParsed = JSON.parse(m[0]);
      } catch (e) {
        console.error('再試行JSONパース失敗:', e.message);
      }

      if (retryParsed.imageActions && retryParsed.imageActions.length > 0) {
        for (const action of retryParsed.imageActions) {
          fetchAndCacheMetafieldsForHandle(action.handle).catch(console.error);
        }
        await new Promise(r => setTimeout(r, 3000));
      }

      if (retryParsed.estimateResult) {
        const correction = await verifyEstimate(userId, retryParsed.estimateResult);
        if (correction) {
          const replaced = retryParsed.text.replace(
            /商品\s*[\d,]+円\s*[＋+]\s*加工\s*[\d,]+円[\s\S]*?AI見積\s*合計\s*[\d,]+円/,
            correction.breakdown
          );
          retryParsed.text = replaced !== retryParsed.text ? replaced : retryParsed.text + `\n\n${correction.breakdown}`;
        }
      }

      history.push({ role: 'model', parts: [{ text: retryParsed.text }] });
      if (history.length > 20) history.splice(0, 2);
      return retryParsed;
    } catch (e) {
      console.error(`[${userId}] 全商品再試行失敗:`, e.message);
    }
  }

  history.push({ role: 'model', parts: [{ text: parsed.text }] });
  if (history.length > 20) history.splice(0, 2);

  return parsed;
}

// ===== [修正②] LINEメッセージ組み立て（画像なし→HP案内）=====
function buildTextMessage(parsed) {
  const msg = {
    type: 'text',
    text: parsed.text + '\n\nby AI🦊キキ',
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

function buildMessages(parsed) {
  const messages = [];
  messages.push(buildTextMessage(parsed));

  if (parsed.imageActions && parsed.imageActions.length > 0) {
    for (const action of parsed.imageActions) {
      const imgData = cachedProductImages.get(action.handle);
      const label = action.type === 'color' ? 'カラーバリエーション' : 'サイズチャート';

      if (!imgData) {
        // [修正②] メタフィールド未登録 → HP案内に切り替え
        console.log(`[画像なし] handle=${action.handle} type=${action.type} → HP案内`);
        messages.push({
          type: 'text',
          text: `【${label}】\n詳細はこちらの商品ページでご確認ください🙏\nhttps://printeez.jp/products/${action.handle}`,
        });
        continue;
      }

      const url = action.type === 'color' ? imgData.colorUrl : imgData.sizeUrl;

      if (!url) {
        // [修正②] handleはあるが該当タイプのURLがない → HP案内
        console.log(`[画像URL未登録] handle=${action.handle} type=${action.type} → HP案内`);
        messages.push({
          type: 'text',
          text: `【${label}】\n詳細はこちらの商品ページでご確認ください🙏\nhttps://printeez.jp/products/${action.handle}`,
        });
        continue;
      }

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

      // ===== staffモード完全停止（全イベント種別に対して最初に判定）=====
      {
        const user = getUser(userId);
        if (user.mode === 'staff') {
          const isText    = event.type === 'message' && event.message.type === 'text';
          const text      = isText ? event.message.text : '';
          const isAiOn    = text === 'キキを呼ぶ' || text === '/ai-on';
          const isStaffEnd = text === '#staff-end';
          const expired   = user.staffSince && (Date.now() - user.staffSince > STAFF_TIMEOUT_MS);

          if (isAiOn || isStaffEnd || expired) {
            aiOn(userId);
            conversationHistory.delete(userId); // スタッフ対応中の履歴をリセット
            if (isAiOn || isStaffEnd) {
              // 解除コマンドの場合のみ返信（タイムアウトは無言で復帰）
              try {
                await client.replyMessage(replyToken, {
                  type: 'text',
                  text: 'キキ🦊です！また会えましたね！何でもお気軽にどうぞ😊',
                });
              } catch (e) {
                console.error('staffモード解除返信失敗:', e.message);
              }
              console.log(`[${userId}] staffモード解除（${isStaffEnd ? '#staff-end' : 'キキを呼ぶ'}）`);
              continue;
            }
            console.log(`[${userId}] staffモード24時間タイムアウト → bot復帰（次のメッセージから有効）`);
            continue; // タイムアウト復帰は同一イベントには返信しない
          } else {
            console.log(`[${userId}] スタッフ対応中 → AI完全停止`);
            continue;
          }
        }
      }

      if (processingUsers.has(userId)) {
        console.log(`[${userId}] 処理中のためスキップ: ${eventId}`);
        // replyTokenを使わず静かにスキップ（二重返答防止）
        continue;
      }
      processingUsers.add(userId);
      // 処理開始時刻を記録（デバッグ用）
      console.log(`[${userId}] 処理開始: ${eventId}`);

      try {
        const user = getUser(userId);

        // スタンプ → AI復帰（staffモード中はスキップ・上のブロックで処理済み）
        if (event.type === 'message' && event.message.type === 'sticker') {
          if (user.mode === 'staff') {
            console.log(`[${userId}] スタンプ受信 → スタッフモード中のためスキップ`);
            continue;
          }
          console.log(`[${userId}] スタンプ受信 → AI復帰処理`);
          aiOn(userId);
          await client.replyMessage(replyToken, {
            type: 'text',
            text: 'キキ🦊です！また会えましたね！何でもお気軽にどうぞ😊',
          });
          continue;
        }

        // ===== [修正④] 画像受信（PNG/JPEG）→ 常にpre-handoff案内 =====
        if (event.type === 'message' && event.message.type === 'image') {
          if (user.mode === 'staff') continue;

          await showLoadingAnimation(userId, 15);

          if (user.pendingHandoff) {
            await executeHandoff(userId, replyToken);
            continue;
          }

          await client.replyMessage(replyToken, {
            type: 'text',
            text: 'すみません、画像の確認はキキにはできません🙏\nスタッフをお呼びしますか？\n\nby AI🦊キキ',
            quickReply: {
              items: [
                { type: 'action', action: { type: 'message', label: 'スタッフを呼ぶ', text: 'スタッフを呼ぶ' } },
                { type: 'action', action: { type: 'message', label: 'いいえ', text: 'いいえ' } },
              ],
            },
          });
          continue;
        }

        // ===== [修正④] ファイル受信（PDF/AI/PSD等）→ awaitingNyuukou中のみ入稿受付 =====
        if (event.type === 'message' && event.message.type === 'file') {
          if (user.mode === 'staff') continue;

          await showLoadingAnimation(userId, 15);

          if (user.pendingHandoff) {
            await executeHandoff(userId, replyToken);
            continue;
          }

          if (user.awaitingNyuukou) {
            // ステップ4入稿待ち中 → 拡張子で判定
            const fileName = event.message.fileName || '';
            const ext = fileName.split('.').pop().toLowerCase();
            const acceptedExts = ['pdf', 'ai', 'psd', 'eps', 'svg', 'tiff', 'tif'];

            if (acceptedExts.includes(ext) || ext === '') {
              // 受け付けOK → 入稿完了扱いでpre-handoffへ
              console.log(`[${userId}] 入稿ファイル受信 (${fileName}) → autoHandoff開始`);
              const summary = await generateSummary(userId);
              user.awaitingNyuukou = false;
              user.pendingHandoff = true;

              const confirmText =
                `ファイルを受け取りました！ありがとうございます😊\n\n` +
                `内容をまとめますね😊\n\n${summary}\n\n` +
                `このままスタッフに変わりますので少々お待ちください。\n` +
                `他にご不明点はございますか？`;

              await client.replyMessage(replyToken, {
                type: 'text',
                text: confirmText + '\n\nby AI🦊キキ',
                quickReply: {
                  items: [
                    { type: 'action', action: { type: 'message', label: 'ない', text: 'ない' } },
                    { type: 'action', action: { type: 'message', label: 'ある', text: 'ある' } },
                  ],
                },
              });
            } else {
              // PNG/JPEG等が誤って file タイプで来た場合 or 非対応形式
              await client.replyMessage(replyToken, {
                type: 'text',
                text: `すみません、${ext ? ext.toUpperCase() + 'ファイル' : 'このファイル'}はキキには確認できません🙏\nPDF・AI・PSDファイルをお送りいただくか、以下からご入稿ください。\n\n📧 MAIL：contact@printeez.jp\n🔗 HP：https://printeez.jp/products/ファイルアップロード用ページ\n\nby AI🦊キキ`,
                quickReply: {
                  items: [
                    { type: 'action', action: { type: 'message', label: 'スタッフを呼ぶ', text: 'スタッフを呼ぶ' } },
                    { type: 'action', action: { type: 'message', label: '入稿できない', text: '入稿できない' } },
                  ],
                },
              });
            }
          } else {
            // awaitingNyuukou=false → 入稿待ちでないのでpre-handoff案内
            await client.replyMessage(replyToken, {
              type: 'text',
              text: 'すみません、ファイルの確認はキキにはできません🙏\nスタッフをお呼びしますか？\n\nby AI🦊キキ',
              quickReply: {
                items: [
                  { type: 'action', action: { type: 'message', label: 'スタッフを呼ぶ', text: 'スタッフを呼ぶ' } },
                  { type: 'action', action: { type: 'message', label: 'いいえ', text: 'いいえ' } },
                ],
              },
            });
          }
          continue;
        }

        if (event.type !== 'message' || event.message.type !== 'text') continue;

        const userMessage = event.message.text;

        // pendingHandoff 中の処理（厳格化）
        if (user.pendingHandoff) {
          const isNo  = userMessage === 'ない' || userMessage === 'No'  || userMessage === 'no';
          const isYes = userMessage === 'ある' || userMessage === 'Yes' || userMessage === 'yes';

          if (isNo) {
            // 「ない」→ 即引き継ぎ
            await executeHandoff(userId, replyToken);
          } else if (isYes) {
            // 「ある」→ pendingHandoffを維持したままGeminiで追加質問を受ける
            user.pendingHandoff = false;
            await showLoadingAnimation(userId, 30);
            const parsed = await askGemini(userId, userMessage);
            await client.replyMessage(replyToken, buildMessages(parsed));
            user.lastBotReply = Date.now();
          } else {
            // それ以外（誤送信・自由入力など）→ Gemini呼ばず、案内のみ返す
            await client.replyMessage(replyToken, {
              type: 'text',
              text: 'このままスタッフにお繋ぎしますか？

by AI🦊キキ',
              quickReply: {
                items: [
                  { type: 'action', action: { type: 'message', label: 'ない', text: 'ない' } },
                  { type: 'action', action: { type: 'message', label: 'ある', text: 'ある' } },
                ],
              },
            });
          }
          continue;
        }

        // テキストコマンド
        const isAiOff = userMessage === 'スタッフを呼ぶ' || userMessage === '/ai-off';
        const isAiOn  = userMessage === 'キキを呼ぶ'     || userMessage === '/ai-on';

        // isAiOn はstaffモード中のみ有効（ループ先頭で処理済み）
        // staffモードでない状態での「キキを呼ぶ」は通常メッセージとして処理

        // staffモード判定はループ先頭で完了済み（ここには到達しない）

        // 「スタッフを呼ぶ」→ pre-handoff フローへ
        if (isAiOff || isStaffRequest(userMessage)) {
          await showLoadingAnimation(userId, 15);
          const summary = await generateSummary(userId);
          await sendPreHandoffMessage(userId, replyToken, summary, 'staff_request');
          user.lastBotReply = Date.now();
          console.log(`[${userId}] pre-handoff 開始（スタッフ要求）`);
          continue;
        }

        // Gemini呼び出し & 返信
        await showLoadingAnimation(userId, 30);

        if (isReorderRequest(userMessage)) {
          console.log(`[${userId}] 再生産・追加注文リクエスト検知`);
        }

        const parsed = await askGemini(userId, userMessage);

        if (parsed.autoHandoff === true && !user.pendingHandoff) {
          const summary = await generateSummary(userId);
          user.pendingHandoff = true;

          const confirmText =
            parsed.text +
            `\n\n---\n内容をまとめますね😊\n\n${summary}\n\n` +
            `このままスタッフに変わりますので少々お待ちください。\n` +
            `他にご不明点はございますか？`;

          await client.replyMessage(replyToken, {
            type: 'text',
            text: confirmText + '\n\nby AI🦊キキ',
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
          // [修正②] nyuukouReady: AIフラグ + テキストマッチの二重判定
          // すでに awaitingNyuukou=true の場合は再セットしない（暴発防止）
          if (!user.awaitingNyuukou) {
            const NYUUKOU_TRIGGER_PHRASES = [
              // 日本語トリガー
              'デザインデータの入稿方法についてご案内',
              'PDF・AI・PSDファイルはこのLINEから直接お送り',
              '入稿方法についてご案内します',
              // English triggers
              "I'll guide you on how to submit your design file",
              'You can send PDF, AI, or PSD files directly',
              'here is how to submit your design',
            ];
            const textTriggered = NYUUKOU_TRIGGER_PHRASES.some(t => (parsed.text || '').includes(t));
            if (parsed.nyuukouReady === true || textTriggered) {
              user.awaitingNyuukou = true;
              console.log(`[${userId}] 入稿待ち状態にセット（AIフラグ=${parsed.nyuukouReady} テキスト=${textTriggered}）`);
            }
          }
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
        console.log(`[${userId}] 処理完了・ロック解放`);
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

// ===== デバッグ：カテゴリ別商品詳細を確認 =====
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

// ===== デバッグ：全商品一覧（初回セッション用）を確認 =====
app.get('/debug-all-products', async (req, res) => {
  try {
    cachedAllProducts = null;
    allProductsCacheUpdatedAt = 0;
    const info = await getAllProductsWithMetafields();
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

// ===== デバッグ：見積もりキャッシュを確認 =====
app.get('/debug-estimates', (req, res) => {
  const out = {};
  for (const [userId, est] of estimateCache) {
    out[userId] = est;
  }
  res.json(out);
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
