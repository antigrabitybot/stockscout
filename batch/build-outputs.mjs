/**
 * build-outputs.mjs — ストアから表示用ファイルを計算する
 * ----------------------------------------------------------------------------
 * 入力: store(Google Drive / local に永続化された 5年+α の全データ)
 * 出力:
 *   public/data/snapshot.json … ダッシュボード用(直近300日にトリムした軽量版)
 *   public/data/backtest.json … 事前計算済みバックテスト結果(1年/3年/5年/全期間)
 *
 * ■ 旧設計からの最大の変更点
 *   バックテストはフロントエンド(ブラウザ)で計算していたが、対象が
 *   約1,300銘柄に拡大したため、全履歴をブラウザへ配る方式(history.json)は
 *   廃止した。代わりにこのバッチが毎日サーバー側(GitHub Actions)で計算し、
 *   結果の要約だけを backtest.json として配信する。ブラウザは表示するだけ。
 *
 * ■ 手法の凍結について(ユーザー合意事項)
 *   バックテスト結果を見て手法のスコア条件を後から調整することは、
 *   「答えを見てから問題を作る」こと(カーブフィッティング)に相当する。
 *   手法コードは原則凍結し、データの窓が伸びていくことだけが変化する。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStockEntry } from "./compute-features-jp.mjs";
import { buildUsStockEntry } from "./compute-features-us.mjs";
import { fetchGasFundamentals } from "./compute-features-us.mjs";
import { barToQuote, barToOhlc, loadStore } from "./store.mjs";
import {
  STRATEGIES, runScreen, evaluateHolding, featuresAt, backtest, benchmark,
  TECH_CURRENT_KEYS, CAT,
} from "../logic.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "public", "data");
const DASH_HISTORY_DAYS = 260; // トレンドマークの200日線判定+余裕分。チャート表示は90日
const BT_PERIODS = [1, 3, 5]; // 年。加えて 'all'(全期間) を自動計算

/* ------------------------------------------------- ストア → universe 変換 */

function loadCodeSet(filename, label) {
  const p = path.join(__dirname, filename);
  if (!fs.existsSync(p)) return null;
  try {
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    console.log(`  ${label}: ${arr.length} 銘柄を読み込み`);
    return new Set(arr.map(String));
  } catch (e) {
    console.warn(`  [警告] ${filename} 読み込み失敗: ${e.message}`);
    return null;
  }
}

export function storeToUniverse(store, opts = {}) {
  const universe = [];
  const sets = {
    yutaiSet: opts.yutaiSet ?? loadCodeSet("yutai-jp.json", "株主優待リスト"),
    nikkeiSet: opts.nikkeiSet ?? loadCodeSet("nikkei225-jp.json", "日経225リスト"),
    ownerSet: opts.ownerSet ?? loadCodeSet("owner-managed-jp.json", "オーナー経営リスト"),
  };
  for (const [code, e] of Object.entries(store.jp || {})) {
    const quotes = (e.bars || []).map(barToQuote);
    const entry = buildStockEntry(
      { Code: code, CompanyName: e.name, Sector33CodeName: e.sector,
        ListingDate: e.listingDate, MarketCodeName: e.marketCodeName },
      quotes, e.stmts || [], sets
    );
    if (entry) universe.push(entry);
  }
  for (const [ticker, e] of Object.entries(store.us || {})) {
    const hist = (e.bars || []).map(barToOhlc);
    const entry = buildUsStockEntry({ ticker, name: e.name, sector: e.sector }, hist, opts.gasData?.get(ticker));
    if (entry) universe.push(entry);
  }
  return universe;
}

/* ------------------------------------- 派生値(旧 build-snapshot から移設) */

function attachCurrentTechnicals(universe) {
  for (const s of universe) {
    const f = featuresAt(s, s.history.length - 1);
    if (!f) continue;
    for (const k of TECH_CURRENT_KEYS) s[k] = f[k];
  }
}

function attachGroupRS(universe, market) {
  const pool = universe.filter((s) => s.market === market && s.history.length > 70);
  const bySector = new Map();
  for (const s of pool) {
    const h = s.history;
    const r60 = h[h.length - 1].c / h[h.length - 61].c - 1;
    if (!bySector.has(s.sector)) bySector.set(s.sector, []);
    bySector.get(s.sector).push(r60);
  }
  const sectors = [...bySector.entries()]
    .map(([sec, rets]) => [sec, rets.reduce((a, b) => a + b, 0) / rets.length])
    .sort((a, b) => a[1] - b[1]);
  const rank = new Map(sectors.map(([sec], i) => [sec, sectors.length > 1 ? i / (sectors.length - 1) : 0.5]));
  for (const s of pool) s.groupRS = rank.get(s.sector) ?? 0.5;
}

function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function variance(a) { const m = mean(a); return mean(a.map((x) => (x - m) ** 2)); }
function covariance(a, b) { const ma = mean(a), mb = mean(b); return mean(a.map((x, i) => (x - ma) * (b[i] - mb))); }

