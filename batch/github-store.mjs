/**
 * github-store.mjs — GitHub Releases を保存先にするストレージクライアント
 * ----------------------------------------------------------------------------
 * ■ なぜ Google Drive をやめてこちらにしたか
 *   Google Drive のサービスアカウント方式で実機テストしたところ、
 *   「Service Accounts do not have storage quota」という Google 側の
 *   仕様(2023年6月以降、サービスアカウントは Shared Drive 以外では
 *   ストレージ容量ゼロで新規ファイルを作成できない)に阻まれることが
 *   判明した。Shared Drive は Google Workspace(有料)が必要で、個人の
 *   Gmail アカウントでは使えない。これを回避するには OAuth ユーザー委任
 *   (ブラウザでの同意フローが1回必要)が要るが、セットアップの手間が
 *   大きい。
 *
 *   一方、GitHub Actions には追加設定なしで自動的に `GITHUB_TOKEN` が
 *   渡される。これを使い、リポジトリの「GitHub Releases」機能に
 *   データファイルをアセットとして添付する形にすれば、外部サービスの
 *   アカウント設定が一切不要になる。実際、このプロジェクトの初期の
 *   実装(現在は置き換え済み)で同じ方式が正常に動作した実績がある。
 *
 * ■ 仕組み
 *   固定のタグ名(例: "store-data")のリリースを1つ用意し(無ければ作成)、
 *   そのリリースにファイルをアセットとして添付する。更新する場合は
 *   同名の既存アセットを削除してから再アップロードする(Releases API に
 *   アセットの中身を直接上書きする手段は無いため)。
 *
 * ■ 必要な環境変数(GitHub Actions 内では自動的に設定済み)
 *   GITHUB_TOKEN      … Actions のジョブに自動的に渡されるトークン。
 *                        ワークフロー側で permissions: contents: write が必要
 *   GITHUB_REPOSITORY … "owner/repo" 形式。Actions 内では自動設定
 *
 * ■ 容量の目安
 *   1アセットあたり上限2GB。今回のデータ(約1,300銘柄×5年、gzip後)は
 *   数十MB程度を想定しており、大幅に余裕がある。
 */

const API = "https://api.github.com";
const TAG = "store-data";

function repoInfo() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY が未設定です(GitHub Actions外で実行していませんか?)");
  const [owner, name] = repo.split("/");
  return { owner, name };
}

export class GitHubStore {
  constructor({ token } = {}) {
    this.token = token || process.env.GITHUB_TOKEN;
    if (!this.token) throw new Error("GITHUB_TOKEN が未設定です");
    const { owner, name } = repoInfo();
    this.owner = owner;
    this.repo = name;
  }

  _headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...extra,
    };
  }

  /** 固定タグのリリースを取得。無ければ作成して返す。 */
  async _ensureRelease() {
    const base = `${API}/repos/${this.owner}/${this.repo}`;
    let res = await fetch(`${base}/releases/tags/${TAG}`, { headers: this._headers() });
    if (res.status === 404) {
      res = await fetch(`${base}/releases`, {
        method: "POST",
        headers: this._headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          tag_name: TAG,
          name: "StockScout データストア(自動管理・触らないでください)",
          body: "このリリースは StockScout のバッチが価格データを保存するためだけに使っています。手動で編集・削除しないでください。",
          draft: false,
          prerelease: false,
        }),
      });
    }
    if (!res.ok) throw new Error(`リリース取得/作成に失敗(HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  /** バイナリをダウンロード。見つからなければ null。 */
  async download(name) {
    const release = await this._ensureRelease();
    const asset = (release.assets || []).find((a) => a.name === name);
    if (!asset) return null;
    const res = await fetch(`${API}/repos/${this.owner}/${this.repo}/releases/assets/${asset.id}`, {
      headers: this._headers({ Accept: "application/octet-stream" }),
    });
    if (!res.ok) throw new Error(`アセットダウンロード失敗(HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** バイナリをアップロード。同名アセットがあれば削除してから新規作成する。 */
  async upload(name, buffer, mimeType = "application/gzip") {
    const release = await this._ensureRelease();
    const existing = (release.assets || []).find((a) => a.name === name);
    if (existing) {
      const delRes = await fetch(`${API}/repos/${this.owner}/${this.repo}/releases/assets/${existing.id}`, {
        method: "DELETE", headers: this._headers(),
      });
      if (!delRes.ok && delRes.status !== 404) {
        throw new Error(`既存アセットの削除に失敗(HTTP ${delRes.status})`);
      }
    }
    // アップロード先は release ごとに固有の upload_url (テンプレート文字列)を使う
    const uploadBase = release.upload_url.replace("{?name,label}", "");
    const res = await fetch(`${uploadBase}?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: this._headers({ "Content-Type": mimeType }),
      body: buffer,
    });
    if (!res.ok) throw new Error(`アセットアップロード失敗(HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
}

/** 疎通確認: 小さなテストファイルを書いて読み戻す。
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node -e \
 *     "import('./batch/github-store.mjs').then(m=>m.selfTest())"
 */
export async function selfTest() {
  const gs = new GitHubStore({});
  console.log("1. 書き込みテスト...");
  const payload = Buffer.from(JSON.stringify({ hello: "stockscout", at: new Date().toISOString() }));
  await gs.upload("stockscout-selftest.json", payload, "application/json");
  console.log("   OK");
  console.log("2. 読み戻しテスト...");
  const buf = await gs.download("stockscout-selftest.json");
  console.log("   OK:", buf.toString().slice(0, 80));
  console.log("\nGitHub Releases 連携は正常です。");
}
