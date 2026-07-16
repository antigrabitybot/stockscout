/**
 * compute-features-jp.mjs
 * ----------------------------------------------------------------------------
 * J-Quants の生データ(株価四本値 + 財務情報サマリー)を、logic.mjs が
 * 前提とする universe の1要素の形(history[], fundDaily{}, 現在値の各フィールド)
 * へ変換する。
 *
 * ここが Look-ahead bias を防ぐ最後の砦。DisclosedDate より前の日に、
 * その財務情報を参照させてはいけない。
 *
 * どの指標が正確で、どれが近似かは ../DATA_LIMITATIONS.md を必ず参照。
 */

const TRADING_DAYS_PER_YEAR = 252;

/** 数値化。J-Quants は数値を文字列で返すフィールドが多い(空文字はデータなし)。 */
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 株価四本値の配列(J-Quants の daily_quotes、1銘柄分)を、
 * logic.mjs が期待する history[] (昇順・調整済みOHLCV) に変換する。
 */
export function buildHistory(quotes) {
  const rows = quotes
    .filter((q) => q.AdjustmentClose != null && q.Volume != null)
    .sort((a, b) => (a.Date < b.Date ? -1 : 1));
  return rows.map((q) => ({
    date: q.Date,
    o: num(q.AdjustmentOpen),
    h: num(q.AdjustmentHigh),
    l: num(q.AdjustmentLow),
    c: num(q.AdjustmentClose),
    v: num(q.AdjustmentVolume) || 0,
  }));
}

/**
 * 財務情報(statements、DisclosedDate つき)を DisclosedDate 昇順に整理する。
 * 同日に複数開示がある場合(訂正等)は DisclosureNumber が大きい方(=新しい方)を残す。
 */
function sortStatements(statements) {
  const byDate = new Map();
  for (const s of statements) {
    const key = s.DisclosedDate;
    const prev = byDate.get(key);
    if (!prev || Number(s.DisclosureNumber) > Number(prev.DisclosureNumber)) {
      byDate.set(key, s);
    }
  }
  return [...byDate.values()].sort((a, b) => (a.DisclosedDate < b.DisclosedDate ? -1 : 1));
}

/**
 * 1件の statement から、当面必要な生の財務数値を取り出す。
 * 単位は円(J-Quants の生値のまま)。
 */
function extractRaw(s) {
  const eps = num(s.EarningsPerShare);
  const bps = num(s.BookValuePerShare);
  const sales = num(s.NetSales);
  const op = num(s.OperatingProfit);
  const ni = num(s.Profit);
  const equity = num(s.Equity);
  const assets = num(s.TotalAssets);
  const equityRatio = num(s.EquityToAssetRatio);
  const ocf = num(s.CashFlowsFromOperatingActivities);
  const cash = num(s.CashAndEquivalents);
  const divFcst = num(s.ForecastDividendPerShareAnnual);
  return {
    disclosedDate: s.DisclosedDate,
    typeOfPeriod: s.TypeOfCurrentPeriod, // "1Q"/"2Q"/"3Q"/"FY"
    fyEnd: s.CurrentFiscalYearEndDate,
    eps, bps, sales, op, ni, equity, assets, equityRatio, ocf, cash, divFcst,
  };
}

/**
 * point-in-time の財務指標配列(fundDaily)を構築する。
 * history の各日について「その日以前で最新の開示」の値から指標を導出し、forward-fill する。
 *
 * 導出できない指標(true grossProf, altmanZ, ncavRatio 等)は null を返す。
 * strategies の score() は null を「条件不成立」として扱うため、
 * 該当手法は自然に「0件」になる(捏造して数値を出すより正直な挙動)。
 */