function attachBeta(universe, market) {
  const pool = universe.filter((s) => s.market === market);
  if (pool.length < 5) return;
  const n = Math.min(260, Math.min(...pool.map((s) => s.history.length)));
  const mktRet = new Array(n - 1).fill(0);
  for (const s of pool) {
    const h = s.history.slice(-n);
    for (let i = 1; i < n; i++) mktRet[i - 1] += Math.log(h[i].c / h[i - 1].c) / pool.length;
  }
  const mktVar = variance(mktRet);
  for (const s of pool) {
    const h = s.history.slice(-n);
    const ret = [];
    for (let i = 1; i < n; i++) ret.push(Math.log(h[i].c / h[i - 1].c));
    const cov = covariance(ret, mktRet);
    s.beta = mktVar > 0 ? cov / mktVar : 1.0;
  }
}

function attachSizeDecile(universe, market) {
  const pool = universe.filter((s) => s.market === market).sort((a, b) => b.advDollar - a.advDollar);
  pool.forEach((s, i) => { s.sizeDecile = Math.ceil(((i + 1) / pool.length) * 10); });
}

function computeRegime(universe) {
  const out = {};
  for (const market of ["JP", "US"]) {
    const pool = universe.filter((s) => s.market === market);
    if (!pool.length) { out[market] = { above200: true, breadth: 0.5, label: "データなし" }; continue; }
    let above = 0;
    for (const s of pool) {
      const h = s.history;
      const ma200 = mean(h.slice(-200).map((d) => d.c));
      if (h[h.length - 1].c > ma200) above++;
    }
    const breadth = above / pool.length;
    out[market] = {
      above200: breadth > 0.5, breadth,
      label: breadth > 0.55 ? "良好" : breadth > 0.4 ? "中立" : "警戒",
    };
  }
  return out;
}

function computeStrong(universe) {
  const strong = [];
  for (const market of ["JP", "US"]) {
    const sig = runScreen(universe, market);
    const by = new Map();
    for (const st of STRATEGIES) {
      for (const h of sig[st.id] || []) {
        if (!h._strong) continue;
        if (!by.has(h.code)) by.set(h.code, { stock: h, confluence: h._confluence, strategies: [] });
        by.get(h.code).strategies.push({ name: st.name, cat: st.cat });
      }
    }
    for (const { stock, confluence, strategies } of by.values()) {
      strong.push({
        stock: { code: stock.code, name: stock.name, market: stock.market, sector: stock.sector,
          price: stock.price, per: stock.per, pbr: stock.pbr, roe: stock.roe },
        confluence, strategies,
      });
    }
  }
  return strong.sort((a, b) => b.confluence - a.confluence);
}

function computePortfolioSignals(universe) {
  const p = path.join(ROOT, "portfolio.json");
  if (!fs.existsSync(p)) return [];
  const holdings = JSON.parse(fs.readFileSync(p, "utf8"));
  const out = [];
  for (const h of holdings) {
    const ev = evaluateHolding(h, universe);
    if (!ev.s) continue;
    out.push({ code: h.code, name: ev.s.name, market: h.market, costBasis: h.costBasis,
      price: ev.s.price, unrealizedPct: ev.unrealizedPct, signal: ev.signal, reason: ev.reason });
  }
  return out;
}

/** 軽量版: 各銘柄の履歴を直近 N 日に切り詰め、fundDaily(バックテスト専用)は削る。
 *  さらに履歴を「キー付きオブジェクトの配列」から「数値だけの配列の配列」
 *  [[o,h,l,c,v], ...] に変換し、価格は小数1桁・出来高は整数に丸める。
 *  理由: 実規模(約1,300銘柄)ではオブジェクト形式の snapshot.json が40MBを
 *  超え、スマホでの日常閲覧に耐えないため。この圧縮で約1/3になる。
 *  フロントエンド(DATA_SOURCE.load)が読み込み時にオブジェクト形式へ復元する。 */
function trimForDashboard(universe) {
  return universe.map((s) => {
    const { fundDaily, history, ...rest } = s;
    const hc = history.slice(-DASH_HISTORY_DAYS).map((d) => [
      Math.round(d.o * 10) / 10, Math.round(d.h * 10) / 10,
      Math.round(d.l * 10) / 10, Math.round(d.c * 10) / 10,
      Math.round(d.v),
    ]);
    return { ...rest, historyC: hc };
  });
}

/* ------------------------------------------------- 事前計算バックテスト */

function downsampleCurve(curve, maxPts = 160) {
  if (curve.length <= maxPts) return curve;
  const step = Math.ceil(curve.length / maxPts);
  const out = curve.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== curve[curve.length - 1]) out.push(curve[curve.length - 1]);
  return out;
}

