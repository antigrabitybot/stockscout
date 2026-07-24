/**
 * backfill.mjs — 初回のみ実行するバックフィル処理
 * ----------------------------------------------------------------------------
 * このスクリプトは「初回 1 回だけ」実行する。
 * 全銘柄 5 年分の OHLCV を price-store.json.gz として保存し、
 * 以降の日次バッチが差分追記で高速に動作できるようにする。
 *
 * ■ STORE_BACKEND 環境変数
 *   github  → GitHub Releases にストアを保存（デフォルト。追加設定不要）
 *   local   → ./store/ フォルダに保存（ローカルテスト用）
 *   gdrive  → Google Drive（サービスアカウントのストレージ制限により非推奨）
 *
 * ■ 実行方法
 *   # GitHub Actions（自動。GITHUB_TOKEN は Actions が自動提供）
 *   → Actions タブ → StockScout Backfill (one-time) → Run workflow
 *
 *   # ローカルテスト（Google Drive / GitHub 不要）
 *   $env:JQUANTS_API_KEY="xxx"; $env:STORE_BACKEND="local"; node batch/backfill.mjs
 *
 * ■ 所要時間の目安
 *   日本株 ~450銘柄 × 5年 ≒ 15~20分
 *   米国株 ~503銘柄 × 5年 ≒ 20~30分
 *   合計   約40~50分（ネットワーク状況による）
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { JQuantsClient } from "./jquants.mjs";
import { fetchStooqHistory } from "./stooq.mjs";
import { JP_NAMES, US_NAMES } from "../logic.mjs";

const gzip   = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const __dirname       = path.dirname(fileURLToPath(import.meta.url));
const ROOT            = path.join(__dirname, "..");
const LOCAL_STORE_DIR = path.join(ROOT, "store");
const STORE_FILE      = "price-store.json.gz";
const BACKEND         = process.env.STORE_BACKEND || "github";

// GitHub Releases の設定
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO  = process.env.GITHUB_REPOSITORY || ""; // 例: "antigrabitybot/stockscout"
const RELEASE_TAG  = "price-store-data";
const RELEASE_NAME = "Price Store (auto-generated, do not delete)";

// --------------------------------------------------------------------------
// ストアの読み書き（バックエンドを透過的に扱う）
// --------------------------------------------------------------------------

async function loadStore() {
  if (BACKEND === "local") return localLoad();
  if (BACKEND === "github") return githubLoad();
  if (BACKEND === "gdrive") return gdriveLoad();
  throw new Error(`不明な STORE_BACKEND: ${BACKEND}`);
}

async function saveStore(store) {
  const json = JSON.stringify(store);
  const gz   = await gzip(Buffer.from(json, "utf8"));
  console.log(`  ストアサイズ: ${(gz.length / 1024 / 1024).toFixed(1)} MB (gzip)`);
  if (BACKEND === "local")  return localSave(gz);
  if (BACKEND === "github") return githubSave(gz);
  if (BACKEND === "gdrive") return gdriveSave(gz);
  throw new Error(`不明な STORE_BACKEND: ${BACKEND}`);
}

// --------------------------------------------------------------------------
// local バックエンド
// --------------------------------------------------------------------------

function localLoad() {
  const p = path.join(LOCAL_STORE_DIR, STORE_FILE);
  if (!fs.existsSync(p)) {
    console.log("  ローカルストアが存在しません。新規作成します。");
    return {};
  }
  const buf  = fs.readFileSync(p);
  return gunzip(buf).then((j) => JSON.parse(j.toString("utf8")));
}

function localSave(gz) {
  fs.mkdirSync(LOCAL_STORE_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_STORE_DIR, STORE_FILE), gz);
  console.log(`  ローカルに保存: ${path.join(LOCAL_STORE_DIR, STORE_FILE)}`);
}

// --------------------------------------------------------------------------
// GitHub Releases バックエンド（推奨・追加設定不要）
// --------------------------------------------------------------------------

function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** リリースを取得。存在しなければ作成して返す */
async function getOrCreateRelease() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    throw new Error(
      "GITHUB_TOKEN または GITHUB_REPOSITORY が未設定です。\n" +
      "GitHub Actions 上では自動で提供されます。\n" +
      "ローカルテストの場合は STORE_BACKEND=local を指定してください。"
    );
  }
  const [owner, repo] = GITHUB_REPO.split("/");
  const getRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${RELEASE_TAG}`,
    { headers: ghHeaders() }
  );
  if (getRes.ok) return getRes.json();
  if (getRes.status !== 404) {
    throw new Error(`GitHub Releases 取得エラー: ${await getRes.text()}`);
  }
  // リリースが存在しないので作成する
  console.log("  GitHub Releases にリリースを新規作成します...");
  // まずタグを作るためにコミットSHAが必要
  const refRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/main`,
    { headers: ghHeaders() }
  );
  if (!refRes.ok) throw new Error(`ref 取得エラー: ${await refRes.text()}`);
  const { object: { sha } } = await refRes.json();

  const createRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases`,
    {
      method: "POST",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: RELEASE_TAG,
        target_commitish: sha,
        name: RELEASE_NAME,
        body: "自動生成されたバックフィルデータ。削除しないでください。",
        draft: false,
        prerelease: true,
      }),
    }
  );
  if (!createRes.ok) throw new Error(`GitHub Releases 作成エラー: ${await createRes.text()}`);
  return createRes.json();
}

async function githubLoad() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    throw new Error(
      "GITHUB_TOKEN または GITHUB_REPOSITORY が未設定です。\n" +
      "ローカルテストの場合は STORE_BACKEND=local を指定してください。"
    );
  }
  const [owner, repo] = GITHUB_REPO.split("/");
  const getRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${RELEASE_TAG}`,
    { headers: ghHeaders() }
  );
  if (getRes.status === 404) {
    console.log("  GitHub Releases にストアが存在しません。新規作成します。");
    return {};
  }
  if (!getRes.ok) throw new Error(`GitHub Releases 取得エラー: ${await getRes.text()}`);
  const release = await getRes.json();
  const asset   = release.assets?.find((a) => a.name === STORE_FILE);
  if (!asset) {
    console.log("  リリースにストアファイルが存在しません。新規作成します。");
    return {};
  }
  console.log(`  既存ストアを取得: assetId=${asset.id} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);
  // プライベートリポジトリ対応: API 経由でダウンロード
  const dlRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`,
    { headers: { ...ghHeaders(), Accept: "application/octet-stream" } }
  );
  if (!dlRes.ok) throw new Error(`GitHub アセットダウンロードエラー: ${await dlRes.text()}`);
  const buf  = Buffer.from(await dlRes.arrayBuffer());
  const json = await gunzip(buf);
  return JSON.parse(json.toString("utf8"));
}

