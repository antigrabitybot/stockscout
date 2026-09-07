/**
 * 日次フォワードテスト。
 *
 * シグナル日の終値を見て候補を記録し、翌営業日の始値で約定する。
 * 同じ手法・銘柄の未決済レコードは重複作成しない。状態は価格ストア内に
 * 保存し、公開JSONには集計値だけを出す。
 */
import { STRATEGIES, plan, featuresAt, BT } from "../logic.mjs";

const VERSION = 1;

function emptyStats() {
  return {
    closedCount: 0, wins: 0, sumR: 0, grossProfitR: 0, grossLossR: 0,
    equity: 1, peak: 1, maxDD: 0,
  };
}

function strategyState(state, market, stId) {
  state.markets ||= {};
  state.markets[market] ||= { lastProcessedAt: null, strategies: {} };
  return state.markets[market].strategies[stId] ||= {
    pending: [], open: [], stats: emptyStats(),
  };
}

function barOn(stock, date) {
  const i = stock.history.findIndex((bar) => bar.date === date);
  return i < 0 ? null : { bar: stock.history[i], index: i };
}

function closePosition(ss, position, px, date, reason) {
  const pnlPerShare = px - position.entry - position.entry * BT.cost;
  const r = pnlPerShare / position.initialR;
  const stats = ss.stats ||= emptyStats();
  stats.closedCount++;
  stats.sumR += r;
  if (r > 0) { stats.wins++; stats.grossProfitR += r; }
  else stats.grossLossR += Math.abs(r);
  stats.equity *= Math.max(0.01, 1 + BT.riskPct * r);
  stats.peak = Math.max(stats.peak, stats.equity);
  stats.maxDD = Math.min(stats.maxDD, stats.equity / stats.peak - 1);
  ss.recentClosed ||= [];
  ss.recentClosed.push({
    code: position.code, name: position.name, signalDate: position.signalDate,
    entryDate: position.entryDate, exitDate: date, entry: position.entry,
    exit: px, r, days: position.days, reason,
  });
  if (ss.recentClosed.length > 30) ss.recentClosed.splice(0, ss.recentClosed.length - 30);
}

/** 1市場・1営業日を進める。テストからも直接呼べる純粋な日次処理。 */
export function advanceForwardTestDay(state, market, date, stocks, strategies = STRATEGIES) {
  const byCode = new Map(stocks.map((s) => [s.code, s]));

  for (const st of strategies.filter((s) => s.markets.includes(market))) {
    const ss = strategyState(state, market, st.id);

    // 前営業日に確定した候補を、当日の始値で約定する。
    const stillPending = [];
    for (const pending of ss.pending) {
      const stock = byCode.get(pending.code);
      const found = stock && barOn(stock, date);
      if (!found) { stillPending.push(pending); continue; }
      const entry = found.bar.o;
      const p = plan({ ...stock, price: entry }, st);
      const initialR = entry - p.stop;
      if (!(entry > 0 && initialR > 0)) continue;
      ss.open.push({
        code: stock.code, name: stock.name, signalDate: pending.signalDate,
        entryDate: date, entry, stop: p.stop, target: p.target,
        initialR, days: 0,
      });
    }
    ss.pending = stillPending;

    // 当日の値動きで、保有中レコードの損切り・利確・トレンド転換を判定する。
    const survivors = [];
    for (const position of ss.open) {
      const stock = byCode.get(position.code);
      const found = stock && barOn(stock, date);
      if (!found) { survivors.push(position); continue; }
      const { bar, index } = found;
      position.days++;
      let exit = null;
      let px = null;
      if (bar.l <= position.stop) {
        exit = "損切り";
        px = Math.min(position.stop, bar.o);
      } else if (bar.h >= position.target) {
        exit = "利確";
        px = position.target;
      } else {
        const trailN = st.horizon === "swing" ? 10 : st.horizon === "mid" ? 50 : 200;
        if (position.days > trailN && index + 1 >= trailN) {
          const window = stock.history.slice(index - trailN + 1, index + 1);
          const movingAverage = window.reduce((sum, x) => sum + x.c, 0) / window.length;
          if (bar.c < movingAverage) { exit = "トレンド転換"; px = bar.c; }
        }
        if (!exit && bar.c > position.entry + position.initialR && position.stop < position.entry) {
          position.stop = position.entry;
        }
      }
      if (exit) closePosition(ss, position, px, date, exit);
      else survivors.push(position);
    }
    ss.open = survivors;

    // 当日終値時点の推薦を記録。翌営業日まで価格は確定させない。
    const activeCodes = new Set([...ss.open, ...ss.pending].map((x) => x.code));
    const candidates = [];
    for (const stock of stocks) {
      if (stock.market !== market || activeCodes.has(stock.code)) continue;
      const found = barOn(stock, date);
      if (!found) continue;
      let view = featuresAt(stock, found.index);
      // 計測開始時点の軽量データが260本しかない場合でも、最新日のために
      // buildStockEntry が計算済みの現在値を利用できる。
      if (!view && found.index === stock.history.length - 1) view = stock;
      if (!view) continue;
      let score = null;
      try { score = st.score(view); } catch { score = null; }
      if (score == null || !Number.isFinite(score) || score <= 0) continue;
      candidates.push({ code: stock.code, name: stock.name, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    ss.pending.push(...candidates.slice(0, 8).map((x) => ({ ...x, signalDate: date })));
  }

  state.markets[market].lastProcessedAt = date;
}

function marketDates(universe, market) {
  const dates = new Set();
  for (const stock of universe) {
    if (stock.market !== market) continue;
    for (const bar of stock.history) if (bar.date) dates.add(bar.date);
  }
  return [...dates].sort();
}

export function updateForwardTests(store, universe) {
  const state = store.forwardTest ||= { version: VERSION, startedAt: null, markets: {} };
  if (state.version !== VERSION) throw new Error(`未対応の forwardTest version: ${state.version}`);

  for (const market of ["JP", "US"]) {
    const dates = marketDates(universe, market);
    if (!dates.length) continue;
    const latest = dates[dates.length - 1];
    const marketState = state.markets?.[market];
    // 初回は過去を後付けで「フォワード」と偽装せず、最新日から計測を始める。
    const toProcess = marketState?.lastProcessedAt
      ? dates.filter((d) => d > marketState.lastProcessedAt)
      : [latest];
    for (const date of toProcess) advanceForwardTestDay(state, market, date, universe);
    state.startedAt ||= toProcess[0] || latest;
  }
  return summarizeForwardTests(state);
}

export function summarizeForwardTests(state) {
  const out = { computedAt: new Date().toISOString().slice(0, 10), startedAt: state.startedAt, markets: {} };
  for (const [market, marketState] of Object.entries(state.markets || {})) {
    const strategies = {};
    for (const [stId, ss] of Object.entries(marketState.strategies || {})) {
      const s = ss.stats || emptyStats();
      strategies[stId] = {
        closedCount: s.closedCount,
        activeCount: (ss.open || []).length,
        pendingCount: (ss.pending || []).length,
        winRate: s.closedCount ? s.wins / s.closedCount : null,
        avgR: s.closedCount ? s.sumR / s.closedCount : null,
        pf: s.grossLossR > 0 ? s.grossProfitR / s.grossLossR : (s.grossProfitR > 0 ? null : 0),
        pfInfinite: s.grossLossR === 0 && s.grossProfitR > 0,
        maxDD: s.maxDD,
      };
    }
    out.markets[market] = { asof: marketState.lastProcessedAt, strategies };
  }
  return out;
}

