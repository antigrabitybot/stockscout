/**
 * backfill.mjs — 初回1回だけ実行する、5年分ヒストリカルの一括取得
 * ----------------------------------------------------------------------------
 * 実行: GitHub Actions の "StockScout Backfill (one-time)" を手動実行するか、
 *       ローカルで:
 *         JQUANTS_API_KEY=... STORE_BACKEND=local node batch/backfill.mjs
 *
 * 所要時間の目安: 約1,300銘柄 × 1.2秒 ≈ 30〜60分。
 * 1回きりの処理なので、時間がかかっても問題ない(ユーザー合意済み)。
 *
 * ■ ユニバース(対象銘柄)の決め方
 *   日本株:
 *     (a) プライム市場のうち、直近営業日の売買代金 上位250銘柄(自動導出)
 *         → 日経225の無料で信頼できる構成リストが存在しないため、
 *           「大型・高流動性」という実質を自動でカバーする代理。日経225と
 *           大部分が重なり、かつ入れ替えメンテナンスが不要。
 *     (b) グロース市場の全銘柄(自動導出、約550銘柄)
 *     (c) batch/nikkei225-jp.json があれば、その銘柄を強制的に追加
 *         (正確な日経225リストを後から手で置けば、それも必ず含まれる)
 *   米国株:
 *     batch/universe-sp500.json (S&P500構成銘柄。GitHub公開データセット
 *     datasets/s-and-p-500-companies から生成済み・503銘柄)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JQuantsClient } from "./jquants.mjs";
import { fetchStooqHistory } from "./stooq.mjs";
import { loadStore, saveStore, emptyStore, appendBars, appendStmts, quoteToBar, stooqToBar } from "./store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRIME_TOP_N = 250;
const FIVE_YEARS_AGO = new Date(Date.now() - 5 * 365 * 86400_000).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);

function loadJsonIfExists(name) {
  const p = path.join(__dirname, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** 日本株ユニバースを自動導出する。 */
export async function resolveJpUniverse(client) {
  console.log("  上場銘柄一覧を取得中...");
  const info = await client.listedInfo();
  const byCode = new Map();
  for (const r of info) {
    const code = String(r.Code ?? "").slice(0, 4);
    if (!code) continue;
    byCode.set(code, {
      code,
      name: r.CompanyName ?? r.CompanyNameEnglish ?? code,
      sector: r.Sector33CodeName ?? "",
      market: r.MarketCodeName ?? "",
      listingDate: r.ListingDate ?? null,
    });
  }
  console.log(`  上場銘柄: ${byCode.size} 件`);

  // 直近営業日の全銘柄出来高から売買代金を推定し、プライム上位を決める
  console.log("  直近営業日の全銘柄株価を取得(売買代金順位の算出用)...");
  let quotes = [];
  for (let back = 1; back <= 7 && quotes.length === 0; back++) {
    const d = new Date(Date.now() - back * 86400_000).toISOString().slice(0, 10);
    try {
      quotes = await client.dailyQuotesByDate(d);
      if (quotes.length) console.log(`  ${d} のデータ ${quotes.length} 件を使用`);
    } catch (e) { /* 休日はデータ無し。翌候補日へ */ }
  }
  if (!quotes.length) throw new Error("直近営業日の株価が取得できませんでした");

  const turnover = new Map();
  for (const q of quotes) {
    const code = String(q.Code ?? "").slice(0, 4);
    const tv = Number(q.TurnoverValue) || (Number(q.AdjustmentClose) * Number(q.AdjustmentVolume)) || 0;
    turnover.set(code, tv);
  }

  const prime = [...byCode.values()].filter((s) => /プライム|Prime/.test(s.market));
  const growth = [...byCode.values()].filter((s) => /グロース|Growth/.test(s.market));
  prime.sort((a, b) => (turnover.get(b.code) || 0) - (turnover.get(a.code) || 0));

  const selected = new Map();
  for (const s of prime.slice(0, PRIME_TOP_N)) selected.set(s.code, s);
  for (const s of growth) selected.set(s.code, s);

  const manual = loadJsonIfExists("nikkei225-jp.json");
  if (manual) {
    let added = 0;
    for (const code of manual.map(String)) {
      if (!selected.has(code) && byCode.has(code)) { selected.set(code, byCode.get(code)); added++; }
    }
    console.log(`  nikkei225-jp.json から ${added} 銘柄を追加`);
  }
  console.log(`  日本株ユニバース確定: ${selected.size} 銘柄(プライム上位${PRIME_TOP_N} + グロース全 + 手動リスト)`);
  return [...selected.values()];
}

