/**
 * stooq.mjs — 米国株の日次ヒストリカル取得
 * ----------------------------------------------------------------------------
 * Stooq が JavaScript チャレンジによるbot保護を導入したため、
 * Yahoo Finance の chart API に切り替え(無料・認証不要)。
 * エンドポイント: https://query1.finance.yahoo.com/v8/finance/chart/{TICKER}
 */

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "application/json",
};

/**
 * Yahoo Finance から最大5年分の日次OHLCVを取得する。
 * @param {string} ticker - 例: "aapl"
 * @returns {Promise<Array<{date,o,h,l,c,v}>>}
 */
export async function fetchStooqHistory(ticker) {
  // 関数名はbuild-snapshot側との互換性のため維持
  const symbol = ticker.toUpperCase();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5y`;
  let res = await fetch(url, { headers: YF_HEADERS });

  // query1 が失敗した場合 query2 にフォールバック
  if (!res.ok) {
    const url2 = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5y`;
    res = await fetch(url2, { headers: YF_HEADERS });
  }
  if (!res.ok) throw new Error(`Yahoo Finance取得失敗 ${ticker}: HTTP ${res.status}`);

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) {
    const errMsg = json?.chart?.error?.description ?? "データなし";
    throw new Error(`Yahoo Finance: ${ticker} のデータが見つかりません — ${errMsg}`);
  }

  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const adjClose = result.indicators?.adjclose?.[0]?.adjclose ?? [];

  const rows = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = adjClose[i] ?? quote.close?.[i];
    if (c == null || isNaN(c)) continue;
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    rows.push({
      date,
      o: quote.open?.[i]  ?? c,
      h: quote.high?.[i]  ?? c,
      l: quote.low?.[i]   ?? c,
      c,
      v: quote.volume?.[i] ?? 0,
    });
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : 1));
}

