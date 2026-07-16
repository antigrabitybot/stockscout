/**
 * compute-features-us.mjs
 * ----------------------------------------------------------------------------
 * Stooq(ヒストリカル) + GAS/GOOGLEFINANCE(現在値・簡易ファンダメンタル)を
 * 統合し、logic.mjs 互換の universe エントリを作る。
 *
 * 日本株より取得できる財務データが薄いことを正直に反映する。
 * ROE・ROIC・営業CF等は null のままにし、該当手法は自然に0件になる。
 * 詳しくは ../DATA_LIMITATIONS.md 参照。
 */

export function buildUsStockEntry(meta, stooqHistory, gasFundamental) {
  if (!stooqHistory || stooqHistory.length < 260) return null;

  const history = stooqHistory.map((r) => ({ o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
  const last = history[history.length - 1];
  const price = gasFundamental?.price ?? last.c;

  const atr = avgTrueRange(history.slice(-30));
  const len = history.length;

  // 米国株は財務の時系列を持たないため、fundDaily は「現在値を全期間に forward-fill」
  // した簡易版とする。バックテストで過去のPER等を正確に遡ることはできない
  // (これは近似ではなく「明確に不正確」なので、米国株のバリュー系バックテストは
  //  参考程度に留めること。DATA_LIMITATIONS.md に明記済み)。
  const per = gasFundamental?.per ?? null;
  const divYield = gasFundamental?.divYield ?? null;
  const keys = ["per", "pbr", "roe", "fcfYield", "divYield", "payout", "roic",
    "evEbitda", "fscore", "grossProf", "accrual", "epsGrowthQ", "epsGrowthY",
    "earnYield", "psr", "peg", "altmanZ", "ncavRatio", "streak", "roeYears",
    "salesAccel", "opAccel", "earnStability", "sizeDecile", "opMarginTrend"];
  const fundDaily = {};
  for (const k of keys) fundDaily[k] = new Array(len).fill(null);
  // 現在値だけ埋める(過去は不明なため null のまま = 遡ったバックテストではスクリーニング対象外になる)
  fundDaily.per[len - 1] = per;
  fundDaily.divYield[len - 1] = divYield;
  fundDaily.earnYield[len - 1] = per ? 1 / per : null;

  return {
    code: meta.ticker,
    name: meta.name,
    sector: meta.sector || "",
    market: "US",
    price,
    atr,
    history,
    fundDaily,
    per, pbr: null, roe: null, roic: null, fcfYield: null, evEbitda: null,
    divYield, payout: null, earnYield: per ? 1 / per : null,
    psr: null, peg: null, fscore: null, accrual: null,
    epsGrowthQ: null, epsGrowthY: null, streak: 0, roeYears: 0,
    salesAccel: 0, opAccel: 0, earnStability: null, opMarginTrend: 0,
    grossProf: null, altmanZ: null, ncavRatio: null,
    buybackPct: 0, daysSinceBuyback: 999, divHike: false, daysSinceDivHike: 999,
    splitAnnounced: false, daysSinceSplit: 999,
    epsSurprise: 0, postEarnGap: 0, daysSinceEarnings: 999,
    advDollar: last.v * price,
    market_advDollarFloor: 2e7,
    isBio: /Healthcare/.test(meta.sector || ""),
    beta: gasFundamental?.beta ?? null,
    sizeDecile: null,
  };
}

function avgTrueRange(recent) {
  if (recent.length < 2) return recent[0]?.c * 0.02 || 1;
  let sum = 0, n = 0;
  for (let i = 1; i < recent.length; i++) {
    const tr = Math.max(
      recent[i].h - recent[i].l,
      Math.abs(recent[i].h - recent[i - 1].c),
      Math.abs(recent[i].l - recent[i - 1].c)
    );
    sum += tr; n++;
  }
  return n ? sum / n : recent[recent.length - 1].c * 0.02;
}

/** GAS プロキシを呼び出す(20銘柄ずつに分割してリクエスト) */
export async function fetchGasFundamentals(proxyUrl, tickers) {
  const chunks = [];
  for (let i = 0; i < tickers.length; i += 20) chunks.push(tickers.slice(i, i + 20));
  const out = new Map();
  for (const chunk of chunks) {
    const url = `${proxyUrl}?tickers=${chunk.join(",")}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  [警告] GASプロキシ取得失敗: HTTP ${res.status}. これらの銘柄は現在値のみ Stooq 終値で代替します。`);
      continue;
    }
    const json = await res.json();
    for (const row of json.data || []) out.set(row.ticker, row);
  }
  return out;
}
