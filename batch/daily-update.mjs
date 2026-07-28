/**
 * daily-update.mjs — 毎日の差分更新(軽量)
 * ----------------------------------------------------------------------------
 * やること:
 *   1. ストアを読み込む(Google Drive または local)
 *   2. 日本株: 前回更新日の翌日〜今日の各営業日について、
 *      「その日の全銘柄分」を1回のAPI呼び出しで取得し、ユニバース分だけ追記
 *      (旧設計の「1銘柄ずつ5年分を毎日取り直す」を廃止した中核ポイント)
 *   3. 日本株の財務情報: その日に開示があった分だけを日付指定で取得して追記
 *   4. 米国株: Stooq から日付範囲指定で不足分だけ取得(1銘柄1リクエストだが
 *      数日分の小さなCSVなので軽い)
 *   5. ストアを保存
 *   6. build-outputs.mjs を呼んで snapshot.json / backtest.json を再計算
 *
 * データは削除しない(追記のみ)。ウィンドウは「5年+経過日数」と伸び続ける。
 */
import { JQuantsClient } from "./jquants.mjs";
import { fetchStooqHistoryRange } from "./stooq.mjs";
import { loadStore, saveStore, appendBars, appendStmts, quoteToBar, stooqToBar } from "./store.mjs";
import { buildOutputs } from "./build-outputs.mjs";

const TODAY = new Date().toISOString().slice(0, 10);

function* datesBetween(fromExclusive, toInclusive) {
  const d = new Date(fromExclusive);
  const end = new Date(toInclusive);
  while (true) {
    d.setDate(d.getDate() + 1);
    if (d > end) break;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; // 土日はスキップ(祝日はAPIが空を返すだけ)
    yield d.toISOString().slice(0, 10);
  }
}

async function main() {
  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) { console.error("JQUANTS_API_KEY が未設定です"); process.exit(1); }
  const client = new JQuantsClient({ apiKey });

  console.log("=== 1. ストア読み込み ===");
  const store = await loadStore();
  const jpCodes = new Set(Object.keys(store.jp));
  const usTickers = Object.keys(store.us);
  if (jpCodes.size === 0 && usTickers.length === 0) {
    console.error("ストアが空です。先に backfill.mjs を実行してください。");
    process.exit(1);
  }
  const lastDate = store.updatedAt || "2020-01-01";
  console.log(`  前回更新: ${lastDate} → 今日: ${TODAY}`);

  console.log("\n=== 2. 日本株の差分取得(日付単位の一括API) ===");
  let jpDays = 0, jpRows = 0;
  /* 実際にデータを確認できた最後の日。これを updatedAt として保存する。
     単純に「今日の日付」を保存すると、市場休場と「まだ配信されていない」
     を区別できず、後者のケースでその日のデータを永久に取り損ねる事故が
     起きる(このバッチをこれまでより早い時間に動かすようにしたため、
     当日分の配信タイミングに引っかかるリスクが実際に生じている)。 */
  let lastConfirmedDate = lastDate;
  let calendarCache = null;

  for (const date of datesBetween(lastDate, TODAY)) {
    try {
      const quotes = await client.dailyQuotesByDate(date);
      if (!quotes.length) {
        /* 空データ。過去の日付ならほぼ確実に休場(公表から十分時間が
           経っている)。だが「今日」(=このバッチを走らせている当日)だけは、
           単に配信がまだ来ていないだけの可能性がある。取引カレンダーで
           本当に休場かどうかを確認してから判断する。 */
        if (date === TODAY) {
          if (!calendarCache) {
            try { calendarCache = await client.tradingCalendar(date, date); } catch (e) { calendarCache = []; }
          }
          const cal = calendarCache.find((c) => (c.Date || c.date) === date);
          const isTradingDay = cal && ["1", "2", "3"].includes(String(cal.HolidayDivision));
          if (isTradingDay) {
            console.log(`  ${date}: 取引日だが株価データが未配信のようです。今回はスキップし、次回の実行で再取得します。`);
            break; // これ以降の日付もまだ無いはずなので抜ける。lastConfirmedDate は前日のまま
          }
        }
        console.log(`  ${date}: データなし(休場)`);
        lastConfirmedDate = date;
        continue;
      }
      let applied = 0;
      for (const q of quotes) {
        const code = String(q.Code ?? "").slice(0, 4);
        if (!jpCodes.has(code)) continue;
        appendBars(store.jp[code], [quoteToBar(q)]);
        applied++;
      }
      jpDays++; jpRows += applied;
      lastConfirmedDate = date;
      console.log(`  ${date}: ${applied} 銘柄分を追記`);
    } catch (e) {
      console.warn(`  ${date}: 取得失敗 (${e.message.slice(0, 100)}) — この日はスキップし次回再取得します`);
      break; // 失敗した日以降は連鎖的に狂う可能性があるため、ここで打ち切る
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`  日本株: ${jpDays}営業日 / のべ${jpRows}行を追記 / 確認済み最終日 ${lastConfirmedDate}`);

  console.log("\n=== 3. 日本株 財務情報の差分取得(開示日単位) ===");
  for (const date of datesBetween(lastDate, lastConfirmedDate)) {
    try {
      const stmts = await client.statementsByDate(date);
      let applied = 0;
      for (const s of stmts) {
        const code = String(s.LocalCode ?? "").slice(0, 4);
        if (!jpCodes.has(code)) continue;
        appendStmts(store.jp[code], [s]);
        applied++;
      }
      if (applied) console.log(`  ${date}: ${applied} 件の開示を追記`);
    } catch (e) {
      console.warn(`  ${date}: 財務取得失敗 (${e.message.slice(0, 100)})`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("\n=== 4. 米国株の差分取得(Stooq 日付範囲指定) ===");
  let usOk = 0, usFail = 0;
  for (const t of usTickers) {
    const bars = store.us[t].bars || [];
    const last = bars.length ? bars[bars.length - 1][0] : "2021-01-01";
    if (last >= TODAY) { continue; }
    try {
      const rows = await fetchStooqHistoryRange(t, last, TODAY);
      appendBars(store.us[t], rows.map(stooqToBar));
      usOk++;
    } catch (e) { usFail++; }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`  米国株: 更新${usOk} / 失敗${usFail}`);

  console.log("\n=== 5. ストア保存 ===");
  /* 「今日の日付」ではなく、実際にデータを確認できた最終日を明示的に渡す。
     もし本日分がまだ配信されていなければ lastConfirmedDate は前回のままなので、
     次回の実行が正しく本日分から再取得できる。 */
  await saveStore(store, lastConfirmedDate);

  console.log("\n=== 6. 出力の再計算(snapshot.json / backtest.json) ===");
  await buildOutputs(store);

  console.log("\n日次更新 完了。");
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error("日次更新 異常終了:", e); process.exit(1); });
export { main };
