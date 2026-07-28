/**
 * store.mjs — 価格・財務データの永続ストア
 * ----------------------------------------------------------------------------
 * ■ データ構造(1ファイル・gzip圧縮)
 *   {
 *     version: 1,
 *     updatedAt: "2026-07-22",
 *     jp: { [code]: { name, sector, listingDate, marketCodeName,
 *                      bars:  [[date, o, h, l, c, v], ...],   // 昇順
 *                      stmts: [ 正規化済み財務情報, ... ] } },
 *     us: { [ticker]: { name, sector, bars: [...] } },
 *   }
 *   bars を配列の配列にしているのはサイズ削減のため(キー名の繰り返しを排除。
 *   JSONで約半分になる)。gzip後の想定サイズは1,300銘柄×5年で10〜20MB程度。
 *
 * ■ 保存先の切り替え
 *   環境変数 STORE_BACKEND=local | gdrive (既定: gdrive設定があればgdrive)
 *   local  … ./store/price-store.json.gz (Drive設定前のテスト用)
 *   gdrive … Google Drive のフォルダ内 price-store.json.gz
 *   同じコードがどちらでも動くので、今夜ローカルで動作確認 → 帰宅後に
 *   Drive設定を入れて STORE_BACKEND を切り替えるだけで移行できる。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { GDrive } from "./gdrive.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_DIR = path.join(__dirname, "..", "store");
const FILE_NAME = "price-store.json.gz";

export function emptyStore() {
  return { version: 1, updatedAt: null, jp: {}, us: {} };
}

function backend() {
  const explicit = process.env.STORE_BACKEND;
  if (explicit) return explicit;
  return process.env.GDRIVE_SERVICE_ACCOUNT_JSON && process.env.GDRIVE_FOLDER_ID ? "gdrive" : "local";
}

function gdrive() {
  return new GDrive({
    serviceAccountJson: process.env.GDRIVE_SERVICE_ACCOUNT_JSON,
    folderId: process.env.GDRIVE_FOLDER_ID,
  });
}

/** ストアを読み込む。存在しなければ空ストアを返す(初回バックフィル用)。 */
export async function loadStore() {
  const be = backend();
  console.log(`  [store] 読み込み (backend=${be})`);
  let buf = null;
  if (be === "gdrive") {
    const gd = gdrive();
    const f = await gd.findFile(FILE_NAME);
    if (f) {
      buf = await gd.download(f.id);
      console.log(`  [store] Drive から ${(buf.length / 1024 / 1024).toFixed(1)} MB 取得`);
    }
  } else {
    const p = path.join(LOCAL_DIR, FILE_NAME);
    if (fs.existsSync(p)) buf = fs.readFileSync(p);
  }
  if (!buf) {
    console.log("  [store] 既存ストアなし。空の状態から開始します。");
    return emptyStore();
  }
  const store = JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
  const nJp = Object.keys(store.jp || {}).length;
  const nUs = Object.keys(store.us || {}).length;
  console.log(`  [store] JP ${nJp}銘柄 / US ${nUs}銘柄 / 最終更新 ${store.updatedAt}`);
  return store;
}

/** ストアを保存する。
 *  explicitDate を渡した場合はその日付を updatedAt とする(未指定なら
 *  従来通り「今日」の日付を自動で入れる)。daily-update.mjs は、実際に
 *  データが確認できた最後の日を明示的に渡すことで、「配信前で空データ
 *  だった日」を誤って「確認済み」にしてしまう事故を防ぐ。 */
export async function saveStore(store, explicitDate) {
  store.updatedAt = explicitDate || new Date().toISOString().slice(0, 10);
  const raw = Buffer.from(JSON.stringify(store));
  const gz = zlib.gzipSync(raw, { level: 6 });
  const be = backend();
  console.log(`  [store] 保存 (backend=${be}) raw ${(raw.length / 1024 / 1024).toFixed(1)}MB → gz ${(gz.length / 1024 / 1024).toFixed(1)}MB`);
  if (be === "gdrive") {
    await gdrive().upload(FILE_NAME, gz);
  } else {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOCAL_DIR, FILE_NAME), gz);
  }
}

/* ------------------------------------------------------------- 追記ヘルパー */

/** bars(配列の配列・昇順)に新しい行を重複なく追記する。
 *  同じ日付が既にあれば新しい値で置き換える(訂正配信への対応)。 */
export function appendBars(entry, newRows) {
  if (!entry.bars) entry.bars = [];
  const byDate = new Map(entry.bars.map((r) => [r[0], r]));
  for (const r of newRows) {
    if (r[0] == null || !isFinite(r[4])) continue;
    byDate.set(r[0], r);
  }
  entry.bars = [...byDate.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** 財務情報(正規化済み)を DisclosureNumber ベースで重複なく追記する。 */
export function appendStmts(entry, newStmts) {
  if (!entry.stmts) entry.stmts = [];
  const key = (s) => `${s.DisclosedDate}_${s.DisclosureNumber}`;
  const byKey = new Map(entry.stmts.map((s) => [key(s), s]));
  for (const s of newStmts) byKey.set(key(s), s);
  entry.stmts = [...byKey.values()].sort((a, b) => (a.DisclosedDate < b.DisclosedDate ? -1 : 1));
}

/** J-Quants の正規化済み quote → 圧縮 bar 形式 */
export function quoteToBar(q) {
  return [q.Date, num(q.AdjustmentOpen), num(q.AdjustmentHigh), num(q.AdjustmentLow),
    num(q.AdjustmentClose), num(q.AdjustmentVolume) || 0,
    num(q.TurnoverValue) ?? undefined].slice(0, num(q.TurnoverValue) != null ? 7 : 6);
}

/** Stooq の行 → bar 形式 */
export function stooqToBar(r) {
  return [r.date, r.o, r.h, r.l, r.c, r.v];
}

/** bar 形式 → compute-features-jp が期待する quote オブジェクト形式へ復元 */
export function barToQuote(b) {
  return {
    Date: b[0], AdjustmentOpen: b[1], AdjustmentHigh: b[2], AdjustmentLow: b[3],
    AdjustmentClose: b[4], AdjustmentVolume: b[5], Volume: b[5],
    TurnoverValue: b[6] ?? null, AdjustmentFactor: 1,
  };
}

/** bar 形式 → compute-features-us が期待する {date,o,h,l,c,v} 形式へ復元 */
export function barToOhlc(b) {
  return { date: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] };
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
