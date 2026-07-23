/**
 * backfill.mjs — 初回のみ実行するバックフィル処理
 * ----------------------------------------------------------------------------
 * このスクリプトは「初回 1 回だけ」実行する。
 * build-snapshot.mjs の通常バッチとほぼ同じ処理だが、
 * Google Drive / ローカルストアに price-store.json.gz (全銘柄5年分の OHLCV)
 * を保存する点が異なる。
 *
 * 実行方法:
 *   # ローカルテスト(Google Drive 不要)
 *   JQUANTS_API_KEY=xxx STORE_BACKEND=local node batch/backfill.mjs
 *
 *   # Google Drive に保存(GitHub Actions または本番環境)
 *   JQUANTS_API_KEY=xxx \
 *   GDRIVE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}' \
 *   GDRIVE_FOLDER_ID=your_folder_id \
 *   node batch/backfill.mjs
 *
 * ■ STORE_BACKEND 環境変数
 *   local  → ./store/ フォルダに保存(Google Drive 設定前のテスト用)
 *   gdrive → Google Drive に保存(デフォルト)
 *
 * ■ 所要時間の目安
 *   日本株 ~450銘柄 × 5年 ≒ 15~20分
 *   米国株 ~503銘柄 × 5年 ≒ 20~30分
 *   合計   約40~50分(ネットワーク状況による)
 *
 * ■ 既存ストアへの差分追記について
 *   GDRIVE / local に price-store.json.gz が既に存在する場合は、
 *   「既存の最終日以降の差分」だけを追記するモードで動作する。
 *   初回は当然フルフィルになる。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createPrivateKey, createSign } from "node:crypto";
import { JQuantsClient } from "./jquants.mjs";
import { fetchStooqHistory } from "./stooq.mjs";
import { JP_NAMES, US_NAMES } from "../logic.mjs";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const LOCAL_STORE_DIR = path.join(ROOT, "store");
const STORE_FILE = "price-store.json.gz";
const BACKEND = process.env.STORE_BACKEND || "gdrive";

// --------------------------------------------------------------------------
// ストアの読み書き (local / gdrive を透過的に扱う)
// --------------------------------------------------------------------------

async function loadStore() {
  if (BACKEND === "local") {
    const p = path.join(LOCAL_STORE_DIR, STORE_FILE);
    if (!fs.existsSync(p)) {
      console.log("  ローカルストアが存在しません。新規作成します。");
      return {};
    }
    const buf = fs.readFileSync(p);
    const json = await gunzip(buf);
    return JSON.parse(json.toString("utf8"));
  }
  // Google Drive
  return await gdriveLoad();
}

async function saveStore(store) {
  const json = JSON.stringify(store);
  const gz = await gzip(Buffer.from(json, "utf8"));
  console.log(`  ストアサイズ: ${(gz.length / 1024 / 1024).toFixed(1)} MB (gzip)`);
  if (BACKEND === "local") {
    fs.mkdirSync(LOCAL_STORE_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOCAL_STORE_DIR, STORE_FILE), gz);
    console.log(`  ローカルに保存: ${path.join(LOCAL_STORE_DIR, STORE_FILE)}`);
    return;
  }
  await gdriveSave(gz);
}

// --------------------------------------------------------------------------
// Google Drive 通信 (Node 標準の crypto + fetch のみ。外部 npm パッケージ不使用)
// --------------------------------------------------------------------------

function getGdriveConfig() {
  const raw = process.env.GDRIVE_SERVICE_ACCOUNT_JSON;
  const folderId = process.env.GDRIVE_FOLDER_ID;
  if (!raw || !folderId) {
    throw new Error(
      "GDRIVE_SERVICE_ACCOUNT_JSON または GDRIVE_FOLDER_ID が未設定です。\n" +
      "ローカルテストの場合は STORE_BACKEND=local を指定してください。"
    );
  }
  const sa = JSON.parse(raw);
  return { sa, folderId };
}

/** Google Service Account 用 JWT を生成して OAuth2 アクセストークンを取得する */
async function getGdriveAccessToken() {
  const { sa } = getGdriveConfig();
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");
  const sigInput = `${header}.${payload}`;
  const key = createPrivateKey(sa.private_key);
  const sign = createSign("SHA256");
  sign.update(sigInput);
  const sig = sign.sign(key).toString("base64url");
  const jwt = `${sigInput}.${sig}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Google OAuth2 エラー: ${await res.text()}`);
  const { access_token } = await res.json();
  return access_token;
}