export function buildFundDaily(history, rawStatements) {
  const stmts = sortStatements(rawStatements).map(extractRaw);
  const len = history.length;
  const keys = ["per", "pbr", "roe", "fcfYield", "divYield", "payout", "roic",
    "evEbitda", "fscore", "grossProf", "accrual", "epsGrowthQ", "epsGrowthY",
    "earnYield", "psr", "peg", "altmanZ", "ncavRatio", "streak", "roeYears",
    "salesAccel", "opAccel", "earnStability", "sizeDecile", "opMarginTrend",
    "turnaround", "daysToRights", "daysSinceRights", "earningsInDays"];
  const out = {};
  for (const k of keys) out[k] = new Array(len).fill(null);

  /* --- 権利確定日・決算発表日の推定 ---
     権利確定日: 大半の日本企業は「事業年度末 = 権利確定日」。
       CurrentFiscalYearEndDate の月末(および多くの会社の中間配当=期央月末)を
       権利確定日とみなす。厳密な権利付き最終日(2営業日前)との数日のズレは
       ある(近似であることを DATA_LIMITATIONS.md に明記)。
     決算発表日: 「昨年の同じ会計期間の開示日 + 365日」で推定。
       日本企業の決算発表日は毎年ほぼ同時期に固定される慣行があるため、
       ±1週間程度の精度で当たる。確定情報ではなく推定であることを
       UI側でも「推定」と明示している。 */
  const rightsDates = deriveRightsDates(stmts);
  const nextEarnEstimate = buildEarningsEstimator(stmts);

  let si = -1; // stmts のうち「これまでに開示済み」の最後のインデックス
  // 直近4開示(YoY比較・トレンド判定用)を保持
  const hist4 = [];

  for (let i = 0; i < len; i++) {
    const date = history[i].date;
    while (si + 1 < stmts.length && stmts[si + 1].disclosedDate <= date) {
      si++;
      hist4.push(stmts[si]);
      if (hist4.length > 8) hist4.shift(); // 直近8開示分(≒2年)保持すれば十分
    }
    if (si < 0) continue; // まだ財務情報が1件も開示されていない期間

    const cur = stmts[si];
    const price = history[i].c;

    // --- 正確に計算できるもの ---
    if (cur.eps) out.per[i] = price / cur.eps;
    if (cur.bps) out.pbr[i] = price / cur.bps;
    if (cur.ni && cur.equity) out.roe[i] = cur.ni / cur.equity;
    if (cur.divFcst != null) out.divYield[i] = cur.divFcst / price;
    if (cur.eps && cur.divFcst != null && cur.eps > 0) out.payout[i] = cur.divFcst / cur.eps;
    if (cur.eps) out.earnYield[i] = cur.eps / price;

    // --- 近似(DATA_LIMITATIONS.md 参照) ---
    // FCF利回り→営業CF利回り(CapEx取得不可のため)
    if (cur.ocf && cur.ni && cur.eps) {
      const ocfPerShare = cur.eps * (cur.ocf / cur.ni); // per-share変換(発行株数不要のトリック)
      out.fcfYield[i] = ocfPerShare / price;
    }
    // EV/EBITDA → EV/EBIT近似(減価償却費取得不可のため。現金のみ考慮し負債は無視)
    if (cur.eps && cur.ni && cur.op && cur.cash) {
      const cashPerShare = cur.eps * (cur.cash / cur.ni);
      const ebitPerShare = cur.eps * (cur.op / cur.ni);
      if (ebitPerShare > 0) out.evEbitda[i] = (price - cashPerShare) / ebitPerShare;
    }
    // ROIC → 有利子負債を無視した近似(自己資本ベースの税引後営業利益率)
    if (cur.op && cur.equity) out.roic[i] = (cur.op * 0.7) / cur.equity;
    // PSR = PER × 純利益率 (発行株数が約分されるため、この恒等式は近似ではなく厳密に成立する)
    if (cur.eps && cur.ni && cur.sales && cur.sales > 0) {
      out.psr[i] = (price / cur.eps) * (cur.ni / cur.sales);
    }
    // PEG = PER / 年間EPS成長率
    const yoy = findYoY(hist4, cur);
    if (yoy) {
      out.epsGrowthY[i] = yoy.epsGrowth;
      if (out.per[i] && yoy.epsGrowth > 0) out.peg[i] = out.per[i] / (yoy.epsGrowth * 100);
      out.salesAccel[i] = yoy.salesAccel;
      out.opAccel[i] = yoy.opAccel;
    }
    const qoq = findQoQ(hist4, cur);
    if (qoq) out.epsGrowthQ[i] = qoq.epsGrowth;

    // 簡易版 Piotroski(6項目版。貸借対照表明細が必要な3項目は除外。DATA_LIMITATIONS.md 参照)
    out.fscore[i] = simplifiedFscore(hist4, cur);

    // 会計発生高アノマリー: (純利益 - 営業CF) / 総資産
    if (cur.ni != null && cur.ocf != null && cur.assets) {
      out.accrual[i] = (cur.ni - cur.ocf) / cur.assets;
    }

    // 業績安定性・継続性・ROE年数(直近開示の履歴から算出)
    const streaks = computeStreaks(hist4);
    out.streak[i] = streaks.streak;
    out.roeYears[i] = streaks.roeYears;
    out.earnStability[i] = streaks.stability;
    out.opMarginTrend[i] = streaks.opMarginTrend;

    // 黒字転換: 直近通期が黒字 かつ その前の通期が赤字
    out.turnaround[i] = streaks.turnaround ? 1 : 0;

    // 権利確定日までの/からの営業日数(暦日÷1.4で営業日換算の近似)
    const dNow = new Date(date);
    const nextRights = rightsDates.find((rd) => rd >= dNow);
    const prevRights = [...rightsDates].reverse().find((rd) => rd < dNow);
    if (nextRights) out.daysToRights[i] = Math.round((nextRights - dNow) / 86400_000 / 1.4);
    if (prevRights) out.daysSinceRights[i] = Math.round((dNow - prevRights) / 86400_000 / 1.4);

    // 次回決算発表までの推定営業日数
    const nextEarn = nextEarnEstimate(dNow);
    if (nextEarn) out.earningsInDays[i] = Math.round((nextEarn - dNow) / 86400_000 / 1.4);

    // --- 当面 null のまま(データ不可。手法は自然に0件になる) ---
    // grossProf, altmanZ, ncavRatio, sizeDecile(時価総額の母集団内順位。ユニバース側で別途計算)
  }
  return out;
}