export function computeBacktests(universe) {
  const result = { computedAt: new Date().toISOString().slice(0, 10), markets: {} };
  for (const market of ["JP", "US"]) {
    const pool = universe.filter((s) => s.market === market);
    if (pool.length < 5) continue;
    const maxYears = Math.floor((Math.min(...pool.map((s) => s.history.length)) - 270) / 252 * 10) / 10;
    const periods = [...BT_PERIODS.filter((y) => y <= maxYears), maxYears].filter((v, i, a) => v > 0.3 && a.indexOf(v) === i);
    result.markets[market] = { maxYears, periods: {} };
    for (const years of periods) {
      const label = years === maxYears ? "all" : String(years);
      console.log(`  [backtest] ${market} ${label === "all" ? "全期間" : years + "年"} を計算中...`);
      const t0 = Date.now();
      const bm = benchmark(universe, market, years);
      const rows = [];
      for (const st of STRATEGIES) {
        if (!st.markets.includes(market)) continue;
        const bt = backtest(universe, market, st, years);
        if (!bt) continue;
        rows.push({
          stId: st.id, name: st.name, cat: st.cat,
          final: Math.round(bt.final), cagr: bt.cagr, maxDD: bt.maxDD,
          n: bt.n, winRate: bt.winRate, avgR: bt.avgR,
          pf: isFinite(bt.pf) ? bt.pf : null, avgDays: Math.round(bt.avgDays),
          curve: null, // 上位のみ後で付与
          _rawCurve: bt.curve,
        });
      }
      rows.sort((a, b) => b.cagr - a.cagr);
      rows.forEach((r, i) => { if (i < 5) r.curve = downsampleCurve(r._rawCurve); delete r._rawCurve; });
      result.markets[market].periods[label] = {
        years,
        bm: { final: Math.round(bm.final), cagr: bm.cagr, maxDD: bm.maxDD, curve: downsampleCurve(bm.curve) },
        rows,
      };
      console.log(`    ${rows.length}手法 / ${(Date.now() - t0) / 1000 | 0}秒`);
    }
  }
  return result;
}

/* ----------------------------------------------------------------- 本体 */

export async function buildOutputs(store) {
  /* daily-update.mjs からは更新済みストアを引数で受け取る。
     単体実行(node batch/build-outputs.mjs)時は引数が無いので、
     ここで自分でストアを読み込む。 */
  if (!store) {
    console.log("  ストアを読み込み中(単体実行モード)...");
    store = await loadStore();
  }
  if (!store || (!store.jp && !store.us)) {
    throw new Error("ストアが空か不正です。先に backfill.mjs を実行してください。");
  }
  console.log("  universe を構築中...");
  let gasData = null;
  const gasUrl = process.env.GAS_US_STOCK_PROXY_URL;
  if (gasUrl) {
    try {
      gasData = await fetchGasFundamentals(gasUrl, Object.keys(store.us || {}));
      console.log(`  GAS: ${gasData.size} 銘柄の現在値を取得`);
    } catch (e) { console.warn(`  [警告] GAS取得失敗: ${e.message}`); }
  }
  const universe = storeToUniverse(store, { gasData });
  console.log(`  universe: ${universe.length} 銘柄`);

  console.log("  派生値を計算中...");
  attachCurrentTechnicals(universe);
  attachGroupRS(universe, "JP"); attachGroupRS(universe, "US");
  attachBeta(universe, "JP"); attachBeta(universe, "US");
  attachSizeDecile(universe, "JP"); attachSizeDecile(universe, "US");

  console.log("  スクリーニング・強い推薦を計算中...");
  const strong = computeStrong(universe);
  const portfolio_signals = computePortfolioSignals(universe);

  console.log("  バックテストを事前計算中(数分かかります)...");
  const backtests = computeBacktests(universe);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const snapshot = {
    asof: store.updatedAt || new Date().toISOString().slice(0, 10),
    regime: computeRegime(universe),
    universe: trimForDashboard(universe),
    strong, portfolio_signals,
  };
  fs.writeFileSync(path.join(OUT_DIR, "snapshot.json"), JSON.stringify(snapshot));
  fs.writeFileSync(path.join(OUT_DIR, "backtest.json"), JSON.stringify(backtests));
  const s1 = fs.statSync(path.join(OUT_DIR, "snapshot.json")).size / 1024 / 1024;
  const s2 = fs.statSync(path.join(OUT_DIR, "backtest.json")).size / 1024 / 1024;
  console.log(`  snapshot.json: ${s1.toFixed(1)} MB / backtest.json: ${s2.toFixed(1)} MB`);
  if (s1 > 25) {
    console.warn("  [警告] snapshot.json が25MBを超えています。DASH_HISTORY_DAYS の削減か銘柄数の見直しを検討してください。");
  }
  return { snapshot, backtests };
}

/* 単体実行用エントリポイント。`node batch/build-outputs.mjs` で
   ストアから snapshot.json / backtest.json を再生成する(取得はしない)。 */
if (import.meta.url === `file://${process.argv[1]}`) {
  buildOutputs().then(() => console.log("\n出力の再生成 完了。")).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
