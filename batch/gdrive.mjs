/**
 * gdrive.mjs — Google Drive クライアント(サービスアカウント / npm依存ゼロ)
 * ----------------------------------------------------------------------------
 * ■ なぜ googleapis パッケージを使わないか
 *   本プロジェクトのバッチは「外部npmパッケージゼロ」を維持してきた
 *   (CI が速く、依存の破損リスクが無い)。Google の認証は JWT の RS256 署名が
 *   必要だが、これは Node 標準の node:crypto で実装できるため、
 *   公式SDKを入れずに Drive REST API を直接叩く。
 *
 * ■ 必要な環境変数
 *   GDRIVE_SERVICE_ACCOUNT_JSON … サービスアカウントのキーJSON(丸ごと1行)
 *   GDRIVE_FOLDER_ID            … データ保存先フォルダのID
 *                                  (フォルダをサービスアカウントのメールアドレスに
 *                                   「編集者」で共有しておくこと)
 *
 * ■ 未検証の注意
 *   サンドボックスから googleapis.com へ接続できないため、実環境での
 *   動作確認はできていない。実装は Google 公式の OAuth2 サービスアカウント
 *   フロー(JWT Bearer)と Drive v3 REST の仕様に沿っている。初回は
 *   selfTest() で疎通確認すること。
 */
import crypto from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class GDrive {
  constructor({ serviceAccountJson, folderId }) {
    if (!serviceAccountJson) throw new Error("GDRIVE_SERVICE_ACCOUNT_JSON が未設定です");
    if (!folderId) throw new Error("GDRIVE_FOLDER_ID が未設定です");
    this.sa = typeof serviceAccountJson === "string" ? JSON.parse(serviceAccountJson) : serviceAccountJson;
    this.folderId = folderId;
    this.token = null;
    this.tokenExp = 0;
  }

  /** サービスアカウントJWTを署名してアクセストークンを取得(1時間有効・自動更新) */
  async _accessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && now < this.tokenExp - 120) return this.token;

    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({
      iss: this.sa.client_email,
      scope: "https://www.googleapis.com/auth/drive",
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }));
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const signature = b64url(signer.sign(this.sa.private_key));
    const jwt = `${header}.${claims}.${signature}`;

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });
    if (!res.ok) {
      throw new Error(`Google認証に失敗しました(HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();
    this.token = data.access_token;
    this.tokenExp = now + (data.expires_in || 3600);
    return this.token;
  }

  async _headers() {
    return { Authorization: `Bearer ${await this._accessToken()}` };
  }

  /** フォルダ内でファイル名からIDを探す。無ければ null。 */
  async findFile(name) {
    const q = encodeURIComponent(`name='${name}' and '${this.folderId}' in parents and trashed=false`);
    const res = await fetch(`${API}/files?q=${q}&fields=files(id,name,size,modifiedTime)`, {
      headers: await this._headers(),
    });
    if (!res.ok) throw new Error(`Drive検索失敗(HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return data.files?.[0] ?? null;
  }

  /** ファイルをバイナリでダウンロード。 */
  async download(fileId) {
    const res = await fetch(`${API}/files/${fileId}?alt=media`, { headers: await this._headers() });
    if (!res.ok) throw new Error(`Driveダウンロード失敗(HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** バイナリをアップロード。同名ファイルがあれば上書き、無ければ新規作成。 */
  async upload(name, buffer, mimeType = "application/gzip") {
    const existing = await this.findFile(name);
    const headers = { ...(await this._headers()), "Content-Type": mimeType };
    let res;
    if (existing) {
      res = await fetch(`${UPLOAD}/files/${existing.id}?uploadType=media`, {
        method: "PATCH", headers, body: buffer,
      });
    } else {
      // multipart で metadata(名前・親フォルダ) と本体を同時送信
      const boundary = "ssb_" + crypto.randomBytes(8).toString("hex");
      const meta = JSON.stringify({ name, parents: [this.folderId] });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
        buffer,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      res = await fetch(`${UPLOAD}/files?uploadType=multipart`, {
        method: "POST",
        headers: { ...(await this._headers()), "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      });
    }
    if (!res.ok) throw new Error(`Driveアップロード失敗(HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
}

/** 疎通確認: 小さなテストファイルを書いて読み戻す。
 *   GDRIVE_SERVICE_ACCOUNT_JSON='...' GDRIVE_FOLDER_ID=... node -e "import('./batch/gdrive.mjs').then(m=>m.selfTest())"
 */
export async function selfTest() {
  const gd = new GDrive({
    serviceAccountJson: process.env.GDRIVE_SERVICE_ACCOUNT_JSON,
    folderId: process.env.GDRIVE_FOLDER_ID,
  });
  console.log("1. 認証+書き込みテスト...");
  const payload = Buffer.from(JSON.stringify({ hello: "stockscout", at: new Date().toISOString() }));
  await gd.upload("stockscout-selftest.json", payload, "application/json");
  console.log("   OK: アップロード成功");
  console.log("2. 読み戻しテスト...");
  const f = await gd.findFile("stockscout-selftest.json");
  const buf = await gd.download(f.id);
  console.log("   OK:", buf.toString().slice(0, 80));
  console.log("\nGoogle Drive 連携は正常です。");
}