/** 同じ会計期間(1Q/2Q/3Q/FY)の前年同期と比較して成長率を出す */
function findYoY(hist4, cur) {
  // 直近1年前後、同じ TypeOfCurrentPeriod を持つ開示を探す
  const candidates = hist4.filter((s) => s.typeOfPeriod === cur.typeOfPeriod && s.disclosedDate < cur.disclosedDate);
  if (!candidates.length) return null;
  const prev = candidates[candidates.length - 1]; // 直近の同期
  if (!prev.eps || !cur.eps || !prev.sales || !cur.sales || !prev.op || !cur.op) return null;
  return {
    epsGrowth: cur.eps / prev.eps - 1,
    salesAccel: (cur.sales / prev.sales - 1) - 0.1, // 簡易的な「前期の成長率」との比較の代わりに定数控除(要実データ調整)
    opAccel: (cur.op / prev.op - 1) - 0.1,
  };
}

/** 直前の開示(前四半期)との比較 */
function findQoQ(hist4, cur) {
  const idx = hist4.findIndex((s) => s.disclosedDate === cur.disclosedDate);
  if (idx <= 0) return null;
  const prev = hist4[idx - 1];
  if (!prev.eps || !cur.eps) return null;
  return { epsGrowth: cur.eps / prev.eps - 1 };
}

/**
 * 簡易版 Piotroski Fスコア(6項目、/6 を /9 相当にスケール)。
 * 除外した3項目(流動比率改善・新株発行なし・総資産回転率改善)は
 * 貸借対照表明細(Standard プラン以上)が必要なため計測不可。
 */
function simplifiedFscore(hist4, cur) {
  if (hist4.length < 2) return null;
  const prev = hist4[hist4.length - 2];
  let pts = 0, max = 0;
  const test = (cond) => { max++; if (cond) pts++; };
  test(cur.ni > 0);                                              // ① 当期純利益>0
  test(cur.ocf > 0);                                              // ② 営業CF>0
  if (prev.ni && prev.equity && cur.ni && cur.equity) test(cur.ni / cur.equity > prev.ni / prev.equity); // ③ ROE改善
  test(cur.ocf != null && cur.ni != null && cur.ocf > cur.ni);     // ④ 営業CF>純利益
  if (prev.equityRatio != null && cur.equityRatio != null) test(cur.equityRatio > prev.equityRatio); // ⑤ 自己資本比率改善(レバレッジ低下の代理)
  if (prev.sales && cur.sales) test(cur.sales > prev.sales);       // ⑥ 増収(資産回転率改善の代理)
  return max ? Math.round((pts / max) * 9) : null;
}

