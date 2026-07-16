/**
 * build-snapshot.mjs — 日次バッチのメイン処理
 * ----------------------------------------------------------------------------
 * 実行順序:
 *   1. J-Quants 認証
 *   2. 日本株ユニバースの取得(株価5年 + 財務情報)
 *   3. 米国株ユニバースの取得(Stooq株価 + GAS/GOOGLEFINANCE現在値)
 *   4. ユニバース横断の派生値(ベータ・サイズ順位)を計算
 *   5. 本日時点のスクリーニング(runScreen)・合流判定(強い推薦)
 *   6. 保有銘柄(portfolio.json)の再判定(evaluateHolding)
 *   7. 出力を2ファイルに分割:
 *      - public/data/snapshot.json  … 軽量。ダッシュボード/登録銘柄/保有銘柄用
 *      - public/data/history.json   … 重量。デモ運用(バックテスト)タブ専用、遅延ロード
 *
 * 実行方法:
 *   JQUANTS_API_KEY=xxx GAS_US_STOCK_PROXY_URL=xxx node batch/build-snapshot.mjs
 *
 * ■ 未検証の注意
 *   ネットワーク制限のあるサンドボックスで開発したため、J-Quants / Stooq / GAS
 *   への実際の接続テストができていない。初回実行時は必ず batch/jquants.mjs の
 *   selfTest() を先に走らせ、疎通を確認すること。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JQuantsClient } from "./jquants.mjs";
import { buildStockEntry } from "./compute-features-jp.mjs";
import { fetchStooqHistory } from "./stooq.mjs";
import { buildUsStockEntry, fetchGasFundamentals } from "./compute-features-us.mjs";
import { STRATEGIES, runScreen, evaluateHolding, featuresAt, JP_NAMES, US_NAMES, TECH_CURRENT_KEYS } from "../logic.mjs";

/* ■ TECH_CURRENT_KEYS について(重大バグの記録):
   以前、実データパスではテクニカル指標(rs, vcp, rvol, mom12_1 等)が
   一切計算されておらず、モメンタム/テクニカル系の全手法が実データで
   全滅するバグがあった。デモ(genUniverse)は乱数で値を持っていたため、
   デモでは症状が出ず発見が遅れた。現在はデモも実データも同じ
   featuresAt() + TECH_CURRENT_KEYS(logic.mjs で一元管理)で計算する。 */

/** 全銘柄の「本日時点のテクニカル値」を history から計算して書き戻す。 */
function attachCurrentTechnicals(universe) {
  for (const s of universe) {
    const f = featuresAt(s, s.history.length - 1);
    if (!f) continue;
    for (const k of TECH_CURRENT_KEYS) s[k] = f[k];
  }
}

/** 業種グループ相対力: 業種ごとの60日平均リターンを市場内で順位化(0-1)し、
 *  所属銘柄全員に付与する。featuresAt 内の自己リターン近似より正確な
 *  「本日時点」の値として上書きする。 */
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

/** 株主優待銘柄リスト(任意・手動管理)。batch/yutai-jp.json に
 *  ["7203", "8591", ...] の形式で置くと、権利取り系手法のスコアが強化される。
 *  無料の構造化データが存在しないため手動管理(DATA_LIMITATIONS.md 参照)。 */
