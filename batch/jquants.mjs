/**
 * jquants.mjs — J-Quants API クライアント(V2 / Light プラン想定)
 * ----------------------------------------------------------------------------
 * ■ 重要な経緯(このファイルを V1→V2 に書き直した理由)
 *   当初 V1 仕様(リフレッシュトークン→IDトークンの2段階認証、
 *   /v1/prices/daily_quotes 等のパス)で実装していたが、実際にユーザーが
 *   スモークテストを実行したところ次のエラーが返ってきた:
 *     "J-QuantsはV2に移行しました。" (HTTP 410)
 *   調査の結果、J-Quants は2025年12月にV2をリリースし、V1は2026年6月1日に
 *   完全廃止されていたことが判明した(開発時点の情報が古かった)。
 *   V2 では認証方式そのものが「トークン方式」から「APIキー方式」に
 *   変わっており、この修正は単なるパス変更では済まなかった。
 *
 * ■ V2 の認証(旧V1との最大の違い)
 *   J-Quants ダッシュボードの「API Keys」ページから API キーを発行し、
 *   リクエストヘッダ `x-api-key: {APIキー}` を付けるだけでよい。
 *   旧V1のような「リフレッシュトークン→IDトークン」の2段階交換は不要になった。
 *
 * ■ 未検証の注意(これは今回も変わらず)
 *   開発サンドボックスのネットワーク制限で api.jquants.com への接続確認が
 *   できていない。V2のエンドポイント名・レスポンスの各フィールド名は
 *   公式ドキュメント・移行ガイドの記載に基づくが、"レスポンスの列名が
 *   省略形に変わる場合がある"という公式の注記があり、実際の省略形の
 *   一覧までは確認できていない。そのため本クライアントは正規化処理を
 *   持ち、複数の想定パターン(フル名/省略形/配列直下)を許容し、
 *   想定外の形が来た場合はエラーメッセージに生レスポンスの先頭を含めて
 *   投げる設計にしてある。selfTest() のエラーメッセージをそのまま
 *   共有してもらえれば、その場でパーサを実データに合わせて直せる。
 *
 * ■ Light プランのデータ制約(V1/V2 共通)
 *   ・株価: 過去5年前まで取得可能(それ以前は不可)
 *   ・財務情報(/fins/statements): "サマリー"レベルのみ。
 *     貸借対照表・キャッシュフロー計算書の明細(/fins/fs_details)は
 *     Standard プラン以上でないと取得できない。
 *   ・信用取引残高、業種別空売り比率などは Standard 以上(該当手法は除外済み)。
 */

const BASE = "https://api.jquants.com/v2";