async function githubSave(gzBuffer) {
  const [owner, repo] = GITHUB_REPO.split("/");
  const release = await getOrCreateRelease();
  console.log(`  リリース ID: ${release.id} (${RELEASE_TAG})`);

  // 既存アセットを削除（上書きのため）
  const existing = release.assets?.find((a) => a.name === STORE_FILE);
  if (existing) {
    console.log(`  既存アセットを削除: ${existing.id}`);
    await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/assets/${existing.id}`,
      { method: "DELETE", headers: ghHeaders() }
    );
  }

  // 新しいアセットをアップロード
  console.log("  GitHub Releases にアップロード中...");
  const uploadRes = await fetch(
    `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(STORE_FILE)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/gzip",
        "Content-Length": String(gzBuffer.length),
      },
      body: gzBuffer,
    }
  );
  if (!uploadRes.ok) throw new Error(`GitHub アセットアップロードエラー: ${await uploadRes.text()}`);
  const asset = await uploadRes.json();
  console.log(`  GitHub Releases に保存完了: assetId=${asset.id}`);
}

// --------------------------------------------------------------------------
// Google Drive バックエンド（サービスアカウントのストレージ制限で非推奨）
// --------------------------------------------------------------------------

import { createPrivateKey, createSign } from "node:crypto";

function getGdriveConfig() {
  const raw      = process.env.GDRIVE_SERVICE_ACCOUNT_JSON;
  const folderId = process.env.GDRIVE_FOLDER_ID?.trim();
  if (!raw || !folderId) {
    throw new Error("GDRIVE_SERVICE_ACCOUNT_JSON または GDRIVE_FOLDER_ID が未設定です。");
  }
  return { sa: JSON.parse(raw), folderId };
}