/**
 * 権利確定日の一覧を導出する。事業年度末(と、その6ヶ月前=中間配当基準日)の
 * 月末を権利確定日とみなす近似。過去〜今後1年分を返す。
 */
function deriveRightsDates(stmts) {
  const fyEnds = [...new Set(stmts.map((s) => s.fyEnd).filter(Boolean))];
  if (!fyEnds.length) return [];
  const dates = new Set();
  for (const fy of fyEnds) {
    const d = new Date(fy);
    if (isNaN(d)) continue;
    for (let yOff = -5; yOff <= 1; yOff++) {
      const yEnd = endOfMonth(new Date(d.getFullYear() + yOff, d.getMonth(), 1));
      dates.add(+yEnd);
      // 中間配当の基準日(期央月末)
      const mid = endOfMonth(new Date(d.getFullYear() + yOff, d.getMonth() - 6, 1));
      dates.add(+mid);
    }
  }
  return [...dates].sort((a, b) => a - b).map((t) => new Date(t));
}

function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

/**
 * 決算発表日の推定器を作る。「前年の同時期の開示日 + 365日」方式。
 * @returns {(now: Date) => Date | null} 指定日以降で最も近い推定発表日
 */
function buildEarningsEstimator(stmts) {
  const disclosed = stmts.map((s) => new Date(s.disclosedDate)).filter((d) => !isNaN(d));
  return (now) => {
    let best = null;
    for (const d of disclosed) {
      // 過去の各開示日を1年ずつ未来に写像し、now以降で最小のものを探す
      for (let y = 0; y <= 6; y++) {
        const est = new Date(d.getFullYear() + y, d.getMonth(), d.getDate());
        if (est >= now && (!best || est < best)) best = est;
      }
    }
    return best;
  };
}

/** 連続増収増益年数・ROE継続年数・業績安定性(変動係数の逆数)・営業利益率トレンド */
function computeStreaks(hist4) {
  const fyOnly = hist4.filter((s) => s.typeOfPeriod === "FY").sort((a, b) => (a.disclosedDate < b.disclosedDate ? -1 : 1));
  if (fyOnly.length < 2) return { streak: 0, roeYears: 0, stability: null, opMarginTrend: 0, turnaround: false };

  let streak = 0;
  for (let i = fyOnly.length - 1; i > 0; i--) {
    const a = fyOnly[i], b = fyOnly[i - 1];
    if (a.sales > b.sales && a.op > b.op) streak++; else break;
  }
  let roeYears = 0;
  for (let i = fyOnly.length - 1; i >= 0; i--) {
    const s = fyOnly[i];
    if (s.ni && s.equity && s.ni / s.equity > 0.10) roeYears++; else break;
  }
  const margins = fyOnly.filter((s) => s.sales > 0).map((s) => s.op / s.sales);
  let stability = null;
  if (margins.length >= 3) {
    const mean = margins.reduce((a, b) => a + b, 0) / margins.length;
    const variance = margins.reduce((a, b) => a + (b - mean) ** 2, 0) / margins.length;
    const cv = mean !== 0 ? Math.sqrt(variance) / Math.abs(mean) : 1;
    stability = Math.max(0, Math.min(1, 1 - cv));
  }
  let opMarginTrend = 0;
  if (margins.length >= 2) opMarginTrend = margins[margins.length - 1] - margins[margins.length - 2];

  // 黒字転換: 直近通期が黒字 かつ その一つ前の通期が赤字
  const lastFY = fyOnly[fyOnly.length - 1];
  const prevFY = fyOnly[fyOnly.length - 2];
  const turnaround = lastFY?.ni > 0 && prevFY?.ni != null && prevFY.ni < 0;

  return { streak, roeYears, stability, opMarginTrend, turnaround };
}

/**
 * 1銘柄分の J-Quants 生データを、logic.mjs 互換の universe エントリへ変換する。
 * @param {object} meta - listed/info から得た銘柄基本情報
 * @param {array} quotes - daily_quotes(1銘柄分、期間指定取得)
 * @param {array} statements - fins/statements(1銘柄分)
 */
