# StockScout — セットアップ手順

## 最初にお読みください: このコードの検証状況

このコード一式は、開発サンドボックスのネットワーク制限(`api.jquants.com` /
`stooq.com` / `script.google.com` がアクセス許可リストに無い)により、
**実際の外部APIに接続してのテストができていません。**

代わりに以下の方法で検証しています。
- J-Quants / Stooq / GAS の公式ドキュメントに基づき、実際のレスポンス形式を
  模したフィクスチャ(ダミーデータ)を作成
- そのフィクスチャで `fetch` をモックし、認証 → 取得 → 特徴量計算 →
  スクリーニング → バックテスト → JSON出力 の全パイプラインを実行し、
  エラーなく完走してファイルが生成されること、そのファイルが
  フロントエンドのロジック(`logic.mjs`)と矛盾なく統合できることを確認

したがって「ロジックは正しいはずだが、実際のAPIとの疎通は未確認」という
状態です。**導入時は必ず下記の手順1〜3のスモークテストを先に行ってください。**

### 追記: J-Quants V1→V2 移行について

開発時点(2026年7月)の情報に基づき当初 V1 仕様(リフレッシュトークン方式)
で実装したが、実際にユーザーがスモークテストを実行したところ
「J-QuantsはV2に移行しました」というエラーが返ってきた。調査の結果、
V1は2026年6月1日に完全廃止されていたことが判明し、認証方式そのものが
「トークン方式」→「APIキー方式」に変わっていたため、`batch/jquants.mjs`
を全面的に書き直した。以下の手順は**V2(APIキー方式)基準**に更新済み。

---

## 1. J-Quants の準備

1. https://jpx-jquants.com でLightプランに登録済みであることを確認
2. ダッシュボードにログインし、「API Keys」のページを開く
3. APIキーを発行してコピーしておく(**旧バージョンのリフレッシュトークンとは
   別物**。以前取得したリフレッシュトークンはV2では使えないので、
   お手数ですが新しくAPIキーを発行し直してください)

4. 疎通確認(これが今回**唯一まだ動作未確認**の最重要ステップです)。

   **どこで**: パソコンの「ターミナル」アプリ(Mac は「ターミナル」、
   Windows は「PowerShell」または「コマンドプロンプト」)を開きます。
   Claude Code や VS Code を使っている場合は、そこに内蔵されている
   ターミナル欄でも構いません。

   **何をするか**: 以下を1行ずつ実行します。

   a) このプロジェクト(`stockscout` フォルダ、`StockScout.jsx` が入っている場所)
      に移動する。フォルダをダウンロード・展開した場所に合わせてパスを変えてください:
      ```
      cd path/to/stockscout
      ```
      (例: デスクトップに展開した場合は `cd ~/Desktop/stockscout`)

   b) Node.js がインストールされているか確認する(バージョン番号が表示されればOK。
      「command not found」と出た場合は https://nodejs.org から先にインストールする):
      ```
      node -v
      ```

   c) 以下のコマンドを、`お手持ちのAPIキー` の部分だけ実際のAPIキーの
      文字列に置き換えて実行する。

      **Mac/Linux(ターミナル)の場合、1行で:**
      ```
      JQUANTS_API_KEY=お手持ちのAPIキー node -e "import('./batch/jquants.mjs').then(m=>m.selfTest())"
      ```

      **Windows(PowerShell)の場合、2行に分けて1行ずつEnter:**
      ```
      $env:JQUANTS_API_KEY="お手持ちのAPIキー"
      node -e "import('./batch/jquants.mjs').then(m=>m.selfTest())"
      ```

   **何が起きるか**: コンソールに「1. トヨタ自動車(7203)の直近の株価を
   取得...」「2. トヨタ自動車の財務情報...」といったログが順に表示されます。
   最後に「すべて成功。」と出れば、J-Quants への接続は正常です。途中で赤い
   エラーメッセージが出た場合は、そのメッセージをそのままコピーして
   共有してください(想定と違うレスポンス構造が来た場合、エラーメッセージに
   実際のデータ構造が含まれるようにしてあるので、それを見ればすぐに直せます)。

## 2. 米国株データソースの準備

### 2a. GAS(Google Apps Script)プロキシのデプロイ

`gas/USStockProxy.gs` のファイル冒頭コメントに手順を記載しています。要約:

1. https://script.google.com で新規プロジェクト作成
2. `USStockProxy.gs` の内容を貼り付け
3. デプロイ → 新しいデプロイ → ウェブアプリとして公開
4. 発行されたURLを控える(例: `https://script.google.com/macros/s/XXXX/exec`)
5. ブラウザで `{URL}?tickers=AAPL,MSFT` にアクセスし、JSONが返ることを確認

### 2b. Stooq

