#!/usr/bin/env node
/**
 * extract-logic.mjs
 * ----------------------------------------------------------------------------
 * StockScout.jsx から「純粋なロジック部分」だけを自動抽出し、Node.js の
 * 日次バッチが import できる logic.mjs を生成する。
 *
 * なぜ手でコピーせず自動生成するか:
 *   36手法のスコア計算式・バックテストエンジン・ポートフォリオ評価ロジックを
 *   フロントエンド(デモ表示)とバックエンド(日次バッチ)の2箇所に手で
 *   書くと、修正のたびに片方だけ直して食い違う(ドリフトする)事故が必ず起きる。
 *   StockScout.jsx を唯一の正本(single source of truth)とし、バッチ側は
 *   このスクリプトで機械的に切り出すことで、ドリフトを構造的に防ぐ。
 *
 * 切り出しの境界:
 *   StockScout.jsx 内の `const css = ` より前が「DOM非依存の純粋なロジック」
 *   であり、それより後が UI(React コンポーネント・CSS・JSX)。
 *   この境界はテスト時から一貫して使ってきたもので、変える予定はない。
 *
 * 使い方:
 *   node scripts/extract-logic.mjs
 *   → logic.mjs を生成(CIの一部として毎回実行し、コミットはしない運用を推奨)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "StockScout.jsx");
const OUT = path.join(__dirname, "..", "logic.mjs");

const BOUNDARY = "const css = `";
const EXPORTS = [
  "CAT", "HORIZON", "STRATEGIES", "EXCLUDED", "SIGNAL_UI",
  "genUniverse", "genHistory", "genFundHistory",
  "runScreen", "plan", "evaluateHolding",
  "featuresAt", "backtest", "benchmark", "BT",
  "fmtP", "pct", "geminiPrompt",
  "mulberry32", "gauss",
  "JP_NAMES", "US_NAMES", "TECH_CURRENT_KEYS",
];

function main() {
  const src = fs.readFileSync(SRC, "utf8");
  const cut = src.indexOf(BOUNDARY);
  if (cut === -1) {
    console.error(`FAIL: 境界文字列 "${BOUNDARY}" が StockScout.jsx 内に見つかりません。`);
    console.error("StockScout.jsx の構造が変わった場合は、このスクリプトの BOUNDARY を更新してください。");
    process.exit(1);
  }

  let body = src.slice(0, cut);
  // React の import 行(Node には不要)を除去
  body = body.replace(/^import .*$/m, "");

  const header = `/**
 * logic.mjs — 自動生成ファイル。直接編集しないこと。
 * 生成元: StockScout.jsx (scripts/extract-logic.mjs で自動抽出)
 * 生成日時: ${new Date().toISOString()}
 *
 * StockScout.jsx を修正したら、このファイルを再生成してから
 * バッチ処理を実行すること。CI では毎回自動実行される想定。
 */

`;

  const footer = `\nexport { ${EXPORTS.join(", ")} };\n`;

  fs.writeFileSync(OUT, header + body + footer, "utf8");
  console.log(`OK: ${OUT} を生成しました (${(body.length / 1024).toFixed(0)} KB)`);
}

main();