/** Google Drive からファイルを検索 → 取得。存在しなければ {} を返す */
async function gdriveLoad() {
  const { folderId } = getGdriveConfig();
  // フォルダIDの先頭6文字だけログに出す(全体は秘匿)
  console.log(`  フォルダID(先頭6文字): ${folderId.slice(0, 6)}... (全${folderId.length}文字)`);
  const token = await getGdriveAccessToken();
  console.log("  OAuth2トークン取得: OK");

  // まずフォルダ自体が見えるか確認
  const folderRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!folderRes.ok) {
    const body = await folderRes.text();
    throw new Error(`フォルダへのアクセス失敗(HTTP ${folderRes.status}): ${body}\n` +
      "→ Google Drive フォルダがサービスアカウントの client_email に '編集者' で共有されているか確認してください。");
  }
  const folderInfo = await folderRes.json();
  console.log(`  フォルダ確認OK: "${folderInfo.name}"`);

  const q = encodeURIComponent(`'${folderId}' in parents and name='${STORE_FILE}' and trashed=false`);
  const listRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listRes.ok) throw new Error(`Drive list error: ${await listRes.text()}`);
  const { files } = await listRes.json();
  if (!files || files.length === 0) {
    console.log("  Google Drive にストアが存在しません。新規作成します。");
    return {};
  }
  const fileId = files[0].id;
  console.log(`  既存ストアを取得: fileId=${fileId}`);
  const dlRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!dlRes.ok) throw new Error(`Drive download error: ${await dlRes.text()}`);
  const buf = Buffer.from(await dlRes.arrayBuffer());
  const json = await gunzip(buf);
  return JSON.parse(json.toString("utf8"));
}

/** Google Drive にファイルをアップロード(既存があれば上書き) */
async function gdriveSave(gzBuffer) {
  const { folderId } = getGdriveConfig();
  const token = await getGdriveAccessToken();

  // 既存ファイルを検索
  const q = encodeURIComponent(`'${folderId}' in parents and name='${STORE_FILE}' and trashed=false`);
  const listRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { files } = await listRes.json();
  const existingId = files?.[0]?.id;

  const metadata = JSON.stringify({
    name: STORE_FILE,
    mimeType: "application/gzip",
    ...(existingId ? {} : { parents: [folderId] }),
  });
  const body = buildMultipart(metadata, gzBuffer);
  const uploadUrl = existingId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
  const method = existingId ? "PATCH" : "POST";

  const upRes = await fetch(uploadUrl, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=boundary_stockscout`,
    },
    body,
  });
  if (!upRes.ok) throw new Error(`Drive upload error: ${await upRes.text()}`);
  const { id } = await upRes.json();
  console.log(`  Google Drive に保存完了: fileId=${id}`);
}

function buildMultipart(metadataJson, fileBuffer) {
  const boundary = "boundary_stockscout";
  const parts = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataJson}\r\n`,
    `--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`,
  ];
  const end = `\r\n--${boundary}--`;
  return Buffer.concat([
    Buffer.from(parts[0], "utf8"),
    Buffer.from(parts[1], "utf8"),
    fileBuffer,
    Buffer.from(end, "utf8"),
  ]);
}

// --------------------------------------------------------------------------
// バックフィル本体
// --------------------------------------------------------------------------

function today() {
  return new Date().toISOString().slice(0, 10);
}

