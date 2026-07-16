/**
 * USStockProxy.gs — Google Apps Script
 * ----------------------------------------------------------------------------
 * GOOGLEFINANCE() は Google スプレッドシートの関数としてのみ動作し、外部から
 * 直接 HTTP で呼べない。そこで GAS(スプレッドシートに紐づくスクリプト)を
 * Web アプリとして公開し、doGet() 経由で JSON を返す「プロキシ」にする。
 *
 * ■ できること
 *   ・現在値、PER、EPS、配当利回り、時価総額、52週高値安値、ベータ
 *   （GOOGLEFINANCE の "price","pe","eps","yield","marketcap",
 *     "high52","low52","beta" 属性がベース）
 *
 * ■ できないこと(DATA_LIMITATIONS.md 参照)
 *   ・ROE, ROIC, 営業CF, 自己資本等の詳細財務(GOOGLEFINANCE では取得不可)
 *   ・日次ヒストリカルの安定取得(→ Stooq を使用。stooq.mjs 参照)
 *
 * ■ デプロイ手順
 *   1. https://script.google.com で新規プロジェクトを作成
 *   2. このファイルの内容を貼り付け
 *   3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *      - 実行するユーザー: 自分
 *      - アクセスできるユーザー: 全員(URLを知っていればよい。認証は
 *        GitHub Actions の Secrets で URL 自体を秘匿することで代替する)
 *   4. 発行された「ウェブアプリURL」を GitHub Secrets の
 *      GAS_US_STOCK_PROXY_URL に登録する
 *   5. 動作確認: ブラウザで
 *      {ウェブアプリURL}?tickers=AAPL,MSFT
 *      にアクセスし、JSONが返ることを確認する
 *
 * ■ 注意
 *   GOOGLEFINANCE は同時に大量のシンボルを問い合わせるとエラーになりやすい。
 *   このスクリプトは1回のリクエストで最大20銘柄までに制限している。
 *   40銘柄(US_NAMES)を取得するには2回に分けて呼び出すこと(batch側で対応済み)。
 */

const MAX_TICKERS_PER_CALL = 20;
const FIELDS = ["price", "pe", "eps", "high52", "low52", "marketcap", "yieldpct", "beta"];

function doGet(e) {
  const tickersParam = e.parameter.tickers || "";
  const tickers = tickersParam.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean).slice(0, MAX_TICKERS_PER_CALL);

  if (!tickers.length) {
    return respond({ error: "tickers パラメータが指定されていません。例: ?tickers=AAPL,MSFT" });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("proxy_work") || ss.insertSheet("proxy_work");
  sheet.clear();

  // 1列目にティッカー、2列目以降に各 GOOGLEFINANCE 属性の数式を並べて一括評価させる
  // (1銘柄ずつ関数呼び出しすると Google 側のクォータに掛かりやすいため、
  //  シート上での一括計算にまとめている)
  const rows = tickers.map((t, i) => {
    const row = [t];
    for (const f of FIELDS) {
      row.push(`=IFERROR(GOOGLEFINANCE("${t}","${f}"),"")`);
    }
    return row;
  });
  sheet.getRange(1, 1, rows.length, rows[0].length).setFormulas(
    rows.map((r) => r.map((v, i) => (i === 0 ? v : v)))
  );
  // 数式の再計算を待つ(GOOGLEFINANCE は非同期的に値が入るため)
  SpreadsheetApp.flush();
  Utilities.sleep(1500);

  const values = sheet.getRange(1, 1, rows.length, rows[0].length).getValues();
  const result = values.map((row) => {
    const [ticker, price, pe, eps, high52, low52, marketcap, yieldpct, beta] = row;
    return {
      ticker,
      price: numOrNull(price),
      per: numOrNull(pe),
      eps: numOrNull(eps),
      high52: numOrNull(high52),
      low52: numOrNull(low52),
      marketCap: numOrNull(marketcap),
      divYield: numOrNull(yieldpct) != null ? numOrNull(yieldpct) / 100 : null,
      beta: numOrNull(beta),
      fetchedAt: new Date().toISOString(),
    };
  });

  return respond({ data: result });
}

function numOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