async function fetchJson(url, opts = {}, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, opts);
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min(2 ** i * 1000, 15000);
      console.warn(`  [retry] HTTP ${res.status} — ${wait}ms 待機して再試行 (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`J-Quants API error ${res.status} at ${url}: ${text.slice(0, 500)}`);
    }
    return res.json();
  }
  throw new Error(`J-Quants API: リトライ上限に達しました (${url})`);
}

/** 日付を YYYY-MM-DD → YYYYMMDD(ハイフン無し)へ。V2 はハイフン無しを使う例が多い。 */
function ymd(dateStr) {
  return dateStr.replaceAll("-", "");
}

/**
 * レスポンスから配列部分を取り出す。想定されるキー名の候補を順に試し、
 * どれにも一致しなければ配列そのもの(トップレベルが配列の場合)を返す。
 * 見つからない場合はエラーを投げ、実際のレスポンス構造をログに残す。
 */
function extractArray(data, candidateKeys, urlForError) {
  for (const k of candidateKeys) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  if (Array.isArray(data)) return data;
  throw new Error(
    `想定した配列キー(${candidateKeys.join("/")})が見つかりません。実際のレスポンス構造: ` +
    JSON.stringify(data).slice(0, 500) + ` (URL: ${urlForError})`
  );
}

export class JQuantsClient {
  constructor({ apiKey }) {
    if (!apiKey) throw new Error("apiKey が指定されていません(環境変数 JQUANTS_API_KEY)");
    this.apiKey = apiKey;
  }

  /** V2 では事前のトークン交換が不要。互換性のため呼べるようにしてあるだけの no-op。 */
  async authenticate() {
    return true;
  }

  _headers() {
    return { "x-api-key": this.apiKey };
  }

  /** 上場銘柄一覧。市場区分・33業種区分を含む。 */
  async listedInfo(date) {
    const q = date ? `?date=${ymd(date)}` : "";
    const data = await fetchJson(`${BASE}/listed/info${q}`, { headers: this._headers() });
    return extractArray(data, ["info", "data"], `${BASE}/listed/info`);
  }

  /**
   * 日次株価四本値(全銘柄・指定日)。
   */
  async dailyQuotesByDate(date) {
    let out = [];
    let cursor = null;
    do {
      const q = new URLSearchParams({ date: ymd(date) });
      if (cursor) q.set("cursor", cursor);
      const url = `${BASE}/equities/bars/daily?${q}`;
      const data = await fetchJson(url, { headers: this._headers() });
      out = out.concat(extractArray(data, ["daily_quotes", "data"], url));
      cursor = data.cursor || data.pagination_key || null;
    } while (cursor);
    return out.map(normalizeBar);
  }

  /**
   * 特定銘柄の株価四本値(期間指定)。初回のヒストリカル・バックフィル用。
   * from/to を省略すると「自分のプランで取得可能な最も古い日付〜最新」が返る仕様。
   * Light プランでは実質5年前までに丸められる。
   */
  async dailyQuotesByCode(code, from, to) {
    let out = [];
    let cursor = null;
    do {
      const params = { code };
      if (from) params.from = ymd(from);
      if (to) params.to = ymd(to);
      if (cursor) params.cursor = cursor;
      const q = new URLSearchParams(params);
      const url = `${BASE}/equities/bars/daily?${q}`;
      const data = await fetchJson(url, { headers: this._headers() });
      out = out.concat(extractArray(data, ["daily_quotes", "data"], url));
      cursor = data.cursor || data.pagination_key || null;
    } while (cursor);
    return out.map(normalizeBar);
  }

  /**
   * 財務情報(サマリーレベル)。DisclosedDate を必ず保持すること
   * (Look-ahead bias を防ぐ生命線)。
   *
   * ■ 修正の経緯
   *   当初 /fins/statements という V1 のパス名で実装していたが、実機での
   *   スモークテストで「エンドポイントが存在しない」(HTTP 403)というエラーが
   *   返ってきた。公式リファレンス(jpx-jquants.com/ja/spec/fin-summary)を
   *   確認したところ、V2 ではパスが /fins/summary に変わり、レスポンスの
   *   項目名も大幅に省略形化されていた(例: NetSales → Sales,
   *   OperatingProfit → OP, DisclosedDate → DiscDate 等)。
   *   normalizeStatement() で、この省略形を compute-features-jp.mjs が
   *   前提とするフル名へ変換して返す。これにより下流のコードは無修正で済む。
   */
  async statements(code) {
    let out = [];
    let cursor = null;
    do {
      const params = { code };
      if (cursor) params.cursor = cursor;
      const q = new URLSearchParams(params);
      const url = `${BASE}/fins/summary?${q}`;
      const data = await fetchJson(url, { headers: this._headers() });
      out = out.concat(extractArray(data, ["data", "statements"], url));
      cursor = data.cursor || data.pagination_key || null;
    } while (cursor);
    return out.map(normalizeStatement);
  }

  /** 取引カレンダー(営業日判定に使用) */
  async tradingCalendar(from, to) {
    const q = new URLSearchParams({ from: ymd(from), to: ymd(to) });
    const url = `${BASE}/markets/trading_calendar?${q}`;
    const data = await fetchJson(url, { headers: this._headers() });
    return extractArray(data, ["trading_calendar", "data"], url);
  }
}

/**
 * V2 /fins/summary の省略形フィールド名を、compute-features-jp.mjs が
 * 前提とするフル名へ変換する。マッピングは公式リファレンス
 * (jpx-jquants.com/ja/spec/fin-summary)のレスポンスサンプルで実際に
 * 確認したものであり、V1名からの推測ではない。
 */
function normalizeStatement(s) {
  return {
    DisclosedDate: s.DiscDate,
    DisclosedTime: s.DiscTime,
    LocalCode: s.Code,
    DisclosureNumber: s.DiscNo,
    TypeOfDocument: s.DocType,
    TypeOfCurrentPeriod: s.CurPerType,
    CurrentPeriodStartDate: s.CurPerSt,
    CurrentPeriodEndDate: s.CurPerEn,
    CurrentFiscalYearStartDate: s.CurFYSt,
    CurrentFiscalYearEndDate: s.CurFYEn,
    NextFiscalYearStartDate: s.NxtFYSt,
    NextFiscalYearEndDate: s.NxtFYEn,
    NetSales: s.Sales,
    OperatingProfit: s.OP,
    OrdinaryProfit: s.OdP,
    Profit: s.NP,
    EarningsPerShare: s.EPS,
    DilutedEarningsPerShare: s.DEPS,
    TotalAssets: s.TA,
    Equity: s.Eq,
    EquityToAssetRatio: s.EqAR,
    BookValuePerShare: s.BPS,
    CashFlowsFromOperatingActivities: s.CFO,
    CashFlowsFromInvestingActivities: s.CFI,
    CashFlowsFromFinancingActivities: s.CFF,
    CashAndEquivalents: s.CashEq,
    // 予想配当(合計=年間) → 既存コードの ForecastDividendPerShareAnnual に対応
    ForecastDividendPerShareAnnual: s.FDivAnn,
    ResultDividendPerShareAnnual: s.DivAnn,
    PayoutRatioAnnual: s.PayoutRatioAnn,
    // 期末発行済株式数 - 自己株式数 = 実質的な流通株式数。
    // V1 には無かった項目で、これにより PSR 等を近似(比率トリック)ではなく
    // 直接計算できるようになった。ShOutFY が空の開示もあるため null 許容。
    SharesOutstanding: numOrNull(s.ShOutFY) != null && numOrNull(s.TrShFY) != null
      ? numOrNull(s.ShOutFY) - numOrNull(s.TrShFY) : null,
  };
}
function numOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * V2 のレスポンスが省略形の列名で返ってくる可能性に備えた正規化。
 * compute-features-jp.mjs は Adjustment* というフル名を前提にしているため、
 * ここで必ずフル名の形に揃えてから返す。
 * 省略形の実際の対応(Op/Hi/Lo/Cl/Vo 等)が判明したら、ここに追記するだけで
 * 下流のコードには一切手を入れずに済む。
 */
function normalizeBar(b) {
  const pick = (...keys) => {
    for (const k of keys) if (b[k] !== undefined) return b[k];
    return undefined;
  };
  return {
    Date: pick("Date", "date"),
    Code: pick("Code", "code"),
    Open: pick("Open", "O", "Op"),
    High: pick("High", "H", "Hi"),
    Low: pick("Low", "L", "Lo"),
    Close: pick("Close", "C", "Cl"),
    Volume: pick("Volume", "Vo", "V"),
    TurnoverValue: pick("TurnoverValue", "Tv"),
    AdjustmentFactor: pick("AdjustmentFactor", "AdjF") ?? 1.0,
    AdjustmentOpen: pick("AdjustmentOpen", "AdjO", "AdjOpen") ?? pick("Open", "O", "Op"),
    AdjustmentHigh: pick("AdjustmentHigh", "AdjH", "AdjHigh") ?? pick("High", "H", "Hi"),
    AdjustmentLow: pick("AdjustmentLow", "AdjL", "AdjLow") ?? pick("Low", "L", "Lo"),
    AdjustmentClose: pick("AdjustmentClose", "AdjC", "AdjClose") ?? pick("Close", "C", "Cl"),
    AdjustmentVolume: pick("AdjustmentVolume", "AdjVo", "AdjV") ?? pick("Volume", "Vo", "V"),
  };
}

/**
 * 簡易スモークテスト。初回導入時にこれだけ動かして API 疎通を確認する。
 *   JQUANTS_API_KEY=xxx node -e "import('./batch/jquants.mjs').then(m=>m.selfTest())"
 */
export async function selfTest() {
  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) {
    console.error("環境変数 JQUANTS_API_KEY が未設定です。");
    console.error("J-Quants ダッシュボードの「API Keys」ページから発行してください");
    console.error("(旧バージョンのリフレッシュトークンとは別物です)。");
    process.exit(1);
  }
  const client = new JQuantsClient({ apiKey });

  console.log("1. トヨタ自動車(7203)の直近の株価を取得...");
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 20 * 86400_000).toISOString().slice(0, 10);
  const quotes = await client.dailyQuotesByCode("7203", from, to);
  console.log(`   OK: ${quotes.length} 件取得`);
  if (quotes.length) console.log("   直近1件:", quotes[quotes.length - 1]);
  else console.log("   [警告] 0件でした。日付範囲や休日を確認してください。");

  console.log("\n2. トヨタ自動車の財務情報(直近1件)を取得...");
  const stmts = await client.statements("7203");
  const last = stmts[stmts.length - 1];
  console.log(`   OK: ${stmts.length} 件取得。最新開示日 = ${last?.DisclosedDate}`);

  console.log("\nすべて成功。フルバッチ(build-snapshot.mjs)を実行してよい状態です。");
}