async function getGdriveAccessToken() {
  const { sa } = getGdriveConfig();
  const now    = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  })).toString("base64url");
  const sigInput = `${header}.${payload}`;
  const key  = createPrivateKey(sa.private_key);
  const sign = createSign("SHA256");
  sign.update(sigInput);
  const jwt = `${sigInput}.${sign.sign(key).toString("base64url")}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Google OAuth2 エラー: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function gdriveLoad() {
  const { folderId } = getGdriveConfig();
  const token = await getGdriveAccessToken();
  const q       = encodeURIComponent(`'${folderId}' in parents and name='${STORE_FILE}' and trashed=false`);
  const listRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listRes.ok) throw new Error(`Drive list error: ${await listRes.text()}`);
  const { files } = await listRes.json();
  if (!files?.length) { console.log("  GDrive にストアが存在しません。新規作成します。"); return {}; }
  const dlRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${files[0].id}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!dlRes.ok) throw new Error(`Drive download error: ${await dlRes.text()}`);
  return JSON.parse((await gunzip(Buffer.from(await dlRes.arrayBuffer()))).toString("utf8"));
}

async function gdriveSave(gzBuffer) {
  const { folderId } = getGdriveConfig();
  const token = await getGdriveAccessToken();
  const q       = encodeURIComponent(`'${folderId}' in parents and name='${STORE_FILE}' and trashed=false`);
  const listRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { files }    = await listRes.json();
  const existingId   = files?.[0]?.id;
  const metadata     = JSON.stringify({ name: STORE_FILE, mimeType: "application/gzip", ...(existingId ? {} : { parents: [folderId] }) });
  const boundary     = "boundary_stockscout";
  const body         = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`, "utf8"),
    Buffer.from(`--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`, "utf8"),
    gzBuffer,
    Buffer.from(`\r\n--${boundary}--`, "utf8"),
  ]);
  const url    = existingId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
  const upRes  = await fetch(url, {
    method: existingId ? "PATCH" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!upRes.ok) throw new Error(`Drive upload error: ${await upRes.text()}`);
  console.log(`  Google Drive に保存完了: fileId=${(await upRes.json()).id}`);
}

// --------------------------------------------------------------------------
// バックフィル本体
// --------------------------------------------------------------------------

function today() { return new Date().toISOString().slice(0, 10); }

function loadUniverseList(marketFile, fallback) {
  const p = path.join(__dirname, marketFile);
  if (fs.existsSync(p)) { console.log(`  カスタムユニバース ${marketFile} を使用`); return JSON.parse(fs.readFileSync(p, "utf8")); }
  return fallback;
}

function getLastDate(entry) {
  if (!entry?.rows?.length) return null;
  return entry.rows[entry.rows.length - 1].date;
}

async function backfillJp(client, store, list) {
  const to   = today();
  const from = new Date(Date.now() - 5 * 365 * 86400_000).toISOString().slice(0, 10);
  let i = 0;
  for (const [code, name, sector] of list) {
    i++;
    const existing  = store[`JP:${code}`];
    const lastDate  = getLastDate(existing);
    const fetchFrom = lastDate
      ? new Date(new Date(lastDate).getTime() + 86400_000).toISOString().slice(0, 10)
      : from;
    if (lastDate && fetchFrom >= to) {
      process.stdout.write(`  [JP ${i}/${list.length}] ${code} → 最新(スキップ)\n`);
      continue;
    }
    process.stdout.write(`  [JP ${i}/${list.length}] ${code} ${name} (${fetchFrom}~${to}) ... `);
    try {
      const quotes  = await client.dailyQuotesByCode(code, fetchFrom, to);
      const newRows = quotes
        .filter((q) => q.AdjustmentClose != null)
        .map((q) => ({ date: q.Date, o: q.AdjustmentOpen, h: q.AdjustmentHigh, l: q.AdjustmentLow, c: q.AdjustmentClose, v: q.AdjustmentVolume ?? q.Volume ?? 0 }));
      if (newRows.length === 0) { console.log("0件"); }
      else if (existing) { existing.rows = existing.rows.concat(newRows); console.log(`${newRows.length}件追加`); }
      else { store[`JP:${code}`] = { code, name, sector, market: "JP", rows: newRows }; console.log(`${newRows.length}件取得`); }
    } catch (e) { console.log(`FAIL: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function backfillUs(store, list) {
  let i = 0;
  for (const [ticker, name, sector] of list) {
    i++;
    const key      = `US:${ticker}`;
    const existing = store[key];
    const lastDate = getLastDate(existing);
    if (lastDate && lastDate >= today()) { process.stdout.write(`  [US ${i}/${list.length}] ${ticker} → 最新(スキップ)\n`); continue; }
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
    } catch (e) { console.log(`FAIL: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function main() {
  const jqApiKey = process.env.JQUANTS_API_KEY;
  if (!jqApiKey) { console.error("JQUANTS_API_KEY が未設定です。"); process.exit(1); }

  console.log(`=== StockScout バックフィル開始 (backend: ${BACKEND}) ===`);
  console.log(`開始時刻: ${new Date().toLocaleString("ja-JP")}`);

  console.log("\n--- ストアの読み込み ---");
  const store = await loadStore();
  console.log(`  既存エントリ数: ${Object.keys(store).length}`);

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

  console.log(`\n=== 完了 ===`);
  console.log(`合計 ${Object.keys(store).length} 銘柄を保存しました。`);
  console.log(`終了時刻: ${new Date().toLocaleString("ja-JP")}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => { console.error("バックフィルが異常終了しました:", e); process.exit(1); });
}

export { main, loadStore, saveStore };