function loadYutaiSet() {
  const p = path.join(__dirname, "yutai-jp.json");
  if (!fs.existsSync(p)) return null;
  try {
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    console.log(`  株主優待リスト: ${arr.length} 銘柄を読み込み`);
    return new Set(arr.map(String));
  } catch (e) {
    console.warn(`  [警告] yutai-jp.json の読み込みに失敗: ${e.message}`);
    return null;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "public", "data");
const DASH_HISTORY_DAYS = 300; // 軽量版に残す直近日数(チャート表示に必要な分だけ)

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** ユニバースリストの読み込み。カスタムリストがあればそちらを優先。 */
function loadUniverseList(marketFile, fallback) {
  const p = path.join(__dirname, marketFile);
  if (fs.existsSync(p)) {
    console.log(`  カスタムユニバース ${marketFile} を使用`);
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  console.log(`  デフォルトユニバース(logic.mjs の名称リスト)を使用: ${fallback.length}銘柄`);
  return fallback;
}

async function buildJpUniverse(client, list, yutaiSet) {
  const to = today();
  const from = new Date(Date.now() - 5 * 365 * 86400_000).toISOString().slice(0, 10); // Light plan上限=5年
  const out = [];
  let i = 0;
  for (const [code, name, sector] of list) {
    i++;
    process.stdout.write(`  [JP ${i}/${list.length}] ${code} ${name} ... `);
    try {
      const [quotes, statements] = await Promise.all([
        client.dailyQuotesByCode(code, from, to),
        client.statements(code),
      ]);
      const entry = buildStockEntry({ Code: code, CompanyName: name, Sector33CodeName: sector }, quotes, statements, { yutaiSet });
      if (entry) { out.push(entry); console.log(`OK (${entry.history.length}日)`); }
      else console.log("SKIP (履歴不足)");
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
    }
    // API負荷を抑えるための簡易ウェイト(公式のレート制限値が非公開のため保守的に)
    await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}

async function buildUsUniverse(list, gasProxyUrl) {
  const tickers = list.map(([t]) => t);
  let gasData = new Map();
  if (gasProxyUrl) {
    console.log("  GASプロキシから現在値・簡易ファンダメンタルを取得中...");
    try {
      gasData = await fetchGasFundamentals(gasProxyUrl, tickers);
      console.log(`  OK: ${gasData.size}/${tickers.length} 銘柄取得`);
    } catch (e) {
      console.warn(`  [警告] GASプロキシ取得失敗: ${e.message}。現在値は Stooq 終値で代替します。`);
    }
  } else {
    console.warn("  [警告] GAS_US_STOCK_PROXY_URL 未設定。PER・配当利回り等は取得されません(価格・出来高系の手法のみ動作します)。");
  }

  const out = [];
  let i = 0;
  for (const [ticker, name, sector] of list) {
    i++;
    process.stdout.write(`  [US ${i}/${list.length}] ${ticker} ${name} ... `);
    try {
      const hist = await fetchStooqHistory(ticker);
      const entry = buildUsStockEntry({ ticker, name, sector }, hist, gasData.get(ticker));
      if (entry) { out.push(entry); console.log(`OK (${entry.history.length}日)`); }
      else console.log("SKIP (履歴不足)");
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // Stooq は無料サービスのため特に控えめに
  }
  return out;
}

/**
 * ベータ(市場感応度)を計算する。TOPIX/S&P500 の指数データは有料プラン
 * 限定のため、その市場のユニバース自体の等金額加重ポートフォリオを
 * 「市場」の代理として回帰する近似値(DATA_LIMITATIONS.md 参照)。
 */
function attachBeta(universe, market) {
  const pool = universe.filter((s) => s.market === market);
  if (pool.length < 5) return;
  const n = Math.min(...pool.map((s) => s.history.length));
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

function variance(a) { const m = mean(a); return mean(a.map((x) => (x - m) ** 2)); }
function covariance(a, b) { const ma = mean(a), mb = mean(b); return mean(a.map((x, i) => (x - ma) * (b[i] - mb))); }
function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

/** 流動性(売買代金)に基づく市場内の相対サイズ順位(1=最大)。時価総額の代理。 */
function attachSizeDecile(universe, market) {
  const pool = universe.filter((s) => s.market === market).sort((a, b) => b.advDollar - a.advDollar);
  pool.forEach((s, i) => { s.sizeDecile = Math.ceil(((i + 1) / pool.length) * 10); });
}

function loadPortfolio() {
  const p = path.join(ROOT, "portfolio.json");
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function computeStrong(universe, enabled = null) {
  const strong = [];
  for (const market of ["JP", "US"]) {
    const sig = runScreen(universe, market);
    const by = new Map();
    for (const st of STRATEGIES) {
      if (enabled && enabled[st.id] === false) continue;
      for (const h of sig[st.id] || []) {
        if (!h._strong) continue;
        if (!by.has(h.code)) by.set(h.code, { stock: h, confluence: h._confluence, strategies: [] });
        by.get(h.code).strategies.push({ name: st.name, cat: st.cat });
      }
    }
    for (const { stock, confluence, strategies } of by.values()) {
      strong.push({
        stock: {
          code: stock.code, name: stock.name, market: stock.market, sector: stock.sector,
          price: stock.price, per: stock.per, pbr: stock.pbr, roe: stock.roe,
        },
        confluence, strategies,
      });
    }
  }
  return strong.sort((a, b) => b.confluence - a.confluence);
}

function computePortfolioSignals(universe) {
  const holdings = loadPortfolio();
  const out = [];
  for (const h of holdings) {
    const ev = evaluateHolding(h, universe);
    if (!ev.s) continue;
    out.push({
      code: h.code, name: ev.s.name, market: h.market, costBasis: h.costBasis,
      price: ev.s.price, unrealizedPct: ev.unrealizedPct, signal: ev.signal, reason: ev.reason,
    });
  }
  return out;
}

/** 軽量版: 各銘柄の履歴を直近 N 日に切り詰め、fundDaily(バックテスト専用)は削る */
function trimForDashboard(universe) {
  return universe.map((s) => {
    const { fundDaily, history, ...rest } = s;
    return { ...rest, history: history.slice(-DASH_HISTORY_DAYS) };
  });
}

async function main() {
  const jqApiKey = process.env.JQUANTS_API_KEY;
  const gasUrl = process.env.GAS_US_STOCK_PROXY_URL || "";
  if (!jqApiKey) {
    console.error("環境変数 JQUANTS_API_KEY が未設定です。処理を中止します。");
    console.error("J-Quants ダッシュボードの「API Keys」ページから発行してください。");
    process.exit(1);
  }

  console.log("=== 1. J-Quants クライアント初期化(V2はAPIキー方式のためトークン交換不要) ===");
  const client = new JQuantsClient({ apiKey: jqApiKey });
  await client.authenticate();
  console.log("OK");

  console.log("\n=== 2. 日本株ユニバース取得 ===");
  const jpList = loadUniverseList("universe-jp.json", JP_NAMES);
  const yutaiSet = loadYutaiSet();
  const jpUniverse = await buildJpUniverse(client, jpList, yutaiSet);
  console.log(`OK: ${jpUniverse.length}/${jpList.length} 銘柄`);

  console.log("\n=== 3. 米国株ユニバース取得 ===");
  const usList = loadUniverseList("universe-us.json", US_NAMES);
  const usUniverse = await buildUsUniverse(usList, gasUrl);
  console.log(`OK: ${usUniverse.length}/${usList.length} 銘柄`);

  const universe = [...jpUniverse, ...usUniverse];
  if (universe.length === 0) {
    console.error("取得できた銘柄が0件です。認証・ネットワークを確認してください。処理を中止します。");
    process.exit(1);
  }

  console.log("\n=== 4. 派生値の計算(テクニカル現在値・業種相対力・ベータ・サイズ順位) ===");
  attachCurrentTechnicals(universe);          // ← 実データでテクニカル系手法が全滅するバグの修正点
  attachGroupRS(universe, "JP"); attachGroupRS(universe, "US");
  attachBeta(universe, "JP"); attachBeta(universe, "US");
  attachSizeDecile(universe, "JP"); attachSizeDecile(universe, "US");
  console.log("OK");

  console.log("\n=== 5. 本日のスクリーニング・強い推薦の判定 ===");
  const strong = computeStrong(universe);
  console.log(`OK: 強い推薦 ${strong.length} 件`);

  console.log("\n=== 6. 保有銘柄の再判定 ===");
  const portfolio_signals = computePortfolioSignals(universe);
  console.log(`OK: ${portfolio_signals.length} 件を評価(portfolio.json)`);

  console.log("\n=== 7. 出力 ===");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const snapshot = {
    asof: today(),
    regime: computeRegime(universe),
    universe: trimForDashboard(universe),
    strong,
    portfolio_signals,
  };
  fs.writeFileSync(path.join(OUT_DIR, "snapshot.json"), JSON.stringify(snapshot));
  const snapSize = fs.statSync(path.join(OUT_DIR, "snapshot.json")).size;
  console.log(`  snapshot.json: ${(snapSize / 1024 / 1024).toFixed(1)} MB`);

  const history = { asof: today(), universe };
  fs.writeFileSync(path.join(OUT_DIR, "history.json"), JSON.stringify(history));
  const histSize = fs.statSync(path.join(OUT_DIR, "history.json")).size;
  console.log(`  history.json: ${(histSize / 1024 / 1024).toFixed(1)} MB`);

  if (histSize > 40 * 1024 * 1024) {
    console.warn("\n[警告] history.json が40MBを超えています。モバイル回線での読み込みが重くなる可能性があります。");
    console.warn("ユニバースを絞る(universe-jp.json / universe-us.json で銘柄数を減らす)ことを検討してください。");
  }

  console.log("\n完了。");
}

/** 市場レジーム(200日線上か・ブレッドス)。指数データが有料プランのため、
 *  ユニバース平均で代用する近似値。 */
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
      above200: breadth > 0.5,
      breadth,
      label: breadth > 0.55 ? "良好" : breadth > 0.4 ? "中立" : "警戒",
    };
  }
  return out;
}

/* このモジュールがコマンドラインから直接実行された場合のみ main() を走らせる。
   テストコードから import した場合は自動実行されない(関数を個別にテストできる)。 */
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    console.error("バッチ処理が異常終了しました:", e);
    process.exit(1);
  });
}

export {
  main, buildJpUniverse, buildUsUniverse, attachBeta, attachSizeDecile,
  computeStrong, computePortfolioSignals, trimForDashboard, computeRegime,
  loadUniverseList, loadPortfolio,
};
