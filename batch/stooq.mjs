/**
 * stooq.mjs — 米国株の日次ヒストリカル取得
 * ----------------------------------------------------------------------------
 * Stooq (https://stooq.com) は無料でCSV形式の日次OHLCVを配信している。
 * GOOGLEFINANCE の historical 取得は不安定さが指摘されているため、
 * ヒストリカルは Stooq、当日の現在値・PER等は GAS+GOOGLEFINANCE、
 * という役割分担にしていた(README参照)。
 *
 * ■ GAS経由での代理取得について(2026年7月・方針変更)
 *   GitHub Actions のランナーから直接 stooq.com を呼んだところ、実機で
 *   HTMLのブロックページが返ってくることが確認された(ブラウザ的な
 *   User-Agentを付けても解消せず、IP単位のブロックと推測される)。
 *   Google Apps Script(GAS)は Google のインフラから発信されるため、
 *   ブロックされない可能性がある(保証はない)。
 *
 *   環境変数 GAS_US_STOCK_PROXY_URL が設定されていれば、直接
 *   stooq.com を叩く代わりに GAS 経由(?action=stooq&ticker=...)で
 *   取得する。この環境変数は元々 GOOGLEFINANCE 連携用に設定済みのため、
 *   追加のSecret設定は不要(gas/USStockProxy.gs にプロキシ機能を追加済み)。
 *   未設定の場合は従来通り直接 stooq.com を叩く(手元でのローカル検証用)。
 */

const STOOQ_BASE = "https://stooq.com/q/d/l/";

/* ブラウザ的な User-Agent を付与する(GAS経由でない場合の保険として維持)。 */
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; StockScoutBot/1.0; +https://github.com/)" };

function gasProxyUrl() {
  return process.env.GAS_US_STOCK_PROXY_URL || null;
}

/** 実際にCSVテキストを取得する(GAS経由 or 直接)。 */
async function fetchCsv(ticker, d1, d2) {
  const proxy = gasProxyUrl();
  if (proxy) {
    const params = new URLSearchParams({ action: "stooq", ticker: ticker.toLowerCase() });
    if (d1) params.set("d1", d1);
    if (d2) params.set("d2", d2);
    const sep = proxy.includes("?") ? "&" : "?";
    const url = `${proxy}${sep}${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GAS経由Stooq取得失敗 ${ticker}: HTTP ${res.status}`);
    const text = await res.text();
    if (text.startsWith("ERROR:")) throw new Error(`GAS経由Stooq取得失敗 ${ticker}: ${text}`);
    return text;
  }
  // GAS未設定時は直接アクセス(ローカル検証用。実運用では上のGAS経由が使われる)
  let url = `${STOOQ_BASE}?s=${ticker.toLowerCase()}.us&i=d`;
  if (d1) url += `&d1=${d1}`;
  if (d2) url += `&d2=${d2}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Stooq取得失敗 ${ticker}: HTTP ${res.status}`);
  return res.text();
}

function parseCsv(text) {
  const lines = text.trim().split("\n").slice(1); // ヘッダ行を除く
  const rows = [];
  for (const line of lines) {
    const [date, o, h, l, c, v] = line.split(",");
    if (!date || o === "N/D") continue;
    rows.push({ date, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) || 0 });
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 期間を指定して取得する(日次差分更新用)。 */
export async function fetchStooqHistoryRange(ticker, from, to) {
  const d1 = from.replaceAll("-", "");
  const d2 = to.replaceAll("-", "");
  const text = await fetchCsv(ticker, d1, d2);
  if (text.startsWith("<") || /No data/i.test(text)) return []; // 範囲内にデータ無しは正常
  return parseCsv(text);
}

/** 全期間を取得する(初回バックフィル用)。 */
export async function fetchStooqHistory(ticker) {
  const text = await fetchCsv(ticker, null, null);
  if (text.startsWith("<") || /No data/i.test(text) || text.trim() === "") {
    /* 「見つからない」は本当にティッカーが誤っている場合と、
       Stooq側のブロック・レート制限・仕様変更の場合がある。
       実際に何が返ってきたかをエラーメッセージに含めることで、
       次回すぐに切り分けられるようにする(黙って諦めない)。 */
    throw new Error(`Stooq: ${ticker} のデータが見つかりません。レスポンス冒頭: ${JSON.stringify(text.slice(0, 150))}`);
  }
  return parseCsv(text);
}
