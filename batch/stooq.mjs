/**
 * stooq.mjs — 米国株の日次ヒストリカル取得(無料・認証不要)
 * ----------------------------------------------------------------------------
 * Stooq (https://stooq.com) は無料でCSV形式の日次OHLCVを配信している。
 * GOOGLEFINANCE の historical 取得は不安定さが指摘されているため、
 * ヒストリカルは Stooq、当日の現在値・PER等は GAS+GOOGLEFINANCE、
 * という役割分担にしている(README参照)。
 *
 * ■ 未検証の注意
 *   開発サンドボックスのネットワーク制限で stooq.com への接続を実際に
 *   試せていない。URLフォーマットは公開情報に基づく。導入時は必ず
 *   1銘柄でスモークテストすること。
 */

const BASE = "https://stooq.com/q/d/l/";

/* ブラウザ的な User-Agent を付与する。
   ■ なぜ必要になったか
   実機で全銘柄が原因不明の「データが見つからない」で失敗する事象が
   発生した。これは以前 Discord Webhook で発生したのと同じパターン
   ( Cloudflare 等が Node のデフォルト User-Agent をボットとして
   弾く )である可能性が高い。ブラウザ的な値を明示して回避する。 */
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; StockScoutBot/1.0; +https://github.com/)" };

/**
 * 日付範囲を指定して取得する(日次差分更新用)。
 * Stooq は d1/d2 パラメータ(YYYYMMDD)で期間を絞れる。
 */
export async function fetchStooqHistoryRange(ticker, from, to) {
  const d1 = from.replaceAll("-", "");
  const d2 = to.replaceAll("-", "");
  const url = `${BASE}?s=${ticker.toLowerCase()}.us&i=d&d1=${d1}&d2=${d2}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Stooq取得失敗 ${ticker}: HTTP ${res.status}`);
  const text = await res.text();
  if (text.startsWith("<") || /No data/i.test(text)) return []; // 範囲内にデータ無しは正常
  const lines = text.trim().split("\n").slice(1);
  const rows = [];
  for (const line of lines) {
    const [date, o, h, l, c, v] = line.split(",");
    if (!date || o === "N/D") continue;
    rows.push({ date, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) || 0 });
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : 1));
}
export async function fetchStooqHistory(ticker) {
  const url = `${BASE}?s=${ticker.toLowerCase()}.us&i=d`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Stooq取得失敗 ${ticker}: HTTP ${res.status}`);
  const text = await res.text();
  if (text.startsWith("<") || /No data/i.test(text) || text.trim() === "") {
    /* 「見つからない」は本当にティッカーが誤っている場合と、
       Stooq側のブロック・レート制限・仕様変更の場合がある。
       実際に何が返ってきたかをエラーメッセージに含めることで、
       次回すぐに切り分けられるようにする(黙って諦めない)。 */
    throw new Error(`Stooq: ${ticker} のデータが見つかりません。レスポンス冒頭: ${JSON.stringify(text.slice(0, 150))}`);
  }
  const lines = text.trim().split("\n").slice(1); // ヘッダ行を除く
  const rows = [];
  for (const line of lines) {
    const [date, o, h, l, c, v] = line.split(",");
    if (!date || o === "N/D") continue;
    rows.push({ date, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) || 0 });
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : 1));
}