export function buildStockEntry(meta, quotes, statements, opts = {}) {
  const history = buildHistory(quotes);
  if (history.length < 260) return null; // 特徴量計算に必要な最低履歴が無い(新規上場等)

  const fundDaily = buildFundDaily(history, statements);
  const last = history.length - 1;
  const price = history[last].c;

  /* 直近20営業日の平均売買代金(円) — 流動性フィルタ用。
     TurnoverValue フィールドが取得できない/未提供のケースに備え、
     「出来高 × 終値」で代替計算する。これは近似ではなく、売買代金の
     定義そのもの(単価×数量の総和)に対する妥当な概算であり、
     実際に実データで TurnoverValue が undefined で返ってきたことが
     あったため、確実に効くこちらの計算方法を優先する。 */
  const recentTurnover = quotes.slice(-20).reduce((a, q) => {
    const tv = Number(q.TurnoverValue);
    if (Number.isFinite(tv) && tv > 0) return a + tv;
    const vol = Number(q.AdjustmentVolume ?? q.Volume) || 0;
    const px = Number(q.AdjustmentClose ?? q.Close) || 0;
    return a + vol * px;
  }, 0) / Math.min(20, quotes.length);

  // 直近14日ATR(円) — 損切り・利確計算の基礎
  const atr = avgTrueRange(history.slice(-30));

  const sectorName = meta.Sector33CodeName || meta.SectorName || "";

  return {
    code: meta.Code?.slice(0, 4) || meta.Code, // J-Quants は5桁コード(末尾0)を返すことがあるため4桁化
    name: meta.CompanyName,
    sector: sectorName,
    market: "JP",
    price,
    atr,
    history,
    fundDaily,
    // --- 「本日時点」の値。runScreen はこちらを直接参照する ---
    per: lastValid(fundDaily.per), pbr: lastValid(fundDaily.pbr), roe: lastValid(fundDaily.roe),
    roic: lastValid(fundDaily.roic), fcfYield: lastValid(fundDaily.fcfYield),
    evEbitda: lastValid(fundDaily.evEbitda), divYield: lastValid(fundDaily.divYield),
    payout: lastValid(fundDaily.payout), earnYield: lastValid(fundDaily.earnYield),
    psr: lastValid(fundDaily.psr), peg: lastValid(fundDaily.peg),
    fscore: lastValid(fundDaily.fscore), accrual: lastValid(fundDaily.accrual),
    epsGrowthQ: lastValid(fundDaily.epsGrowthQ), epsGrowthY: lastValid(fundDaily.epsGrowthY),
    streak: lastValid(fundDaily.streak) || 0, roeYears: lastValid(fundDaily.roeYears) || 0,
    salesAccel: lastValid(fundDaily.salesAccel) || 0, opAccel: lastValid(fundDaily.opAccel) || 0,
    earnStability: lastValid(fundDaily.earnStability), opMarginTrend: lastValid(fundDaily.opMarginTrend) || 0,
    turnaround: lastValid(fundDaily.turnaround) === 1,
    daysToRights: lastValid(fundDaily.daysToRights),
    daysSinceRights: lastValid(fundDaily.daysSinceRights),
    earningsInDays: lastValid(fundDaily.earningsInDays),
    hasYutai: opts.yutaiSet ? opts.yutaiSet.has(meta.Code?.slice(0, 4) || meta.Code) : false,
    // --- 当面データ源なし(DATA_LIMITATIONS.md 参照)。null のまま=手法が自然に0件になる ---
    grossProf: null, altmanZ: null, ncavRatio: null,
    // --- イベント系(データ源なし。将来 TDnet 連携で埋める) ---
    buybackPct: 0, daysSinceBuyback: 999, divHike: false, daysSinceDivHike: 999,
    splitAnnounced: false, daysSinceSplit: 999,
    epsSurprise: 0, postEarnGap: 0, daysSinceEarnings: 999,
    // --- 流動性・その他 ---
    advDollar: recentTurnover || 0,
    market_advDollarFloor: 3e8,
    isBio: /医薬品/.test(sectorName),
    beta: null, // TOPIX との回帰は build-snapshot.mjs 側でユニバース全体を見て計算
    sizeDecile: null, // 同上(母集団内の相対順位のため)
  };
}

function lastValid(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
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