function loadUniverseList(marketFile, fallback) {
  const p = path.join(__dirname, marketFile);
  if (fs.existsSync(p)) {
    console.log(`  カスタムユニバース ${marketFile} を使用`);
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return fallback;
}

/** 既存ストアの最終日を取得 (差分追記のため) */
function getLastDate(storeEntry) {
  if (!storeEntry || !storeEntry.rows || storeEntry.rows.length === 0) return null;
  return storeEntry.rows[storeEntry.rows.length - 1].date;
}

async function backfillJp(client, store, list) {
  const to = today();
  const from = new Date(Date.now() - 5 * 365 * 86400_000).toISOString().slice(0, 10);
  let i = 0;
  for (const [code, name, sector] of list) {
    i++;
    const existing = store[`JP:${code}`];
    const lastDate = getLastDate(existing);
    const fetchFrom = lastDate
      ? new Date(new Date(lastDate).getTime() + 86400_000).toISOString().slice(0, 10)
      : from;

    if (lastDate && fetchFrom >= to) {
      process.stdout.write(`  [JP ${i}/${list.length}] ${code} ${name} → 最新(スキップ)\n`);
      continue;
    }
    process.stdout.write(`  [JP ${i}/${list.length}] ${code} ${name} (${fetchFrom}~${to}) ... `);
    try {
      const quotes = await client.dailyQuotesByCode(code, fetchFrom, to);
      if (quotes.length === 0) {
        console.log("0件");
      } else {
        const newRows = quotes
          .filter((q) => q.AdjustmentClose != null)
          .map((q) => ({
            date: q.Date,
            o: q.AdjustmentOpen,
            h: q.AdjustmentHigh,
            l: q.AdjustmentLow,
            c: q.AdjustmentClose,
            v: q.AdjustmentVolume ?? q.Volume ?? 0,
          }));
        if (existing) {
          existing.rows = existing.rows.concat(newRows);
        } else {
          store[`JP:${code}`] = { code, name, sector, market: "JP", rows: newRows };
        }
        console.log(`${quotes.length}件追加`);
      }
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function backfillUs(store, list) {
  let i = 0;
  for (const [ticker, name, sector] of list) {
    i++;
    const key = `US:${ticker}`;
    const existing = store[key];
    const lastDate = getLastDate(existing);

    if (lastDate && lastDate >= today()) {
      process.stdout.write(`  [US ${i}/${list.length}] ${ticker} → 最新(スキップ)\n`);
      continue;
    }
    process.stdout.write(`  [US ${i}/${list.length}] ${ticker} ${name} ... `);
    try {
      const rows = await fetchStooqHistory(ticker);
      if (existing && lastDate) {
        const newRows = rows.filter((r) => r.date > lastDate);
        existing.rows = existing.rows.concat(newRows);
        console.log(`${newRows.length}件追加`);
      } else {
        store[key] = { code: ticker, name, sector, market: "US", rows };
        console.log(`${rows.length}件取得`);
      }
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function main() {
  const jqApiKey = process.env.JQUANTS_API_KEY;
  if (!jqApiKey) {
    console.error("環境変数 JQUANTS_API_KEY が未設定です。");
    process.exit(1);
  }

  console.log(`=== StockScout バックフィル開始 (backend: ${BACKEND}) ===`);
  console.log(`開始時刻: ${new Date().toLocaleString("ja-JP")}`);

  console.log("\n--- ストアの読み込み ---");
  const store = await loadStore();
  const existingCount = Object.keys(store).length;
  console.log(`  既存エントリ数: ${existingCount}`);

  console.log("\n--- J-Quants 認証 ---");
  const client = new JQuantsClient({ apiKey: jqApiKey });
  await client.authenticate();
  console.log("  OK");

  const jpList = loadUniverseList("universe-jp.json", JP_NAMES);
  const usList = loadUniverseList("universe-us.json", US_NAMES);
  console.log(`\nユニバース: 日本株 ${jpList.length} 銘柄, 米国株 ${usList.length} 銘柄`);

  console.log("\n=== 日本株バックフィル ===");
  await backfillJp(client, store, jpList);

  console.log("\n=== 米国株バックフィル ===");
  await backfillUs(store, usList);

  console.log("\n--- ストアの保存 ---");
  await saveStore(store);

  const total = Object.keys(store).length;
  console.log(`\n=== 完了 ===`);
  console.log(`合計 ${total} 銘柄を保存しました。`);
  console.log(`終了時刻: ${new Date().toLocaleString("ja-JP")}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    console.error("バックフィルが異常終了しました:", e);
    process.exit(1);
  });
}

export { main, loadStore, saveStore };