認証不要。特別な準備は不要ですが、初回は下記で疎通確認してください。
```
node -e "import('./batch/stooq.mjs').then(m=>m.fetchStooqHistory('aapl')).then(d=>console.log(d.length,'件取得', d.slice(-2)))"
```

## 3. GitHub Secrets の設定

リポジトリの Settings → Secrets and variables → Actions で以下を登録:

| Secret名 | 内容 |
|---|---|
| `JQUANTS_API_KEY` | 手順1で発行したAPIキー |
| `GAS_US_STOCK_PROXY_URL` | 手順2aで発行されたウェブアプリURL |
| `DISCORD_WEBHOOK_URL` | Discordのチャンネル設定 → 連携サービス → Webhook で発行 |

## 4. 初回の手動実行

1. Actions タブ → "StockScout Daily Batch" → "Run workflow" で手動実行
2. ログを確認し、`snapshot.json` / `history.json` が生成されることを確認
3. `DATA_LIMITATIONS.md` を見て、想定通りの手法が0件になっているか
   (=データが無く正直に0件を返している)を確認する

## 5. ユニバース(対象銘柄)のカスタマイズ

デフォルトでは `logic.mjs` の `JP_NAMES`(50銘柄)・`US_NAMES`(40銘柄)を使う。
増やしたい場合は `batch/universe-jp.json` / `batch/universe-us.json` に
`[["コード","名称","業種"], ...]` の形式で配置すると、そちらが優先される。

**銘柄数を増やすと比例して以下が増える点に注意:**
- J-Quants への API リクエスト数(実質的なレート制限は非公開のため保守的に)
- `history.json` のファイルサイズ(40MBを超えると警告が出る設計)
- GitHub Actions の実行時間(45分でタイムアウトする設定)

## 6. デプロイ(Vercel)

ビルド構成一式(`package.json` / `vite.config.js` / `index.html` / `src/main.jsx`)は
既にリポジトリに含めてあります。手元で `npm install && npm run build` が
通ることは確認済みです(Vercel が実行するのと同じコマンド)。

1. https://vercel.com で GitHub アカウント連携してログイン
2. "Add New" → "Project" → このリポジトリを選択
3. Framework Preset は "Vite" が自動検出されるはず(されない場合は手動選択)。
   Build Command / Output Directory はデフォルト(`npm run build` / `dist`)のままでよい
4. 環境変数を設定(Settings → Environment Variables):
   | 変数名 | 値 |
   |---|---|
   | `SITE_USER` | サイトのログインIDにしたい任意の文字列 |
   | `SITE_PASSWORD` | サイトのログインパスワードにしたい任意の文字列 |
5. Deploy を実行

これで `main` ブランチに push されるたびに自動で再デプロイされます。
GitHub Actions の日次バッチが `public/data/snapshot.json` を直接コミットする
設計なので、**バッチが走るたびに自動的に最新データがサイトに反映されます**
(追加の作業は不要)。

### 認証について

Vercel の無料(Hobby)プランには本番URLを守る「Password Protection」機能が
無く(Pro プランで追加料金)、代わりに `middleware.js` で自前の簡易
Basic認証(ID/パスワード)をかけています。上記の環境変数を設定して
デプロイすれば、サイトを開いたときにブラウザ標準の認証ダイアログが
表示されます。強固な認証ではありませんが、無関係な第三者からの
アクセスを防ぐという目的には十分です。

### 未検証の注意

開発サンドボックスから vercel.com へ接続できないため、実際に Vercel 上に
デプロイして動作確認することはできていません。`npm run build` がローカルで
正常終了することは確認済みですが、Vercel 上でのデプロイ自体・
`middleware.js` の Basic 認証の動作は、実際にデプロイした際に確認してください。
うまくいかない場合はエラーメッセージを共有してください。

## 7. ポートフォリオ通知の設定

保有銘柄をバッチにも認識させたい場合は、リポジトリ直下に `portfolio.json` を
以下の形式で配置する(アプリ内の「保有」タブで入力した内容とは現状連動していない。
アプリ側はブラウザの localStorage に保存されるため。両者を連携させるには
バックエンドAPIが必要になり、現在の「サーバを持たない」設計から外れるため、
当面は手動で `portfolio.json` を更新する運用とする):

```json
[
  { "code": "7203", "market": "JP", "costBasis": 2800, "shares": 100, "stId": "mom_12_1" }
]
```

## 既知の制約(必ず DATA_LIMITATIONS.md も参照)

- J-Quants Light: 株価5年まで、財務情報はサマリーのみ
- 米国株: ROE・ROIC・FCF等の詳細財務は無料では取得できておらず、該当手法は0件表示になる
- ベータ・市場レジームは、本来は指数(TOPIX/S&P500)を使うべきだが有料プラン限定のため、
  ユニバース自体の平均で代用する近似値
- アプリ内のポートフォリオ(localStorage)とバッチの `portfolio.json` は現状手動同期