async function main() {
  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) { console.error("JQUANTS_API_KEY が未設定です"); process.exit(1); }
  const client = new JQuantsClient({ apiKey });

  console.log("=== 既存ストアの確認 ===");
  const store = await loadStore();
  const already = Object.keys(store.jp).length + Object.keys(store.us).length;
  if (already > 0) {
    console.log(`既に ${already} 銘柄のデータがあります。未取得の銘柄だけを追加取得します(途中失敗からの再開に対応)。`);
  }

  console.log("\n=== 日本株ユニバースの自動導出 ===");
  const jpUniverse = await resolveJpUniverse(client);

  console.log("\n=== 日本株 5年分の取得 ===");
  let i = 0, ok = 0, skip = 0, fail = 0;
  for (const s of jpUniverse) {
    i++;
    if (store.jp[s.code]?.bars?.length > 200) { skip++; continue; } // 再開対応
    process.stdout.write(`  [${i}/${jpUniverse.length}] ${s.code} ${s.name} ... `);
    try {
      const [quotes, stmts] = await Promise.all([
        client.dailyQuotesByCode(s.code, FIVE_YEARS_AGO, TODAY),
        client.statements(s.code),
      ]);
      const entry = store.jp[s.code] ||= { name: s.name, sector: s.sector, listingDate: s.listingDate, marketCodeName: s.market };
      appendBars(entry, quotes.map(quoteToBar));
      appendStmts(entry, stmts);
      ok++;
      console.log(`OK (${entry.bars.length}日 / 開示${entry.stmts.length}件)`);
    } catch (e) {
      fail++;
      console.log(`FAIL: ${e.message.slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, 150));
    // 100銘柄ごとに途中保存(長時間ジョブの中断・失敗に備える)
    if (i % 100 === 0) { console.log("  --- 途中保存 ---"); await saveStore(store); }
  }
  console.log(`日本株: 取得${ok} / スキップ(取得済)${skip} / 失敗${fail}`);

  console.log("\n=== 米国株(S&P500) 5年分の取得 ===");
  const usList = loadJsonIfExists("universe-sp500.json") || [];
  if (!usList.length) console.warn("  [警告] universe-sp500.json が見つかりません。米国株をスキップします。");
  i = 0; ok = 0; skip = 0; fail = 0;
  const cutoff = FIVE_YEARS_AGO;
  for (const [ticker, name, sector] of usList) {
    i++;
    if (store.us[ticker]?.bars?.length > 200) { skip++; continue; }
    process.stdout.write(`  [${i}/${usList.length}] ${ticker} ${name} ... `);
    try {
      const hist = await fetchStooqHistory(ticker);
      const entry = store.us[ticker] ||= { name, sector };
      appendBars(entry, hist.filter((r) => r.date >= cutoff).map(stooqToBar));
      ok++;
      console.log(`OK (${entry.bars.length}日)`);
    } catch (e) {
      fail++;
      console.log(`FAIL: ${e.message.slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
    if (i % 100 === 0) { console.log("  --- 途中保存 ---"); await saveStore(store); }
  }
  console.log(`米国株: 取得${ok} / スキップ${skip} / 失敗${fail}`);

  console.log("\n=== 最終保存 ===");
  await saveStore(store);
  console.log("\nバックフィル完了。次は daily-update.mjs が毎日この続きを積み重ねます。");
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error("バックフィル異常終了:", e); process.exit(1); });
export { main };
