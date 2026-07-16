import React, { useState, useMemo, useEffect, useRef } from "react";

/* ============================================================================
   StockScout v0.1 — 日米株 マルチ手法スクリーニング & フォワードテスト
   ----------------------------------------------------------------------------
   ■ このファイルの位置づけ
     仕様書 §3.1 の「フロントエンド」層。サーバを持たず、日次バッチが吐いた
     静的JSON (/data/snapshot.json) を読むだけの構成。
     本ファイル単体で動くよう、JSONが無い場合は決定論的な検証用データを生成する。

   ■ データ差し替え方法
     DATA_SOURCE.load() を実装差し替えするだけ。他は一切触らない。
   ========================================================================== */

/* ---------------------------------------------------------------- 決定論PRNG */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/* ================================================================= 手法カタログ
   仕様書 §4 のプラグイン定義。1手法 = 1オブジェクト。
   screen() は asof 時点で入手可能なデータのみを受け取る（Look-ahead防御は
   バッチ側で強制。ここでは ctx が既にフィルタ済みである前提）。
   ============================================================================ */

const CAT = {
  momentum:  { label: "モメンタム",   color: "#B4531F" },
  value:     { label: "バリュー",     color: "#1B3A5C" },
  quality:   { label: "クオリティ",   color: "#2E6E62" },
  growth:    { label: "グロース",     color: "#6B3FA0" },
  lowvol:    { label: "低ボラ",       color: "#4A5A6A" },
  technical: { label: "テクニカル",   color: "#8A6D1F" },
  event:     { label: "イベント",     color: "#A63A28" },
  composite: { label: "複合",         color: "#0F5257" },
  original:  { label: "独自",         color: "#7D3C64" },
  flagship:  { label: "旗艦",         color: "#111820" },
};

const HORIZON = { swing: "スイング (数日〜数週)", mid: "中期 (数ヶ月)", long: "長期 (1年〜)" };

/* 各手法: id / 名前 / 説明 / 判定ロジック / 手仕舞い / 執行フィルタ適用可否 */
const STRATEGIES = [
  /* ---------------------------------------------------------------- 旗艦 */
  {
    id: "jfs_focus",
    name: "フォーカスリスト",
    subtitle: "Jeff Sun 流 スイング",
    cat: "flagship",
    horizon: "swing",
    markets: ["JP", "US"],
    trend: true,
    thesis:
      "相対力が先、セットアップは後。強い業種の中で相対力が突出し、値幅が収縮しきった銘柄だけを、出来高の裏付けを伴って買う。",
    detail: `【選定レイヤー — 完全再現】
1. 相対力ファースト: 指数対比の相対力(ボラティリティ調整済み=VARS)が上位であること。セットアップの美しさより先に、まず市場より強いことを要求する。
2. 業種グループの強さ: 属する業種グループ自体が相対力上位にあること(トップダウン)。
3. VCP(ボラティリティ収縮): 直近の値幅(ATR)が段階的に縮小していること。ゆるい値動きの銘柄は絶対に買わない。「跳ぶ前に必ずしゃがむ」。
4. 出来高の裏付け: 相対出来高(RVOL)が平均を明確に上回る日にブレイクしていること。出来高を伴わない値動きは必ず戻る。
5. 過熱度の上限: 50日移動平均からのATR乖離が4倍を超えていたら見送る。伸び切った株は追わない。
6. 流動性: 平均売買代金が閾値以上。スリッページで理論値が崩れるのを防ぐ。
7. 除外: バイオ関連はギャップリスクのため対象外。

【執行レイヤー — 日足への翻訳(再現度の限界を明示)】
本家のエッジの半分はザラ場にある。以下は日足バッチでは再現不可能:
  ✕ 寄り30分のRVOL実況監視
  ✕ 当日安値(LoD)がATRの60%以内という執行条件
  ✕ 寄り30分の高値(ORH)を基準としたエントリー
  ✕ 3段階ストップ(1トレードの損失を-0.67Rに抑える手法)
これらは前夜に確定できないため、本アプリは「前夜までに買い注文の準備が整った銘柄」までを提示し、
執行の可否判断は §執行チェックリスト として手渡す。ここを自動化したと偽らない。

【本アプリが出すもの】
・逆指値買いの目安価格(直近のピボット高値)
・初期ストップ(直近の収縮レンジ安値 or N×ATR の浅い方)
・そこから逆算した1R幅と、想定リスク%
・翌朝の手動チェック項目(出来高が伸びているか / ギャップアップしすぎていないか)`,
    exitRule:
      "10日移動平均割れで手仕舞い。+1Rで建値ストップへ。50日線からATR乖離が7倍付近に達したら一部利確。",
    score: (s) => {
      if (s.isBio) return null;
      if (s.advDollar < s.market_advDollarFloor) return null;
      if (s.atrExt > 4.0) return null;         // 過熱度上限
      if (s.ma200slope < 0) return null;       // 200日線が下向きなら買わない
      if (s.vars < 0.55) return null;          // 相対力ファースト
      if (s.groupRS < 0.6) return null;        // 業種グループの強さ
      if (s.vcp < 0.5) return null;            // 値幅が収縮しきっているか
      if (s.rvol < 1.4) return null;           // 出来高の裏付け
      const sc = 0.34 * s.vars + 0.22 * s.groupRS + 0.24 * s.vcp + 0.20 * Math.min(s.rvol / 3, 1);
      return sc;
    },
    strongAt: 0.78,
  },

  /* ------------------------------------------------------------ モメンタム */
  {
    id: "mom_12_1",
    name: "12ヶ月モメンタム",
    subtitle: "直近1ヶ月を除外",
    cat: "momentum",
    horizon: "mid",
    markets: ["JP", "US"],
    trend: true,
    thesis: "過去12ヶ月のリターンから直近1ヶ月を除いた値が上位の銘柄を順張りで持つ。",
    detail: `Jegadeesh & Titman (1993) 以来、日米を含むほぼ全市場で再現が報告されている最も頑健なアノマリーのひとつ。

直近1ヶ月を除外するのは、短期の反落(ショートターム・リバーサル)がモメンタムのシグナルを汚すため。ここを除かないと成績が明確に落ちる。

【弱点】トレンド転換時に「モメンタム・クラッシュ」を起こし、短期間で大きく崩れる。市場レジームフィルタ(指数が200日線を割れたら新規停止)との併用が前提。`,
    exitRule: "50日移動平均割れ、またはモメンタム順位が下位に転落した時点で手仕舞い。",
    score: (s) => (s.mom12_1 > 0.15 && s.ma200slope > 0 ? Math.min(s.mom12_1 / 0.8, 1) : null),
    strongAt: 0.7,
  },
  {
    id: "mom_52w",
    name: "52週高値接近",
    subtitle: "高値圏の粘り",
    cat: "momentum",
    horizon: "swing",
    markets: ["JP", "US"],
    trend: true,
    thesis: "52週高値からの下落率が小さい銘柄は、高値更新後の追随買いを集めやすい。",
    detail: `「高すぎて買えない」という心理的抵抗が、実際には利益機会になるという逆説的なアノマリー。投資家が高値を参照点として過小反応することが背景と説明される。

52週高値の近くにいること自体がシグナルであり、高値を更新した瞬間ではなく「更新する直前で粘っている」状態を捉える。`,
    exitRule: "52週高値から10%以上下落したら手仕舞い。",
    score: (s) => (s.dist52w > -0.05 && s.ma200slope > 0 ? 1 + s.dist52w / 0.05 : null),
    strongAt: 0.75,
  },
  {
    id: "pead",
    name: "決算ドリフト",
    subtitle: "サプライズ後の追随",
    cat: "momentum",
    horizon: "mid",
    markets: ["JP", "US"],
    trend: false,
    thesis: "決算サプライズの方向へ、株価は発表後も数週間〜数ヶ月かけて動き続ける。",
    detail: `PEAD (Post-Earnings Announcement Drift)。1960年代から報告され続けている、最も長寿命のアノマリー。市場が新情報に即座に完全反応しないという、効率的市場仮説への直接的な反証。

【実装上の急所】決算の「開示日」を厳密に持つこと。開示日より前にその決算数値を参照したら、それは未来を見ている(Look-ahead bias)。この手法は特にそのミスを犯しやすい。`,
    exitRule: "発表から60営業日経過、または次の決算発表日で手仕舞い。",
    score: (s) => (s.epsSurprise > 0.05 && s.daysSinceEarnings <= 45 && s.postEarnGap > 0.02
      ? Math.min(s.epsSurprise / 0.3, 1) * 0.6 + Math.min(s.postEarnGap / 0.1, 1) * 0.4 : null),
    strongAt: 0.72,
  },
  {
    id: "sector_mom",
    name: "セクター相対力",
    subtitle: "強い業種の中で買う",
    cat: "momentum",
    horizon: "mid",
    markets: ["JP", "US"],
    trend: true,
    thesis: "まず相対的に強い業種グループを特定し、その中の主導株だけを買う。",
    detail: `個別銘柄の値動きの相当部分は、その銘柄が属する業種の動きで説明される。弱い業種の中の強い銘柄より、強い業種の中の強い銘柄のほうが、はるかに続きやすい。

トップダウン: 市場 → セクター → 業種グループ → 個別銘柄 の順に絞る。この順序を逆にすると、業種の逆風に個別の努力が飲み込まれる。`,
    exitRule: "所属業種グループの相対力が上位から陥落した時点で手仕舞い。",
    score: (s) => (s.groupRS > 0.75 && s.rs > 0.6 ? s.groupRS * 0.5 + s.rs * 0.5 : null),
    strongAt: 0.8,
  },

  /* ---------------------------------------------------------------- バリュー */
  {
    id: "val_per_roe",
    name: "割安×高収益",
    subtitle: "バリュートラップ回避",
    cat: "value",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "低PERであると同時に高ROEであること。安いだけの株は、安いままである。",
    detail: `PERが低い銘柄には2種類ある。市場に見落とされている優良企業と、正しく安く評価されている劣後企業。前者だけを拾うために、収益性(ROE)を同時に要求する。

これは実質的にグレアムの発想の現代版であり、「安さ」と「質」の交差点を狙う。単独の低PERスクリーニングが長期で機能しにくい最大の理由が、この選別を欠くことにある。`,
    exitRule: "PERが市場平均水準まで回復した時点(=投資仮説の成就)、またはROEが基準を下回った時点。",
    score: (s) => (s.per > 0 && s.per < 13 && s.roe > 0.10
      ? (1 - s.per / 13) * 0.5 + Math.min(s.roe / 0.25, 1) * 0.5 : null),
    strongAt: 0.7,
  },
  {
    id: "val_pbr_decomp",
    name: "PBR分解",
    subtitle: "東証改革の本丸",
    cat: "value",
    horizon: "long",
    markets: ["JP"],
    trend: false,
    thesis: "PBR = ROE × PER。1倍割れの原因が収益性か市場評価かを分解し、改善余地のある側を特定する。",
    detail: `東証が2023年3月に「資本コストや株価を意識した経営」を要請して以降、日本株の物色軸を変えた最大のテーマ。2026年時点では「開示したか」から「実行しているか」へ評価軸が移っている。

【この手法の核心】
PBR1倍割れ銘柄を機械的に買うのではない。分解して、
  ・ROEは既に高いのにPBRが低い → 市場評価の問題。カタリスト待ちで報われやすい
  ・ROEが低いためPBRが低い → 事業の問題。還元強化だけでは解決しない
を切り分ける。前者だけを拾う。

【日本特有の追い風】政策保有株の縮減、過剰現預金の成長投資・株主還元への振り向け、累進配当/DOEの明示。これらを進める企業ほど是正余地が大きい。`,
    exitRule: "PBRが1.0倍を回復した時点で段階的に利確。ROEが8%を割ったら仮説崩壊として撤退。",
    score: (s) => (s.market === "JP" && s.pbr < 1.0 && s.roe > 0.08 && s.per > 0
      ? (1 - s.pbr) * 0.5 + Math.min(s.roe / 0.15, 1) * 0.5 : null),
    strongAt: 0.62,
  },
  {
    id: "val_fcf",
    name: "FCF利回り",
    subtitle: "会計操作に強い",
    cat: "value",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "実際に手元に残る現金を時価総額で割った利回り。利益より嘘をつきにくい。",
    detail: `純利益は会計方針の裁量で動かせるが、現金は動かせない。だからこそ機関投資家はFCF利回りを重視する。

マルチバガー研究(Yartseva 2025, 2009-2024年の米国10倍株464社の実証分析)でも、高いFCF利回りが超過リターンの重要な牽引要因として特定されている。単なるディフェンシブ指標ではなく、大化け株の共通項でもある点が重要。`,
    exitRule: "FCF利回りが市場平均まで低下した時点、またはFCFがマイナス転落した決算で撤退。",
    score: (s) => (s.fcfYield > 0.07 ? Math.min(s.fcfYield / 0.15, 1) : null),
    strongAt: 0.7,
  },
  {
    id: "val_ev_ebitda",
    name: "EV/EBITDA",
    subtitle: "資本構成の影響を除去",
    cat: "value",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "借入の多寡や減価償却の差を吸収して、事業そのものの価値を比較する。",
    detail: `PERは資本構成と会計方針の差で歪む。EV/EBITDAは有利子負債と現金を織り込んだ企業価値(EV)を使うため、レバレッジの異なる企業を横並びで比較できる。M&Aの実務で最も使われる倍率でもある。

【注意】設備投資が重い業種ではEBITDAが実力を過大評価する。FCF利回りとの併用が望ましい。`,
    exitRule: "同業種の中央値水準まで倍率が回復した時点。",
    score: (s) => (s.evEbitda > 0 && s.evEbitda < 6 ? 1 - s.evEbitda / 6 : null),
    strongAt: 0.65,
  },
  {
    id: "val_div",
    name: "高配当×健全性",
    subtitle: "配当性向で選別",
    cat: "value",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "高利回りでありながら、配当性向に余裕があり赤字でないこと。",
    detail: `利回りだけで選ぶと、株価下落によって見かけの利回りが上がっただけの銘柄(減配予備軍)を掴む。配当性向100%超と赤字企業を除外することで、その大半を排除できる。

【日本の文脈】東証要請以降、累進配当やDOE(株主資本配当率)を明示する企業が増えており、還元方針の「持続性」を読む価値が高まっている。`,
    exitRule: "減配発表、または配当性向が80%を超えた時点で見直し。",
    score: (s) => (s.divYield > 0.035 && s.payout > 0 && s.payout < 0.7 && s.netIncome > 0
      ? Math.min(s.divYield / 0.06, 1) * 0.7 + (1 - s.payout / 0.7) * 0.3 : null),
    strongAt: 0.72,
  },
  {
    id: "val_magic",
    name: "マジックフォーミュラ",
    subtitle: "益回り×資本効率",
    cat: "value",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "益回りの高さと投下資本利益率の高さ、2つの順位を合成して上位を買う。",
    detail: `Greenblattの手法。「良い会社を、安く買う」という一文をそのまま2指標に落とし込んだもの。

秀逸なのは、複雑な財務分析なしに「安さ」と「質」の両立を順位合成だけで実現している点。ただし提唱から時間が経ち、広く知られたことで超過収益は当初より縮小しているとの指摘もある。だからこそフォワードテストで自分の相場での有効性を測る価値がある。`,
    exitRule: "1年保有を基本とし、順位が上位から外れた時点でリバランス。",
    score: (s) => (s.earnYield > 0.08 && s.roic > 0.12
      ? Math.min(s.earnYield / 0.2, 1) * 0.5 + Math.min(s.roic / 0.3, 1) * 0.5 : null),
    strongAt: 0.72,
  },
  {
    id: "val_netnet",
    name: "ネットネット",
    subtitle: "グレアム流ディープバリュー",
    cat: "value",
    horizon: "long",
    markets: ["JP"],
    trend: false,
    thesis: "時価総額が「流動資産 − 総負債」を下回る、清算価値以下の銘柄。",
    detail: `グレアムの原点。理論上は会社を買い占めて解散させればお釣りが来る状態。日本の小型株には今なお一定数存在する。

【最大の弱点】これぞ典型的なバリュートラップの温床。安いのには理由があり、経営陣に還元意思がなければ永久に安いまま放置される。したがって東証の資本効率改善圧力(PBR分解手法)とセットで見るべきで、単独運用は推奨しない。分散(20銘柄以上)が前提。`,
    exitRule: "NCAV倍率が1.2倍を超えた時点、または2年経過で機械的に手仕舞い。",
    score: (s) => (s.market === "JP" && s.ncavRatio > 1.2 ? Math.min((s.ncavRatio - 1.2) / 0.8, 1) : null),
    strongAt: 0.6,
  },
  {
    id: "val_psr",
    name: "低PSR",
    subtitle: "赤字・景気敏感株向け",
    cat: "value",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "利益が振れる企業は、売上高を基準に割安度を測る。",
    detail: `利益は循環や一過性要因で大きく振れるが、売上は相対的に安定する。景気敏感株のボトム圏や、先行投資で赤字の成長企業の評価に有効。

【注意】売上があっても利益体質が無い企業は永遠に報われない。利益率の改善トレンドとの併用が必須で、単独では最も危険な指標のひとつ。`,
    exitRule: "PSRが業種中央値まで回復、または営業利益率の改善が止まった時点。",
    score: (s) => (s.psr > 0 && s.psr < 0.6 && s.opMarginTrend > 0 ? 1 - s.psr / 0.6 : null),
    strongAt: 0.65,
  },

  /* -------------------------------------------------------------- クオリティ */
  {
    id: "qual_piotroski",
    name: "Piotroski Fスコア",
    subtitle: "9項目の財務健全性",
    cat: "quality",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "収益性・財務健全性・効率性の9項目を各1点で採点し、高得点の割安株だけを買う。",
    detail: `低PBR株の中から「本当に良い会社」を選別するために設計された、最も検証が厚い複合スコア。

【9項目】
収益性: ①当期純利益>0 ②営業CF>0 ③ROE改善 ④営業CF>純利益(利益の質)
財務: ⑤負債比率低下 ⑥流動比率改善 ⑦新株発行なし
効率: ⑧粗利益率改善 ⑨総資産回転率改善

8点以上を合格とする。④の「営業CFが純利益を上回る」が特に効く。利益は出ているのに現金が入ってこない企業を弾けるため。

【実装上の制約】前期との比較が必須なので、財務データを最低2期分保持する必要がある。J-Quants の取得可能期間に注意。`,
    exitRule: "次年度のFスコアが6点以下に低下した時点で入れ替え。",
    score: (s) => (s.fscore >= 7 ? (s.fscore - 6) / 3 : null),
    strongAt: 0.66,
  },
  {
    id: "qual_roe_persist",
    name: "ROE継続性",
    subtitle: "まぐれでない高収益",
    cat: "quality",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "単年の高ROEではなく、3期以上連続して高ROEを維持していること。",
    detail: `単年の高ROEは、一過性の売却益や、たまたま自己資本が薄いだけでも達成できる。継続性を要求することで、構造的に稼ぐ力を持つ企業だけが残る。

高ROEが持続するということは、経済的な堀(参入障壁)が存在することを意味する。それが無ければ競合が参入し、ROEは資本コスト水準へ収斂するはずだから。継続性そのものが堀の存在証明になる。`,
    exitRule: "ROEが基準を2期連続で下回った時点(=堀の消失)。",
    score: (s) => (s.roeYears >= 3 && s.roe > 0.12 ? Math.min(s.roeYears / 5, 1) * 0.5 + Math.min(s.roe / 0.25, 1) * 0.5 : null),
    strongAt: 0.75,
  },
  {
    id: "qual_gross",
    name: "粗利益率",
    subtitle: "最も汚れていない収益性",
    cat: "quality",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "総資産に対する粗利益の大きさ。バリューと同等の予測力を持つ収益性指標。",
    detail: `Novy-Marx のグロス・プロフィタビリティ。損益計算書は下へ行くほど会計裁量が入り込むため、最上流の粗利益こそが最も汚染されていない収益力の指標である、という洞察。

面白いのは、この指標がバリューと負の相関を持つこと。グロス収益性の高い銘柄は「割高」に見えがちだが、それゆえバリュー戦略と組み合わせたときの分散効果が大きい。`,
    exitRule: "粗利益率が3期平均を明確に下回った時点。",
    score: (s) => (s.grossProf > 0.3 ? Math.min(s.grossProf / 0.6, 1) : null),
    strongAt: 0.7,
  },
  {
    id: "qual_accrual",
    name: "会計発生高",
    subtitle: "利益の質を疑う",
    cat: "quality",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "純利益と営業CFの乖離が小さい企業ほど、その後のリターンが高い。",
    detail: `アクルーアル・アノマリー。利益のうち現金の裏付けがない部分(会計発生高)が大きい企業は、将来の利益が続かず株価が沈む傾向がある。

これは不正会計を検出しているのではなく、より穏当に「積極的な会計処理」や「売上の先食い」を検出している。投資家は利益の数字に反応するが、その中身の質までは織り込まない、というのが超過収益の源泉。`,
    exitRule: "アクルーアルが悪化(乖離拡大)した決算で撤退。",
    score: (s) => (s.accrual < 0.02 ? Math.min((0.02 - s.accrual) / 0.1, 1) : null),
    strongAt: 0.7,
  },
  {
    id: "qual_roic",
    name: "ROIC超過",
    subtitle: "資本コストを上回るか",
    cat: "quality",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "投下資本利益率(ROIC)が資本コスト(WACC)を上回っている企業だけが価値を創造している。",
    detail: `ROIC > WACC でなければ、その企業は事業を営むほど株主価値を毀損している。会計上黒字でも、経済的には赤字ということが起こりうる。

東証が要請する「資本コストや株価を意識した経営」の理論的中核がこれ。日本企業の多くがROE8%未満という状況は、まさにこの超過分がゼロ近辺かマイナスであることを意味していた。

【実装上の難所】WACCは推定値であり、前提の置き方で数値が動く。ここでは業種別の概算値を用い、精緻さより一貫性を優先する。`,
    exitRule: "ROIC − WACC がマイナス転落した時点。",
    score: (s) => (s.roic - s.wacc > 0.05 ? Math.min((s.roic - s.wacc) / 0.15, 1) : null),
    strongAt: 0.7,
  },
  {
    id: "qual_altman",
    name: "財務安全性",
    subtitle: "Altman Zスコア",
    cat: "quality",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "倒産予測モデルを逆用し、破綻リスクの低い銘柄だけを残すフィルタとして使う。",
    detail: `Altman Zスコアは元々「倒産する企業を当てる」ためのモデル。本アプリではこれを推薦手法としてではなく、主に他手法の前段フィルタとして使う思想。

特にディープバリュー系(ネットネット、低PBR)と組み合わせる価値が高い。安い銘柄群の中には本当に潰れる会社が混ざっており、それを引くと分散の前提が壊れるため。`,
    exitRule: "Zスコアがグレーゾーンへ低下した時点で撤退。",
    score: (s) => (s.altmanZ > 3.0 ? Math.min((s.altmanZ - 3) / 3, 1) : null),
    strongAt: 0.7,
  },

  /* ---------------------------------------------------------------- グロース */
  {
    id: "grw_canslim",
    name: "CANSLIM",
    subtitle: "業績×需給×市況",
    cat: "growth",
    horizon: "mid",
    markets: ["JP", "US"],
    trend: true,
    thesis: "四半期・通期の利益成長、新高値、需給、機関投資家の買い、市場全体の方向を同時に要求する。",
    detail: `O'Neil の総合グロース投資法。ファンダメンタルとテクニカルと需給を1つの枠組みに統合した点が画期的だった。

【頭字語】
C: Current quarterly earnings — 直近四半期のEPS急増
A: Annual earnings — 通期の利益成長の継続
N: New — 新製品・新経営・新高値
S: Supply and demand — 発行株数の少なさと出来高の膨張
L: Leader — 業種内の主導株であること(2番手を買わない)
I: Institutional sponsorship — 機関投資家の保有増加
M: Market direction — 市場全体が上昇局面にあること

【Mが最重要】どれだけ完璧なCANSLI銘柄でも、市場が下落局面なら大半は失敗する。個別の分析より地合いが優先する、という思想は本アプリの市場レジーム表示に反映している。`,
    exitRule: "50日移動平均を出来高を伴って割れた時点、または-7〜8%の機械的損切り。",
    score: (s) => {
      if (!(s.epsGrowthQ > 0.25 && s.epsGrowthY > 0.2 && s.dist52w > -0.15 && s.rs > 0.7)) return null;
      return Math.min(s.epsGrowthQ / 1.0, 1) * 0.35 + Math.min(s.epsGrowthY / 0.5, 1) * 0.25 + s.rs * 0.4;
    },
    strongAt: 0.78,
  },
  {
    id: "grw_accel",
    name: "成長加速",
    subtitle: "伸び率の伸び",
    cat: "growth",
    horizon: "mid",
    markets: ["JP", "US"],
    trend: false,
    thesis: "成長率そのものではなく、成長率が加速している局面を捉える。",
    detail: `市場は成長率の水準は織り込むが、その二階微分(加速)には過小反応する傾向がある。前年比+20%が+35%になった瞬間こそが、株価の再評価が始まる点。

逆に、高成長でも減速し始めた銘柄は、絶対値がまだ高くても売られる。「良い数字」ではなく「変化の方向」を見るのがこの手法の本質。`,
    exitRule: "成長率の加速が止まった(減速に転じた)決算の翌日。",
    score: (s) => (s.salesAccel > 0.05 && s.opAccel > 0.05
      ? Math.min(s.salesAccel / 0.2, 1) * 0.4 + Math.min(s.opAccel / 0.3, 1) * 0.6 : null),
    strongAt: 0.72,
  },
  {
    id: "grw_peg",
    name: "PEGレシオ",
    subtitle: "成長を織り込んでも割安",
    cat: "growth",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "PERを利益成長率で割る。1.0を下回れば、成長を勘案してなお割安。",
    detail: `Lynchが広めた、バリューとグロースの橋渡し指標。「PER30倍は高いか?」という問いは、成長率を見ずには答えられない、という当たり前を数式にしたもの。

【弱点】分母の成長率が予想値であること。予想が外れればPEGは無意味になる。過去実績成長率を使うと保守的だが、成長の転換点を捉え損なう。ここでは実績ベースを採用し、堅く見積もる。`,
    exitRule: "PEGが1.5を超えた時点、または成長率の前提が崩れた決算。",
    score: (s) => (s.peg > 0 && s.peg < 1.0 && s.epsGrowthY > 0.1 ? 1 - s.peg : null),
    strongAt: 0.65,
  },
  {
    id: "grw_streak",
    name: "連続増収増益",
    subtitle: "安定成長株",
    cat: "growth",
    horizon: "long",
    markets: ["JP"],
    trend: false,
    thesis: "何期連続で増収かつ増益を続けているか。継続そのものを評価する。",
    detail: `日本の個人投資家に根強く支持される、シンプルだが侮れない手法。連続記録の維持は、経営陣が「途切れさせない」ことに強くコミットしていることの表れでもある。

【裏の読み】連続記録が長い企業ほど、記録維持のために保守的な会社予想を出す傾向がある。つまり上方修正の余地を織り込みやすい。これは日本市場特有の癖として利用価値がある。

【弱点】記録が途切れた瞬間の下落が大きい。長い記録は、その分だけ期待という名の負債を積み上げている。`,
    exitRule: "増収または増益が途切れた決算の翌日に無条件手仕舞い。",
    score: (s) => (s.market === "JP" && s.streak >= 4 ? Math.min(s.streak / 10, 1) : null),
    strongAt: 0.7,
  },

  /* ------------------------------------------------------------------ 低ボラ */
  {
    id: "lv_beta",
    name: "低ベータ",
    subtitle: "理論への反証",
    cat: "lowvol",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "リスクが低い銘柄ほどリスク調整後リターンが高いという、理論と真逆の現象。",
    detail: `低ボラティリティ・アノマリー。CAPMは「高ベータほど高リターン」と予測するが、現実は長期でその逆が観測される。資産価格理論に対する最も厄介な反例のひとつ。

【説明仮説】レバレッジをかけられない投資家が、高リターンを求めて高ベータ株に群がり、それを割高にする。宝くじ的な選好も同方向に働く。つまりこのアノマリーの源泉は制約と行動バイアスであり、それが解消されない限り消えにくい。

【弱点】強気相場では確実にアンダーパフォームする。それに耐えられるかが唯一の条件。`,
    exitRule: "ベータが上昇した(=性質が変わった)場合、または年次リバランス。",
    score: (s) => (s.beta > 0 && s.beta < 0.8 && s.netIncome > 0 ? 1 - s.beta / 0.8 : null),
    strongAt: 0.7,
  },
  {
    id: "lv_div",
    name: "ディフェンシブ配当",
    subtitle: "低ボラ×高配当",
    cat: "lowvol",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "値動きが穏やかで、かつ配当を出す銘柄。下落相場での耐性を重視する。",
    detail: `攻めるための手法ではなく、ポートフォリオ全体のドローダウンを浅くするための手法。他の攻撃的な手法(モメンタム、CANSLIM)と組み合わせたときに、相関の低さが効いてくる。

本アプリの「手法比較」画面で相関マトリクスを見る意味は、まさにここ。単体の成績が最も良い手法を並べても分散にはならず、相関の低い手法を混ぜて初めてエクイティカーブが滑らかになる。`,
    exitRule: "減配、またはボラティリティが上昇した時点。",
    score: (s) => (s.vol60 < 0.22 && s.divYield > 0.025 && s.netIncome > 0
      ? (1 - s.vol60 / 0.22) * 0.5 + Math.min(s.divYield / 0.05, 1) * 0.5 : null),
    strongAt: 0.72,
  },
  {
    id: "lv_stable",
    name: "業績安定性",
    subtitle: "利益のばらつきの小ささ",
    cat: "lowvol",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "過去の利益のばらつきが小さい企業は、将来も予測しやすく、評価が安定する。",
    detail: `景気循環の影響を受けにくい事業は、キャッシュフローの予測可能性が高く、結果として要求リターン(=資本コスト)が低くなる。それは理論上、より高いバリュエーションが正当化されることを意味する。

にもかかわらず市場が安定性を十分に評価していない局面では、超過収益が生じる。地味だが、長期保有において最も精神的に持ちやすい手法でもある。`,
    exitRule: "利益のばらつきが拡大した(=事業の性質が変わった)時点。",
    score: (s) => (s.earnStability > 0.7 && s.netIncome > 0 ? s.earnStability : null),
    strongAt: 0.82,
  },

  /* -------------------------------------------------------------- テクニカル */
  {
    id: "tech_po",
    name: "パーフェクトオーダー",
    subtitle: "移動平均の整列",
    cat: "technical",
    horizon: "swing",
    markets: ["JP", "US"],
    trend: true,
    thesis: "短期・中期・長期の移動平均が上から順に並び、すべて上向きである状態。",
    detail: `トレンドフォローの最も基本的な確認手段。移動平均が整列しているということは、あらゆる時間軸の参加者が含み益を持っていることを意味し、戻り売り圧力が構造的に弱い。

【弱点】定義上、必ず遅行する。整列が完成した頃には初動は終わっている。したがって単独のエントリーシグナルとしては弱く、他手法の「前提条件」として使うのが正しい使い方。本アプリでも多くの手法がこれを内部フィルタとして持つ。`,
    exitRule: "整列が崩れた(短期線が中期線を下抜けた)時点。",
    score: (s) => (s.perfectOrder && s.ma200slope > 0 ? 0.55 + Math.min(s.rs, 1) * 0.45 : null),
    strongAt: 0.8,
  },
  {
    id: "tech_breakout",
    name: "出来高ブレイク",
    subtitle: "節目突破 + 出来高裏付け",
    cat: "technical",
    horizon: "swing",
    markets: ["JP", "US"],
    trend: true,
    thesis: "レンジ上限を、平均を大きく上回る出来高を伴って突破した瞬間。",
    detail: `出来高を伴わないブレイクは、ほぼ必ず戻される。出来高の急増は「新たな買い手が本気で参入した」ことの唯一の客観的証拠であり、それ自体が品質フィルタとして機能する。

【なぜ効くか】強い出来高を伴った1日の値動きは、それまで3ヶ月分の値動きが作った物語を書き換える力を持つ。売り手が枯れ、買い手が主導権を握った瞬間が可視化されるため。

【日足での限界】本来はザラ場の相対出来高(RVOL)で判定すべきだが、日足バッチでは終値後の確定値しか使えない。したがって本アプリは「昨日ブレイクした」銘柄を提示することになり、1日出遅れる構造を持つ。この遅れは正直に認識しておく必要がある。`,
    exitRule: "ブレイクした節目を終値で割り込んだ時点。",
    score: (s) => (s.breakout && s.rvol > 1.5 && s.ma200slope > 0
      ? Math.min(s.rvol / 3, 1) * 0.6 + Math.min(s.rs, 1) * 0.4 : null),
    strongAt: 0.75,
  },
  {
    id: "tech_pullback",
    name: "押し目買い",
    subtitle: "上昇トレンド中の調整",
    cat: "technical",
    horizon: "swing",
    markets: ["JP", "US"],
    trend: true,
    thesis: "明確な上昇トレンドにある銘柄が、主要移動平均まで調整して反発する局面。",
    detail: `ブレイクアウトより有利なリスクリワードを得られる代わりに、「下落が調整なのかトレンド転換なのか」を見極める難度が高い。

【リスク管理上の優位】移動平均という明確な基準の直上で買えるため、ストップを浅く置ける。同じ利益目標に対して1Rが小さくなり、結果としてR倍数が跳ね上がる。タイトに執行することの威力はここにある。

【弱点】下降トレンド入りした銘柄も、途中までは「押し目」に見える。200日線の向きを絶対条件にすることでしか防げない。`,
    exitRule: "押し目の基準とした移動平均を明確に割り込んだ時点。",
    score: (s) => (s.ma200slope > 0 && s.rs > 0.6 && s.pullbackToMA && s.atrExt < 2
      ? 0.5 + Math.min(s.rs, 1) * 0.5 : null),
    strongAt: 0.78,
  },
  {
    id: "tech_squeeze",
    name: "ボラ収縮ブレイク",
    subtitle: "スクイーズからの膨張",
    cat: "technical",
    horizon: "swing",
    markets: ["JP", "US"],
    trend: true,
    thesis: "ボラティリティが極端に縮小した後には、大きな方向性のある動きが続く。",
    detail: `ボラティリティは平均回帰する。極端に縮んだ状態は必ず解消され、その解消はしばしば急激な方向性を伴う。「跳ぶ前にしゃがむ」という現象の統計的な裏付け。

VCP(ボラティリティ収縮パターン)と本質的に同じ現象を、別の物差しで測っているに過ぎない。したがって旗艦手法「フォーカスリスト」と高い相関を持つはずで、手法比較の相関マトリクスでそれが確認できれば、本アプリの計測が正しく機能している証拠になる。`,
    exitRule: "膨張が止まり、再びレンジに回帰した時点。",
    score: (s) => (s.squeeze && s.ma200slope > 0 && s.rvol > 1.2 ? 0.5 + s.vcp * 0.5 : null),
    strongAt: 0.78,
  },
  {
    id: "tech_rs_line",
    name: "相対力ライン新高値",
    subtitle: "指数に対する優位",
    cat: "technical",
    horizon: "mid",
    markets: ["JP", "US"],
    trend: true,
    thesis: "株価÷指数のラインが新高値をつけている銘柄。株価本体より先に動く。",
    detail: `相対力ラインは、しばしば株価本体に先行して新高値をつける。市場全体が停滞している間に、その銘柄だけが静かに買われ続けている状態を可視化する。

【使い方の核心】この指標の真価は下落相場で現れる。市場が下げている中で相対力ラインが上向きを保つ銘柄は、次の上昇局面の主導株になる確率が高い。「調整局面こそ次のリーダーを探す時間」というのは、ここに根拠がある。`,
    exitRule: "相対力ラインが下降トレンドに転じた時点。",
    score: (s) => (s.rsLineNewHigh && s.rs > 0.7 ? s.rs : null),
    strongAt: 0.82,
  },

  /* ------------------------------------------------------------------ イベント */
  {
    id: "ev_buyback",
    name: "自社株買い",
    subtitle: "需給改善 + EPS押上げ",
    cat: "event",
    horizon: "mid",
    markets: ["JP", "US"],
    trend: false,
    thesis: "自社株買いの発表後、需給改善とEPS押し上げの二重効果で株価が支えられる。",
    detail: `会社自身が「自社株は割安である」と表明する、最も強いシグナルのひとつ。しかも表明にとどまらず、実際に買い需要として市場に現れる。

【日本の文脈】東証の資本効率改善要請以降、PBR1倍割れ企業の自社株買い発表が急増し、発表を機に株価が急騰するケースが多い。特に過剰な現預金を抱えた企業ほど、還元余地が大きい。

【見極めのポイント】発表額が時価総額に対してどれだけ大きいか。1%の自社株買いは儀礼であり、5%を超えると本気。また「取得枠の設定」と「実際の取得」は別物で、枠だけ設定して買わない企業も存在する。実行率の追跡が本質。`,
    exitRule: "取得枠の消化完了、または発表から6ヶ月経過。",
    score: (s) => (s.buybackPct > 0.02 && s.daysSinceBuyback <= 30
      ? Math.min(s.buybackPct / 0.08, 1) : null),
    strongAt: 0.62,
  },
  {
    id: "ev_divhike",
    name: "増配・累進配当",
    subtitle: "還元姿勢の変化",
    cat: "event",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "増配や累進配当方針の表明は、経営陣の将来収益への自信を反映する。",
    detail: `配当は一度上げると下げにくい。だからこそ経営陣は、持続可能だと確信できる水準でしか増配しない。増配の発表は、外部には見えない将来見通しに関する内部情報の、最も信頼できる漏洩である。

【日本特有の変化】従来の日本企業は業績連動配当が主流で、悪化時に減配できる柔軟性を残していた。累進配当(減配しない)やDOEの明示は、その柔軟性を自ら手放す宣言であり、コミットメントの強さが従来と質的に異なる。この方針変更そのものが再評価のトリガーになる。`,
    exitRule: "減配、または方針の撤回。",
    score: (s) => (s.divHike && s.daysSinceDivHike <= 45 && s.payout < 0.7
      ? 0.55 + Math.min(s.divYield / 0.05, 1) * 0.45 : null),
    strongAt: 0.7,
  },
  {
    id: "ev_split",
    name: "株式分割",
    subtitle: "流動性と裾野の拡大",
    cat: "event",
    horizon: "mid",
    markets: ["JP"],
    trend: false,
    thesis: "最低投資金額が下がることで個人投資家の参入障壁が下がり、需給が改善する。",
    detail: `理論上、株式分割は企業価値に何の影響も与えない。ピザを8切れに切っても大きさは変わらない。にもかかわらず株価が反応するのは、市場が理論通りに動かない証拠のひとつ。

【実際に効いている要因】
・最低投資金額の低下による個人の参入(特にNISA枠との相性)
・分割を実施できること自体が、株価が十分に上昇したことの証明(=モメンタムの代理変数)
・経営陣が株価水準を意識しているというシグナル

【注意】3番目の要因が本体で、分割そのものは症状に過ぎない可能性が高い。つまりモメンタム手法と重複している疑いがあり、相関マトリクスでの検証が必要。`,
    exitRule: "分割の権利落ち後60営業日で機械的に手仕舞い。",
    score: (s) => (s.market === "JP" && s.splitAnnounced && s.daysSinceSplit <= 30 && s.rs > 0.5
      ? 0.5 + s.rs * 0.5 : null),
    strongAt: 0.75,
  },

  /* ---------------------------------------------------------------------- 複合 */
  {
    id: "cmp_multibagger",
    name: "マルチバガー候補",
    subtitle: "10倍株の実証research準拠",
    cat: "composite",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "小型 × 高バリュー × 高収益性 × 高FCF利回り。10倍株464社の実証分析が示した共通項。",
    detail: `Yartseva (2025) "The Alchemy of Multibagger Stocks" に基づく。2009〜2024年に米国市場で10倍以上になった464銘柄を動的パネルデータモデルで分析した研究。

【研究の主要な発見】
1. Fama-French由来のサイズ・バリュー・収益性は、依然として有意な予測因子。小型かつ高バリュー・高収益性の銘柄が特にアウトパフォームする。
2. 高いFCF利回りと、EBITDA成長に紐づく特有の投資パターンが重要な牽引要因。
3. モメンタム効果は複雑で、急速なトレンド反転を伴うため最適なエントリー機会が限られる。
4. 特定の金利環境が影響する。

【示唆】「成長株を高値で買う」という素朴なイメージと真逆で、10倍株の出発点は「小さくて、安くて、既に稼いでいる」という地味な姿である。派手さは結果であって原因ではない。

【この手法の性格】年に数銘柄しか出ないはず。0件が続くのが正常。逆に大量に出るならフィルタが緩すぎる。`,
    exitRule: "投資仮説が崩れるまで保有。時価総額が中型以上に成長したら手法の前提から外れるため見直し。",
    score: (s) => {
      if (!(s.sizeDecile <= 3 && s.pbr < 1.8 && s.roe > 0.12 && s.fcfYield > 0.05)) return null;
      return (1 - s.sizeDecile / 4) * 0.25 + Math.min(s.roe / 0.25, 1) * 0.3
        + Math.min(s.fcfYield / 0.12, 1) * 0.25 + (1 - s.pbr / 1.8) * 0.2;
    },
    strongAt: 0.72,
  },
  {
    id: "cmp_multifactor",
    name: "マルチファクター",
    subtitle: "バリュー×モメンタム×クオリティ",
    cat: "composite",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "相関の低い3ファクターのスコアを合成し、総合点の高い銘柄を選ぶ。",
    detail: `機関投資家の主流アプローチ。個々のファクターは市場環境によって長期間アンダーパフォームする期間を持つが、相関が低いため合成すると滑らかになる。

【バリューとモメンタムの負の相関】この2つは構造的に逆を向く。バリューは下がった株を買い、モメンタムは上がった株を買う。だからこそ組み合わせの分散効果が大きい。「Value and Momentum Everywhere」(Asness et al. 2013)が示した通り、この組み合わせはほぼ全ての資産クラス・地域で機能する。

【設計判断】ボトムアップ方式(個別銘柄レベルで複数ファクターのスコアが同時に高いものを選ぶ)を採用。トップアップ方式(単一ファクターのポートフォリオを混ぜる)より、狙ったファクター・エクスポージャーを正確に取れる。`,
    exitRule: "総合スコアが上位から陥落した時点で四半期リバランス。",
    score: (s) => {
      const v = s.per > 0 && s.per < 20 ? 1 - s.per / 20 : 0;
      const m = Math.max(0, Math.min(s.mom12_1 / 0.5, 1));
      const q = Math.min(Math.max(s.roe, 0) / 0.2, 1);
      const c = v * 0.34 + m * 0.33 + q * 0.33;
      return c > 0.55 ? c : null;
    },
    strongAt: 0.72,
  },

  /* ------------------------------------------------------------------ 独自 */
  {
    id: "org_quiet",
    name: "静かな上昇",
    subtitle: "騒がれる前に買う",
    cat: "original",
    horizon: "mid",
    markets: ["JP", "US"],
    trend: true,
    thesis: "上がっているのに、出来高もボラティリティも増えていない銘柄。群衆がまだ気づいていない上昇を先回りする。",
    detail: `【着想】
モメンタム系手法の弱点は、シグナルが出る頃には既に注目が集まり、ボラティリティが上がって高値掴みのリスクが増していること。この手法はその逆を探す。「リターン ÷ ボラティリティ」が高く、かつ相対出来高が平常水準のままの銘柄は、機関投資家が静かに買い集めている(あるいは単に良い事業が淡々と評価されている)可能性が高い。

【条件】
・12-1ヶ月モメンタムがプラス圏(+12%以上)
・60日ボラティリティが低い(年率28%未満)
・相対出来高が平常(RVOL 1.15未満) — 祭りになっていないこと
・52週高値から10%以内 — 上昇が現在進行形であること
・200日線が上向き

【この手法が輝く場面】
派手なテーマ株が乱舞する相場では出番が少ない。逆に、方向感のないレンジ相場や調整局面で「それでも静かに上がり続ける銘柄」を拾えたとき、次の主役を先取りできる。`,
    exitRule: "RVOLが恒常的に2倍を超えた(=祭りが始まった)時点で半分利確。残りは50日線割れまで。",
    score: (s) => {
      if (!(s.mom12_1 > 0.12 && s.ma200slope > 0 && s.vol60 < 0.28 && s.rvol < 1.15 && s.dist52w > -0.10)) return null;
      const sharpe = s.mom12_1 / Math.max(s.vol60, 0.08);
      return Math.min(sharpe / 2.2, 1) * 0.7 + (1 - s.rvol / 1.15) * 0.3;
    },
    strongAt: 0.72,
  },
  {
    id: "org_higher_lows",
    name: "下値切り上げ",
    subtitle: "買い集めの足跡",
    cat: "original",
    horizon: "swing",
    markets: ["JP", "US"],
    trend: true,
    thesis: "10日ごとの安値が階段状に切り上がっている銘柄。誰かが下で拾い続けている証拠を数える。",
    detail: `【着想】
高値の更新は目立つのでみんなが見ている。しかし本当に情報量が多いのは安値の側で、「下がるたびに前より高い位置で買いが入る」ことは、その価格帯に本気の買い手が待ち構えていることを意味する。チャートの「上値」ではなく「下値」だけを機械的に数える手法。

【条件】
・直近を10日ずつのブロックに区切り、各ブロックの安値が直前ブロックの安値を上回っている連続回数を数える
・3段階以上の切り上げでエントリー候補、段数が多いほど高スコア
・200日線が上向き

【下値切り上げが崩れた瞬間が、そのまま損切りシグナルになる美しさ】
この手法は「エントリー根拠の消滅=手仕舞い」が完全に一致する。直近の切り上げた安値を割った時点で、買い集めの仮説そのものが崩れたことになるため、迷いなく降りられる。`,
    exitRule: "直近の切り上げ安値を終値で割り込んだ時点(=買い集め仮説の崩壊)。",
    score: (s) => {
      if (!(s.hlStreak >= 3 && s.ma200slope > 0)) return null;
      return Math.min(s.hlStreak / 6, 1) * 0.6 + Math.min(s.rs ?? 0.5, 1) * 0.4;
    },
    strongAt: 0.75,
  },
  {
    id: "org_base2",
    name: "ベース・オン・ベース",
    subtitle: "二段ロケット",
    cat: "original",
    horizon: "mid",
    markets: ["JP", "US"],
    trend: true,
    thesis: "大きく上昇した後、崩れずに高値圏でもう一度値幅を固めた銘柄。1段目の上昇が本物だった証拠。",
    detail: `【着想】
急騰した銘柄の大半はその後崩れる。しかし少数の本物は、利益確定売りを高値圏で吸収しきって二度目の踏み台(ベース)を作る。「上昇後に崩れなかった」という事実そのものが、最初の上昇が投機ではなく実需だったことのフィルターになる。O'Neilのベース・オン・ベース概念を、VCP(値幅収縮)の定量判定で機械化した。

【条件】
・6ヶ月リターンが+25%以上(1段目の上昇が存在する)
・VCPスコアが高い(高値圏で値幅が収縮している=2つ目のベース形成中)
・52週高値から6%以内に留まっている(崩れていない)
・50日線からのATR乖離が3.5倍未満(今この瞬間は伸び切っていない)

【注意】
年に何度も出るセットアップではない。0件の日が続くのが正常で、大量に出るなら相場全体が過熱している警告と読むべき。`,
    exitRule: "2つ目のベースの下限を割れた時点。ブレイク成功後は10日線トレイル。",
    score: (s) => {
      if (!(s.mom6 > 0.25 && s.vcp > 0.55 && s.dist52w > -0.06 && s.atrExt < 3.5 && s.ma200slope > 0)) return null;
      return s.vcp * 0.5 + Math.min(s.mom6 / 0.6, 1) * 0.3 + (1 + s.dist52w / 0.06) * 0.2;
    },
    strongAt: 0.78,
  },
  {
    id: "org_down_resist",
    name: "下落耐性",
    subtitle: "下に硬く、上に軽い",
    cat: "original",
    horizon: "long",
    markets: ["JP", "US"],
    trend: false,
    thesis: "下落日の値動きが上昇日より明確に小さい銘柄。リターンの「形」の非対称性を買う。",
    detail: `【着想】
同じボラティリティ20%でも、「下に大きく上に小さい」銘柄と「下に小さく上に大きい」銘柄では投資価値がまったく違う。標準的な低ボラ戦略はこの区別をしない。この手法は下落日だけの値動きの荒さと上昇日だけの値動きの荒さを別々に測り、その比率(下÷上)が小さい=下に硬い銘柄を選ぶ。

【なぜ効くと考えるか】
下落局面で値動きが小さいのは、押し目を待つ買い手が厚いか、保有者が売り急がない(確信度が高い)かのどちらか。いずれも将来リターンにとって好ましい株主構成の代理指標になる。また複利は下落で最も毀損されるため、下方の非対称性は同じ平均リターンでも長期の複利成長率を高くする。

【条件】
・下落日ボラ ÷ 上昇日ボラ < 0.85
・12ヶ月モメンタムがプラス(下に硬いだけの死に体を除外)
・200日線が上向き`,
    exitRule: "非対称性が消えた(比率が1.0を超えた)時点、または年次リバランス。",
    score: (s) => {
      if (!(s.upDownVolRatio != null && s.upDownVolRatio < 0.85 && s.mom12_1 > 0 && s.ma200slope > 0)) return null;
      return (1 - s.upDownVolRatio / 0.85) * 0.6 + Math.min(s.mom12_1 / 0.4, 1) * 0.4;
    },
    strongAt: 0.66,
  },
  {
    id: "org_turnaround",
    name: "黒字転換",
    subtitle: "変曲点を買う",
    cat: "original",
    horizon: "long",
    markets: ["JP"],
    trend: false,
    thesis: "直近通期で赤字から黒字へ転換した銘柄。市場は「赤字企業」というレッテルの剥がれに数四半期遅れて気づく。",
    detail: `【着想】
赤字企業は多くの機関投資家のスクリーニングから機械的に除外される。黒字転換した瞬間、その銘柄は突然「買ってよい銘柄リスト」に載るが、リストの更新は四半期〜年次でしか行われない。この制度的な遅延こそがエッジの源泉。

また黒字転換の初年度はROEもPERも見かけが悪い(利益がまだ小さい)ため、通常のバリュー/クオリティ手法では引っかからない。つまり本アプリの他の35手法とほぼ重複しない、独立性の高い獲物を狙える。

【条件】
・直近通期: 純利益が黒字(前期は赤字)
・営業利益率が改善トレンドにあること(一過性の特別利益による見かけの転換を除外)
・PERが算出可能(黒字であることの再確認)

【リスク】
転換が定着せず再び赤字に沈む「行って来い」が最大の敵。だから手仕舞いルールが命: 四半期で営業減益が出たら即座に降りる。`,
    exitRule: "四半期決算で営業減益が出た時点で無条件撤退。定着すれば通常のクオリティ手法へバトンタッチ。",
    score: (s) => {
      if (!(s.turnaround && s.per > 0 && s.opMarginTrend > 0)) return null;
      return 0.55 + Math.min(Math.max(s.opMarginTrend, 0) / 0.03, 1) * 0.45;
    },
    strongAt: 0.8,
  },

  /* -------------------------------------------------- 権利確定日・決算日系 */
  {
    id: "ev_rights_run",
    name: "権利取り先回り",
    subtitle: "権利確定日アノマリー",
    cat: "event",
    horizon: "swing",
    markets: ["JP"],
    trend: false,
    thesis: "高配当・優待銘柄は権利確定日の1〜2ヶ月前から買われ始める。この季節性を先回りし、権利日前に降りる。",
    detail: `【背景】
日本株には「権利取り」という独特の季節需要がある。配当や株主優待の権利を得ようとする個人投資家の買いが権利確定日に向けて積み上がり、権利落ち日に剥落する。このパターンは特に高配当銘柄・優待人気銘柄で繰り返し観測されてきた。

【この手法の狙い方 — 重要】
権利を「取る」のではない。権利を取りに来る買いの手前で仕込み、権利日直前の需要ピークで売り抜ける。配当や優待そのものはもらわない。権利落ちの下落(理論上は配当額+優待価値ぶん下がる)を食らわないためであり、これはアノマリーのライド(便乗)であって配当投資ではない。

【条件】
・権利確定日まで10〜45営業日(この期間に先回り買いが積み上がる)
・配当利回り3%以上、または株主優待あり(優待リストは手動管理。設定参照)
・配当性向に無理がないこと

【データについて正直に】
権利確定日は決算期末から導出(大半の企業は期末=権利確定)。株主優待の有無は無料の構造化データが存在しないため、任意の手動リスト(yutai-jp.json)で補強する方式。リスト未整備でも配当利回り条件だけで動作する。`,
    exitRule: "権利付き最終日の2営業日前に無条件で手仕舞い(権利落ちを持ち越さない)。",
    score: (s) => {
      if (!(s.market === "JP" && s.daysToRights != null && s.daysToRights >= 10 && s.daysToRights <= 45)) return null;
      const div = s.divYield ?? 0;
      if (!(div >= 0.03 || s.hasYutai)) return null;
      if (s.payout != null && s.payout > 0.9) return null;
      return Math.min(div / 0.05, 1) * 0.6 + (s.hasYutai ? 0.4 : 0.15);
    },
    strongAt: 0.8,
  },
  {
    id: "ev_rights_dip",
    name: "権利落ち拾い",
    subtitle: "剥落の売られすぎを買う",
    cat: "event",
    horizon: "swing",
    markets: ["JP"],
    trend: true,
    thesis: "権利落ちで需給要因だけで売られた銘柄を、落ち着いた直後に拾う。事業は何も変わっていない。",
    detail: `【背景】
権利落ち日の下落は、企業価値の変化ではなく「権利目当ての買い手が一斉にいなくなる」という純粋な需給イベント。理論上は配当額ぶんの下落で済むはずだが、優待人気銘柄や個人保有比率の高い銘柄では往々にしてオーバーシュートする。事業に何も起きていないのに安くなった数日間だけを狙う。

「権利取り先回り」と対になる手法で、同じ季節性の前半と後半を別々の手法として計測する。どちらが有効か(あるいは両方無効か)をフォワードテストで決着させる設計。

【条件】
・権利確定日から2〜15営業日経過
・200日線が上向き(長期トレンドが健在=下落が需給要因である傍証)
・配当利回り3%以上または優待あり(そもそも権利需給が働く銘柄であること)

【リスク】
権利落ちと決算発表が近接する銘柄では、下落が需給ではなく業績要因である可能性が混入する。決算発表が7日以内に迫っている場合は見送る条件を入れている。`,
    exitRule: "権利落ち前の水準を回復した時点で利確、または20営業日経過で機械的に手仕舞い。",
    score: (s) => {
      if (!(s.market === "JP" && s.daysSinceRights != null && s.daysSinceRights >= 2 && s.daysSinceRights <= 15)) return null;
      if (!(s.ma200slope > 0)) return null;
      const div = s.divYield ?? 0;
      if (!(div >= 0.03 || s.hasYutai)) return null;
      if (s.earningsInDays != null && s.earningsInDays <= 7) return null; // 決算またぎを回避
      return 0.5 + Math.min(div / 0.05, 1) * 0.3 + (s.hasYutai ? 0.2 : 0);
    },
    strongAt: 0.85,
  },
];

/* ==================================================== 除外した手法(理由の記録) */
const EXCLUDED = [
  { name: "インサイダー買い追跡", reason: "日本株では役員の売買報告が機械可読な形で無料公開されていない。米国株はSEC Form4で可能だが、日米で土俵が揃わず比較実験として成立しない。" },
  { name: "信用倍率・空売り残高", reason: "J-Quants の該当APIは Standard プラン以上。Light plan では取得不可。" },
  { name: "指数採用/除外イベント", reason: "採用予測にはパッシブ資金フローの推定が必要で、無料データでは精度が出ない。予測が外れると需給の逆流を食らう非対称なリスクがある。" },
  { name: "IPO/ロックアップ解除", reason: "ロックアップ条項は目論見書の個別読解が必要で、機械化のコストが便益に見合わない。" },
  { name: "TOB/MBO思惑株", reason: "「思惑」を定量化する手段がない。実質的にニュース後追いになり、フォワードテストの土俵に乗らない。" },
  { name: "立会外分売", reason: "発生頻度が低く、統計的に有意な試行回数(n=100)を溜めるのに数年かかる。検証装置として機能しない。" },
  { name: "SNSセンチメント", reason: "X API のコストが精度に見合わない。ただし既存のX監視レイヤーがあるため v2 で再検討の価値あり。" },
  { name: "Google Trends 相関", reason: "サンプリングされた相対値しか取得できず、日次の銘柄選定に必要な粒度と安定性を欠く。" },
  { name: "機械学習によるリターン予測", reason: "教師データが存在しない段階での導入は本末転倒。まず30手法で n を溜め、そのシグナルとその後の結果を教師データとして v2 で着手する。順序が逆。" },
  { name: "RSI/MACD 単独シグナル", reason: "単独の売買シグナルとしては優位性の報告が乏しい。他手法の補助指標としては内部で使用している。" },
  { name: "ゴールデンクロス単独", reason: "遅行性が強く、単独では優位性が確認しにくい。パーフェクトオーダー手法に統合済み。" },
];

/* ================================================================= データ生成
   実データ (/data/snapshot.json) が無い場合の検証用。
   バッチが吐くJSONと完全に同じ形。だから差し替えが1行で済む。
   ============================================================================ */

/* テクニカル系の「本日時点の値」のキー一覧。
   デモ生成(genUniverse)と実データバッチ(build-snapshot)の両方が、
   featuresAt(s, 最終日) の結果からこのキーだけを銘柄エントリへ書き戻す。
   ここに列挙されていないテクニカル指標は runScreen から見えない
   (= 実データで手法が全滅する重大バグの再発防止のための単一の正義)。 */
const TECH_CURRENT_KEYS = [
  "mom12_1", "mom6", "dist52w", "ma200slope", "atrExt",
  "perfectOrder", "breakout", "pullbackToMA", "squeeze", "rsLineNewHigh",
  "rvol", "vol60", "rs", "vars", "vcp",
  "hlStreak", "upDownVolRatio",
  "daysToRights", "daysSinceRights", "earningsInDays",
];

const JP_NAMES = [
  ["7203", "トヨタ自動車", "輸送用機器"], ["6920", "レーザーテック", "電気機器"],
  ["8058", "三菱商事", "卸売業"], ["4063", "信越化学工業", "化学"],
  ["6857", "アドバンテスト", "電気機器"], ["9984", "ソフトバンクG", "情報・通信"],
  ["8306", "三菱UFJ", "銀行業"], ["6501", "日立製作所", "電気機器"],
  ["7011", "三菱重工業", "機械"], ["4519", "中外製薬", "医薬品"],
  ["6367", "ダイキン工業", "機械"], ["8035", "東京エレクトロン", "電気機器"],
  ["9432", "日本電信電話", "情報・通信"], ["2914", "日本たばこ産業", "食料品"],
  ["8001", "伊藤忠商事", "卸売業"], ["7267", "本田技研工業", "輸送用機器"],
  ["6098", "リクルートHD", "サービス業"], ["4568", "第一三共", "医薬品"],
  ["8031", "三井物産", "卸売業"], ["5401", "日本製鉄", "鉄鋼"],
  ["3401", "帝人", "繊維製品"], ["7735", "SCREEN HD", "電気機器"],
  ["9101", "日本郵船", "海運業"], ["1605", "INPEX", "鉱業"],
  ["8113", "ユニ・チャーム", "化学"], ["4523", "エーザイ", "医薬品"],
  ["6503", "三菱電機", "電気機器"], ["5108", "ブリヂストン", "ゴム製品"],
  ["8802", "三菱地所", "不動産業"], ["9433", "KDDI", "情報・通信"],
  ["3382", "セブン&アイ", "小売業"], ["4901", "富士フイルム", "化学"],
  ["6902", "デンソー", "輸送用機器"], ["7751", "キヤノン", "電気機器"],
  ["8766", "東京海上HD", "保険業"], ["9020", "東日本旅客鉄道", "陸運業"],
  ["2502", "アサヒGHD", "食料品"], ["4661", "オリエンタルランド", "サービス業"],
  ["6146", "ディスコ", "機械"], ["7013", "IHI", "機械"],
  ["3405", "クラレ", "化学"], ["5334", "日本特殊陶業", "ガラス土石"],
  ["6136", "OSG", "機械"], ["7202", "いすゞ自動車", "輸送用機器"],
  ["8593", "三菱HCキャピタル", "その他金融"], ["9142", "九州旅客鉄道", "陸運業"],
  ["2801", "キッコーマン", "食料品"], ["4204", "積水化学工業", "化学"],
  ["5019", "出光興産", "石油石炭"], ["6141", "DMG森精機", "機械"],
];
const US_NAMES = [
  ["AAPL", "Apple", "Technology"], ["MSFT", "Microsoft", "Technology"],
  ["NVDA", "NVIDIA", "Semiconductors"], ["GOOGL", "Alphabet", "Communication"],
  ["AMZN", "Amazon", "Consumer Disc."], ["META", "Meta Platforms", "Communication"],
  ["AVGO", "Broadcom", "Semiconductors"], ["LLY", "Eli Lilly", "Healthcare"],
  ["JPM", "JPMorgan Chase", "Financials"], ["XOM", "Exxon Mobil", "Energy"],
  ["V", "Visa", "Financials"], ["UNH", "UnitedHealth", "Healthcare"],
  ["COST", "Costco", "Consumer Staples"], ["HD", "Home Depot", "Consumer Disc."],
  ["PG", "Procter & Gamble", "Consumer Staples"], ["JNJ", "Johnson & Johnson", "Healthcare"],
  ["ABBV", "AbbVie", "Healthcare"], ["CRM", "Salesforce", "Technology"],
  ["AMD", "Adv. Micro Devices", "Semiconductors"], ["NFLX", "Netflix", "Communication"],
  ["ADBE", "Adobe", "Technology"], ["CAT", "Caterpillar", "Industrials"],
  ["GE", "GE Aerospace", "Industrials"], ["MU", "Micron", "Semiconductors"],
  ["ANET", "Arista Networks", "Technology"], ["PANW", "Palo Alto Networks", "Technology"],
  ["VST", "Vistra", "Utilities"], ["APP", "AppLovin", "Technology"],
  ["ONON", "On Holding", "Consumer Disc."], ["CELH", "Celsius Holdings", "Consumer Staples"],
  ["DKS", "Dick's Sporting", "Consumer Disc."], ["TXRH", "Texas Roadhouse", "Consumer Disc."],
  ["MLI", "Mueller Industries", "Industrials"], ["ATKR", "Atkore", "Industrials"],
  ["CROX", "Crocs", "Consumer Disc."], ["SKYW", "SkyWest", "Industrials"],
  ["JXN", "Jackson Financial", "Financials"], ["UTHR", "United Therapeutics", "Healthcare"],
  ["EME", "EMCOR Group", "Industrials"], ["PWR", "Quanta Services", "Industrials"],
];

function genUniverse(seed = 20260714) {
  const r = mulberry32(seed);
  const out = [];
  const build = (arr, market) =>
    arr.forEach(([code, name, sector], i) => {
      const rr = mulberry32(seed + i * 7919 + (market === "JP" ? 0 : 5000));
      const mom = gauss(rr) * 0.28 + 0.06;
      const rs = Math.max(0, Math.min(1, 0.5 + gauss(rr) * 0.26));
      const roe = Math.max(-0.1, gauss(rr) * 0.09 + 0.11);
      const per = Math.max(3, gauss(rr) * 9 + 17);
      const pbr = Math.max(0.2, gauss(rr) * 0.9 + 1.35);
      const vol60 = Math.max(0.08, gauss(rr) * 0.11 + 0.27);
      const atrExt = Math.max(0, gauss(rr) * 2.1 + 2.2);
      const px = market === "JP" ? Math.round((gauss(rr) * 2400 + 3200) * 10) / 10 : Math.round((gauss(rr) * 180 + 210) * 100) / 100;
      const price = Math.max(market === "JP" ? 300 : 8, px);
      const s = {
        code, name, sector, market, price,
        mom12_1: mom,
        rs,
        vars: Math.max(0, Math.min(1, rs + gauss(rr) * 0.08)),
        groupRS: Math.max(0, Math.min(1, 0.5 + gauss(rr) * 0.24)),
        vcp: Math.max(0, Math.min(1, 0.45 + gauss(rr) * 0.28)),
        rvol: Math.max(0.2, gauss(rr) * 0.75 + 1.15),
        atrExt,
        atr: price * (vol60 / Math.sqrt(252)) * 2.6,
        dist52w: -Math.abs(gauss(rr) * 0.16),
        ma200slope: gauss(rr) * 1.2 + 0.35,
        perfectOrder: rr() > 0.68,
        breakout: rr() > 0.86,
        pullbackToMA: rr() > 0.8,
        squeeze: rr() > 0.85,
        rsLineNewHigh: rr() > 0.85,
        per, pbr, roe,
        roic: Math.max(-0.05, roe * (0.72 + rr() * 0.4)),
        wacc: 0.055 + rr() * 0.035,
        earnYield: per > 0 ? 1 / per : 0,
        fcfYield: Math.max(-0.05, gauss(rr) * 0.045 + 0.048),
        evEbitda: Math.max(1.5, gauss(rr) * 4.5 + 9.5),
        divYield: Math.max(0, gauss(rr) * 0.016 + 0.024),
        payout: Math.max(0, Math.min(1.4, gauss(rr) * 0.22 + 0.36)),
        netIncome: gauss(rr) > -1.6 ? 1 : -1,
        psr: Math.max(0.05, gauss(rr) * 0.8 + 1.2),
        opMarginTrend: gauss(rr) * 0.02,
        ncavRatio: Math.max(0, gauss(rr) * 0.35 + 0.72),
        fscore: Math.max(0, Math.min(9, Math.round(gauss(rr) * 1.7 + 5.4))),
        roeYears: Math.max(0, Math.round(gauss(rr) * 1.8 + 2.2)),
        grossProf: Math.max(0.02, gauss(rr) * 0.14 + 0.29),
        accrual: gauss(rr) * 0.05 + 0.015,
        altmanZ: Math.max(0.2, gauss(rr) * 1.5 + 3.0),
        epsGrowthQ: gauss(rr) * 0.42 + 0.13,
        epsGrowthY: gauss(rr) * 0.3 + 0.11,
        salesAccel: gauss(rr) * 0.07,
        opAccel: gauss(rr) * 0.11,
        peg: Math.max(0.05, gauss(rr) * 0.9 + 1.5),
        streak: Math.max(0, Math.round(gauss(rr) * 2.6 + 2.4)),
        beta: Math.max(0.15, gauss(rr) * 0.32 + 1.0),
        vol60,
        earnStability: Math.max(0, Math.min(1, 0.5 + gauss(rr) * 0.24)),
        epsSurprise: gauss(rr) * 0.14,
        postEarnGap: gauss(rr) * 0.045,
        daysSinceEarnings: Math.floor(rr() * 90),
        buybackPct: rr() > 0.9 ? Math.abs(gauss(rr)) * 0.04 : 0,
        daysSinceBuyback: Math.floor(rr() * 60),
        divHike: rr() > 0.88,
        daysSinceDivHike: Math.floor(rr() * 70),
        splitAnnounced: rr() > 0.94,
        daysSinceSplit: Math.floor(rr() * 50),
        sizeDecile: Math.max(1, Math.min(10, Math.round(rr() * 9 + 1))),
        advDollar: Math.abs(gauss(rr)) * 4e9 + 2e8,
        market_advDollarFloor: market === "JP" ? 3e8 : 2e7,
        isBio: /医薬品|Healthcare/.test(sector) && rr() > 0.5,
        turnaround: rr() < 0.06,          // 直近通期で赤字→黒字転換したか
        hasYutai: market === "JP" && rr() < 0.3, // 株主優待あり(実データでは任意の手動リストから)
        history: genHistory(rr, price, mom, vol60),
      };
      s.fundDaily = genFundHistory(rr, s, s.history.length);
      /* 権利確定日・決算発表日は年次/四半期の周期を持つ日付データ。
         乱数ウォークではなくカレンダー的な周期配列として生成する。 */
      {
        const len = s.history.length;
        const rightsOffset = Math.floor(rr() * 252);   // 権利確定日の年内位置
        const earnOffset = Math.floor(rr() * 63);      // 決算発表の四半期内位置
        const dtr = new Array(len), dsr = new Array(len), eid = new Array(len), tar = new Array(len);
        for (let i = 0; i < len; i++) {
          const d = ((rightsOffset - i) % 252 + 252) % 252;
          dtr[i] = d;
          dsr[i] = (252 - d) % 252;
          eid[i] = ((earnOffset - i) % 63 + 63) % 63;
          tar[i] = s.turnaround ? 1 : 0;
        }
        s.fundDaily.daysToRights = dtr;
        s.fundDaily.daysSinceRights = dsr;
        s.fundDaily.earningsInDays = eid;
        s.fundDaily.turnaround = tar;
      }
      /* テクニカル系の「現在値」は、乱数ではなく生成した history から
         featuresAt() で計算し直して上書きする。これにより:
         ①デモのチャートとシグナルが一致する(以前は別々の乱数で不整合だった)
         ②実データバッチ(build-snapshot)と完全に同じコードパスになる */
      const f0 = featuresAt(s, s.history.length - 1);
      if (f0) for (const k of TECH_CURRENT_KEYS) s[k] = f0[k];
      out.push(s);
    });
  build(JP_NAMES, "JP");
  build(US_NAMES, "US");
  return out;
}

/* 履歴生成: バックテストに耐えるよう10年分(約2520営業日)を生成する。
   ファンダメンタルも時変にしないと、過去に遡ったときに「今のPER」で
   過去を判定してしまう —— それは最悪の Look-ahead bias になる。 */
function genHistory(r, last, drift, vol) {
  const n = 2520; // 10年
  const arr = [];
  const dv = vol / Math.sqrt(252);
  const mu = Math.pow(1 + drift * 0.35, 1 / 252) - 1;
  let p = last / Math.pow(1 + mu, n); // 終端が現在値になるよう逆算
  /* レジーム: 数年周期の強気/弱気を入れる。単純なランダムウォークでは
     ドローダウンが過小評価され、バックテストが楽観に偏る */
  let regime = 1;
  for (let i = 0; i < n; i++) {
    if (i % 252 === 0) regime = r() > 0.28 ? 1 : -1;
    const ret = gauss(r) * dv + mu + (regime > 0 ? dv * 0.05 : -dv * 0.13);
    const o = p;
    p = Math.max(p * (1 + ret), last * 0.02);
    const h = Math.max(o, p) * (1 + Math.abs(gauss(r)) * dv * 0.5);
    const l = Math.min(o, p) * (1 - Math.abs(gauss(r)) * dv * 0.5);
    arr.push({ o, h, l, c: p, v: Math.abs(gauss(r)) * 0.6 + 0.7 });
  }
  const k = last / arr[arr.length - 1].c;
  return arr.map((d) => ({ o: d.o * k, h: d.h * k, l: d.l * k, c: d.c * k, v: d.v }));
}

/* ファンダメンタルの時系列。実データでは「開示日から次の開示日の前日まで、
   同じ値が続く(forward-fill)」という形になる。デモ生成もそれに合わせて
   四半期ごとに値を変えつつ、履歴と同じ日次長の配列として持つ。
   こうしておくことで、featuresAt() 側は「日次配列の i 番目を読むだけ」という
   単一のロジックで、デモデータにも実データにも対応できる。
   実データ接続時は s.fundDaily をそのまま J-Quants 由来の forward-fill 済み
   配列に差し替えるだけでよい(featuresAt 側のコードは一切変更不要)。 */
function genFundHistory(r, cur, len) {
  const qLen = 63; // 四半期を63営業日とみなして値を切り替える
  const keys = ["per", "pbr", "roe", "fcfYield", "divYield", "payout", "roic",
    "evEbitda", "fscore", "grossProf", "accrual", "epsGrowthQ", "epsGrowthY",
    "earnYield", "psr", "peg", "altmanZ", "ncavRatio", "streak", "roeYears",
    "salesAccel", "opAccel", "earnStability", "sizeDecile", "opMarginTrend"];
  const nQ = Math.ceil(len / qLen) + 1;
  const series = {};
  for (const k of keys) {
    const v0 = cur[k];
    const qPath = new Array(nQ);
    let v = v0;
    for (let i = nQ - 1; i >= 0; i--) { // 現在から過去へ逆向きに生成
      qPath[i] = v;
      v = v * (1 + gauss(r) * 0.07) + gauss(r) * Math.abs(v0) * 0.03;
      if (k === "fscore" || k === "streak" || k === "roeYears" || k === "sizeDecile")
        v = Math.max(0, Math.round(v));
    }
    const daily = new Array(len);
    for (let i = 0; i < len; i++) daily[i] = qPath[Math.min(nQ - 1, Math.floor(i / qLen))];
    series[k] = daily;
  }
  return series;
}

const DATA_SOURCE = {
  async load() {
    try {
      const res = await fetch("/data/snapshot.json");
      if (res.ok) return { ...(await res.json()), demo: false };
    } catch (e) { /* バッチ未接続 */ }
    return {
      demo: true,
      asof: "2026-07-14",
      regime: {
        JP: { above200: true, breadth: 0.61, label: "良好" },
        US: { above200: true, breadth: 0.38, label: "警戒" },
      },
      universe: genUniverse(),
    };
  },

  /* デモ運用(バックテスト)タブ専用の全履歴データ。実データ接続時、これは
     数十MBになりうるため、初期表示では読み込まず、タブを開いたときだけ
     遅延取得する。取得できない場合は snapshot.json の(短い)履歴で
     代替し、その旨を画面に明示する。 */
  async loadHistory() {
    try {
      const res = await fetch("/data/history.json");
      if (res.ok) return await res.json();
    } catch (e) { /* 未接続・オフライン等 */ }
    return null;
  },
};

/* ============================================================ シグナル生成
   「強い推薦」の定義について:
     閾値超えだけで強調すると、手法の数だけ強調が出て通知の意味が消える。
     順位上位だけでも同じ。そこで採用したのは コンフルエンス(合流) 判定。

       強い推薦 = ①自手法のスコア閾値超   かつ
                 ②自手法内で首位           かつ
                 ③他の3カテゴリ以上からも同時に推薦されている

     ③が本質。バリューとモメンタムのように本来逆を向く手法が同じ銘柄を
     指したとき、それは偶然では起きにくい。だから強調に値する。
     同カテゴリ内の重複（低PERと低PBRが同じ銘柄を指す等）は、
     同じことを2回言っているだけなので合流として数えない。

     閾値だけの判定を試したところ、検証データで204件中101件が「強い推薦」
     になった。半数が強調なら、それは強調ではない。合流3カテゴリまで
     引き上げて初めて、通知に値する希少性になる。
   ============================================================================ */
function runScreen(universe, market) {
  const raw = {};
  for (const st of STRATEGIES) {
    if (!st.markets.includes(market)) continue;
    const hits = [];
    for (const s of universe) {
      if (s.market !== market) continue;
      let sc = null;
      try { sc = st.score(s); } catch (e) { sc = null; }
      if (sc == null || !isFinite(sc) || sc <= 0) continue;
      hits.push({ ...s, _score: Math.min(1, sc) });
    }
    hits.sort((a, b) => b._score - a._score);
    raw[st.id] = hits.slice(0, 8);
  }

  /* 銘柄ごとに、どのカテゴリから推薦されたかを集計 */
  const cats = {};
  for (const st of STRATEGIES) {
    for (const h of raw[st.id] || []) {
      (cats[h.code] ||= new Set()).add(st.cat);
    }
  }

  for (const st of STRATEGIES) {
    (raw[st.id] || []).forEach((h, i) => {
      const others = new Set(cats[h.code]); others.delete(st.cat);
      h._confluence = (cats[h.code]?.size || 1);
      h._strong = h._score >= st.strongAt && i === 0 && others.size >= 3;
    });
  }
  return raw;
}

/* ============================================================================
   ポートフォリオ評価 — 保有銘柄の買い増し/売りシグナル判定
   ----------------------------------------------------------------------------
   ■ 設計上、最も重要な判断
     「含み損だから買い増す」という単純なナンピンは、この関数からは絶対に出さない。
     買い増しシグナルは「その手法の基準を、今この瞬間もなお強く満たしている」場合
     にしか出さない。価格が下がったことは、買い増しの理由に一切ならない。
     価格が下がっても評価基準を再度クリアしているなら、それは偶然ではなく
     「最初の仮説が今も正しい」ことの再確認であり、そこだけを拾う。

   ■ 売りシグナルは2種類を区別する
     ①損切り: 取得単価を基準にしたストップを、株価が下回った(価格の問題)
     ②仮説崩壊: 手法のスクリーニング条件そのものを外れた(事業の問題)
     ②の方が重い。①はまだ「タイミングを外しただけ」の可能性があるが、
     ②は「そもそも選んだ理由が消えた」ことを意味するため、含み益中でも出す。

   ■ 手法を割り当てていない保有銘柄(自己管理)について
     この場合は買い増しシグナルを一切出さない。判断の拠り所となる仮説が
     存在しないため、機械的に「強気材料」を作り出すことができないから。
     損切り水準の監視のみ行う。
   ============================================================================ */
function evaluateHolding(h, universe) {
  const s = universe.find((x) => x.code === h.code && x.market === h.market);
  if (!s) return { signal: "missing", reason: "この銘柄の現在データが見つかりません。" };

  const st = STRATEGIES.find((x) => x.id === h.stId) || null;
  let score = null;
  if (st) { try { score = st.score(s); } catch (e) { score = null; } }

  const atr = s.atr || s.price * 0.02;
  const mult = st ? (st.horizon === "swing" ? 1.6 : st.horizon === "mid" ? 2.5 : 3.5) : 2.5;
  const stop = h.costBasis - atr * mult;
  const rUnit = Math.max(h.costBasis - stop, atr * 0.5);
  const curR = (s.price - h.costBasis) / rUnit;
  const unrealizedPct = s.price / h.costBasis - 1;
  const unrealizedYen = (s.price - h.costBasis) * h.shares;

  let signal = "hold", reason = "";
  if (st && score == null) {
    signal = "sell_thesis";
    reason = `「${st.name}」の選定条件を外れました。価格の上下ではなく、選んだ理由そのものが崩れています。含み益中でも見直しの対象です。`;
  } else if (s.price < stop) {
    signal = "sell_stop";
    reason = `取得単価 ${fmtP(h.costBasis, s.market)} を基準にした損切り水準 ${fmtP(stop, s.market)} を下回りました。`;
  } else if (st && score != null && score >= st.strongAt && (!st.trend || s.atrExt < 3.0)) {
    signal = "add";
    reason = `「${st.name}」の基準を今なお強く満たしています。価格が下がったからではなく、仮説そのものが今も有効だからです。`;
  } else if (!st) {
    signal = "hold";
    reason = "手法が割り当てられていません。損切り水準のみ監視し、買い増しシグナルは出しません。";
  } else {
    signal = "hold";
    reason = `「${st.name}」の基準は引き続き満たしていますが、突出した強さではありません。現状維持が妥当です。`;
  }

  return { s, st, score, stop, rUnit, curR, unrealizedPct, unrealizedYen, signal, reason };
}

const SIGNAL_UI = {
  add: { label: "買い増し検討", color: "#2E6E62", bg: "#EAF3EE" },
  sell_stop: { label: "損切り水準到達", color: "#A63A28", bg: "#FBEEEA" },
  sell_thesis: { label: "仮説崩壊 — 要見直し", color: "#A63A28", bg: "#FBEEEA" },
  hold: { label: "現状維持", color: "#6B7580", bg: "#F4F5F2" },
  missing: { label: "データなし", color: "#6B7580", bg: "#F4F5F2" },
};

/* 執行プラン: 1R を定義する。全ての成績はこのRで測られる */
function plan(s, st) {
  const atr = s.atr || s.price * 0.02;
  const entry = st.cat === "value" || st.cat === "quality" || st.horizon === "long"
    ? s.price
    : s.price * 1.005; // ブレイク系は直近高値上の逆指値を想定
  const stopMult = st.horizon === "swing" ? 1.6 : st.horizon === "mid" ? 2.5 : 3.5;
  const stop = entry - atr * stopMult;
  const r = entry - stop;
  const target = entry + r * (st.horizon === "swing" ? 3 : st.horizon === "mid" ? 4 : 6);
  return { entry, stop, target, r, riskPct: (r / entry) * 100 };
}

/* ============================================================================
   モードB — デモトレード(ペーパートレード)エンジン
   ----------------------------------------------------------------------------
   100万円を渡して、過去N年をその手法だけで運用させたらどうなったかを計算する。

   ■ この数字を信じる前に読むこと
     ここで出る数値は、検証用データを使っている限り「エンジンが正しく動く証拠」
     であって「手法が儲かる証拠」ではない。実データを接続するまで、リターンの
     大小に意味はない。数字が出ると人は信じてしまう。それが最も危険。

   ■ 設計判断
     ・毎日ループする。月次だけで判定すると、月中に損切りに触れた事実が
       消えてドローダウンが過小評価される。バックテストを甘くする典型。
     ・約定は「翌日の始値」。シグナルが出た日の終値で買えたことにするのは
       未来を見ている。1日ずらすだけで成績はかなり落ちるが、それが現実。
     ・手数料とスリッページを引く。引かないバックテストは机上の空論。
     ・ファンダメンタルは四半期時点の値のみ参照する(fundHist)。
   ============================================================================ */

const BT = {
  capital: 1_000_000, // 初期資金
  riskPct: 0.01,      // 1トレードあたり資金の1%をリスクに晒す
  maxPos: 5,          // 同時保有の上限
  cost: 0.002,        // 往復の手数料+スリッページ(0.2%)
};

/* 過去のある時点 i における特徴量を復元する。
   ここで未来のデータを1つでも混ぜたら、すべての結果が嘘になる。 */
function featuresAt(s, i) {
  const h = s.history;
  if (i < 260) return null; // 指標計算に必要な履歴が足りない
  const px = h[i].c;
  const sl = (n) => h.slice(i - n + 1, i + 1);
  const avg = (a, f) => a.reduce((x, y) => x + f(y), 0) / a.length;
  const ma = (n) => avg(sl(n), (d) => d.c);
  const ma25 = ma(25), ma50 = ma(50), ma200 = ma(200);
  const ma200prev = avg(h.slice(i - 220, i - 20), (d) => d.c);
  const w52 = sl(252);
  const hi52 = Math.max(...w52.map((d) => d.h));
  const tr = sl(14).map((d, k, a) => d.h - d.l);
  const atr = tr.reduce((a, b) => a + b, 0) / 14;
  const vol60 = Math.sqrt(252) * Math.sqrt(
    avg(sl(60).map((d, k, a) => (k ? Math.log(d.c / a[k - 1].c) : 0)).slice(1), (x) => x * x)
  );
  const r = (n) => h[i].c / h[i - n].c - 1;
  const rvol = h[i].v / avg(sl(50), (d) => d.v);
  const atrPct = atr / px;
  /* VCP: 直近の値幅が、その前の値幅より縮んでいるか */
  const rng = (a, b) => { const w = h.slice(i - a, i - b); return (Math.max(...w.map((d) => d.h)) - Math.min(...w.map((d) => d.l))) / px; };
  const r1 = rng(20, 0), r2 = rng(45, 20), r3 = rng(70, 45);
  const vcp = Math.max(0, Math.min(1, (r3 > 0 && r2 > 0) ? ((r3 - r2) / r3 * 0.5 + (r2 - r1) / r2 * 0.5 + 0.5) : 0));

  /* fundDaily は history と同じ日次長の forward-fill 済み配列。
     実データでは「i日目時点で最後に開示されていた値」がそのまま入っている。
     クオーター番号への変換が不要になった分、デモと本番のコードが完全に一致する。 */
  const F = (k) => s.fundDaily?.[k]?.[i] ?? s[k];

  /* --- 独自手法用の追加指標 --- */
  // 6ヶ月モメンタム(ベース・オン・ベース用)
  const mom6 = h[i].c / h[i - 126].c - 1;
  // 下値切り上げ: 10日ごとの安値が何段階連続で切り上がっているか(最大6)
  const lowOf = (a, b) => Math.min(...h.slice(i - a + 1, i - b + 1).map((d) => d.l));
  let hlStreak = 0;
  for (let k = 0; k < 6; k++) {
    if (i - (k + 2) * 10 < 0) break;
    if (lowOf((k + 1) * 10, k * 10) > lowOf((k + 2) * 10, (k + 1) * 10)) hlStreak++;
    else break;
  }
  // 下落耐性: 下落日の値動きの荒さ ÷ 上昇日の値動きの荒さ(小さいほど下に強い)
  const rets = sl(60).map((d, k, a) => (k ? Math.log(d.c / a[k - 1].c) : null)).filter((x) => x != null);
  const dn = rets.filter((x) => x < 0), up = rets.filter((x) => x > 0);
  const sd = (a) => (a.length > 3 ? Math.sqrt(a.reduce((x, y) => x + y * y, 0) / a.length) : null);
  const sdDn = sd(dn), sdUp = sd(up);
  const upDownVolRatio = sdDn != null && sdUp != null && sdUp > 0 ? sdDn / sdUp : null;

  return {
    ...s,
    price: px, atr,
    mom12_1: h[i - 21].c / h[i - 252].c - 1,
    mom6, hlStreak, upDownVolRatio,
    dist52w: px / hi52 - 1,
    ma200slope: ma200 - ma200prev,
    atrExt: atrPct > 0 ? (px - ma50) / (atrPct * px) : 0,
    perfectOrder: px > ma25 && ma25 > ma50 && ma50 > ma200,
    breakout: px >= Math.max(...sl(40).slice(0, 39).map((d) => d.h)),
    pullbackToMA: px > ma50 && px < ma25 * 1.02 && ma200slopePos(ma200, ma200prev),
    squeeze: r1 < r2 * 0.6 && r2 < r3 * 0.8,
    rsLineNewHigh: r(60) > 0.1 && px >= hi52 * 0.97,
    rvol, vol60,
    rs: Math.max(0, Math.min(1, 0.5 + r(120) * 1.4)),
    vars: Math.max(0, Math.min(1, 0.5 + (r(120) / Math.max(vol60, 0.05)) * 0.22)),
    /* バックテスト中の業種相対力は自己60日リターンによる近似。
       「本日時点」の値は build-snapshot / genUniverse 側が業種集計で
       別途 s.groupRS に設定する(TECH_CURRENT_KEYS に含めないのはそのため) */
    groupRS: Math.max(0, Math.min(1, 0.5 + r(60) * 1.6)),
    vcp,
    per: F("per"), pbr: F("pbr"), roe: F("roe"), fcfYield: F("fcfYield"),
    divYield: F("divYield"), payout: F("payout"), roic: F("roic"),
    evEbitda: F("evEbitda"), fscore: F("fscore"), grossProf: F("grossProf"),
    accrual: F("accrual"), epsGrowthQ: F("epsGrowthQ"), epsGrowthY: F("epsGrowthY"),
    earnYield: F("earnYield"), psr: F("psr"), peg: F("peg"), altmanZ: F("altmanZ"),
    ncavRatio: F("ncavRatio"), streak: F("streak"), roeYears: F("roeYears"),
    salesAccel: F("salesAccel"), opAccel: F("opAccel"),
    earnStability: F("earnStability"), sizeDecile: F("sizeDecile"),
    opMarginTrend: F("opMarginTrend"),
    turnaround: F("turnaround"),
    daysToRights: F("daysToRights"), daysSinceRights: F("daysSinceRights"),
    earningsInDays: F("earningsInDays"),
    hasYutai: s.hasYutai || false,
    beta: s.beta,
    epsSurprise: s.epsSurprise, postEarnGap: s.postEarnGap,
    daysSinceEarnings: i % 63, buybackPct: s.buybackPct,
    daysSinceBuyback: i % 40, divHike: s.divHike, daysSinceDivHike: i % 50,
    splitAnnounced: s.splitAnnounced, daysSinceSplit: i % 45,
  };
}
const ma200slopePos = (a, b) => a > b;

function backtest(universe, market, st, years) {
  const pool = universe.filter((s) => s.market === market);
  if (!pool.length) return null;
  const N = pool[0].history.length;
  const days = Math.min(Math.round(years * 252), N - 261);
  const start = N - days;
  if (days < 60) return null;

  let cash = BT.capital;
  let pos = [];               // 保有中
  const closed = [];          // 決済済み
  const curve = [];           // 資産推移
  let peak = BT.capital, maxDD = 0;
  const rebalEvery = st.horizon === "swing" ? 5 : st.horizon === "mid" ? 21 : 63;

  for (let i = start; i < N; i++) {
    /* --- 保有中の評価と手仕舞い判定(日次) --- */
    for (let k = pos.length - 1; k >= 0; k--) {
      const p = pos[k];
      const h = p.s.history[i];
      let exit = null, px = null;
      if (h.l <= p.stop) { exit = "損切り"; px = Math.min(p.stop, h.o); }  // ギャップ下抜けも考慮
      else {
        const trailN = st.horizon === "swing" ? 10 : st.horizon === "mid" ? 50 : 200;
        const mv = p.s.history.slice(i - trailN + 1, i + 1).reduce((a, b) => a + b.c, 0) / trailN;
        if (h.c < mv && i - p.i > trailN) { exit = "トレンド転換"; px = h.c; }
        else if (h.h >= p.target) { exit = "利確"; px = p.target; }
        else if (h.c > p.entry + p.r && p.stop < p.entry) p.stop = p.entry; // +1Rで建値へ
      }
      if (exit) {
        const gross = px * p.shares;
        cash += gross * (1 - BT.cost / 2);
        const pnl = (px - p.entry) * p.shares - (p.entry * p.shares * BT.cost);
        closed.push({ code: p.s.code, r: pnl / (p.r * p.shares), pnl, days: i - p.i, exit });
        pos.splice(k, 1);
      }
    }

    /* --- リバランス日: 新規選定 --- */
    if ((i - start) % rebalEvery === 0 && pos.length < BT.maxPos) {
      const cands = [];
      for (const s of pool) {
        if (pos.some((p) => p.s.code === s.code)) continue;
        const f = featuresAt(s, i);
        if (!f) continue;
        let sc = null;
        try { sc = st.score(f); } catch (e) { sc = null; }
        if (sc == null || !isFinite(sc) || sc <= 0) continue;
        cands.push({ s, f, sc });
      }
      cands.sort((a, b) => b.sc - a.sc);
      const equity = cash + pos.reduce((a, p) => a + p.s.history[i].c * p.shares, 0);
      for (const c of cands.slice(0, BT.maxPos - pos.length)) {
        if (i + 1 >= N) break;
        const entry = c.s.history[i + 1].o;        // 約定は翌日始値
        const p0 = plan({ ...c.f, price: entry }, st);
        const rr = entry - p0.stop;
        if (rr <= 0) continue;
        let shares = Math.floor((equity * BT.riskPct) / rr);
        const cost = shares * entry * (1 + BT.cost / 2);
        if (shares <= 0 || cost > cash) {
          shares = Math.floor(cash / (entry * (1 + BT.cost / 2)));
          if (shares <= 0) continue;
        }
        cash -= shares * entry * (1 + BT.cost / 2);
        pos.push({ s: c.s, entry, stop: p0.stop, target: p0.target, r: rr, shares, i });
      }
    }

    const eq = cash + pos.reduce((a, p) => a + p.s.history[i].c * p.shares, 0);
    peak = Math.max(peak, eq);
    maxDD = Math.min(maxDD, eq / peak - 1);
    if ((i - start) % 5 === 0 || i === N - 1) curve.push({ i: i - start, eq });
  }

  const final = curve[curve.length - 1].eq;
  const yrs = days / 252;
  const wins = closed.filter((c) => c.r > 0);
  const gp = closed.filter((c) => c.pnl > 0).reduce((a, c) => a + c.pnl, 0);
  const gl = Math.abs(closed.filter((c) => c.pnl < 0).reduce((a, c) => a + c.pnl, 0));
  return {
    final,
    totalRet: final / BT.capital - 1,
    cagr: Math.pow(final / BT.capital, 1 / yrs) - 1,
    maxDD,
    n: closed.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    avgR: closed.length ? closed.reduce((a, c) => a + c.r, 0) / closed.length : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    avgDays: closed.length ? closed.reduce((a, c) => a + c.days, 0) / closed.length : 0,
    curve, years: yrs,
  };
}

/* ベンチマーク: 均等買い持ち。手法がこれに勝てないなら、その手法は不要 */
function benchmark(universe, market, years) {
  const pool = universe.filter((s) => s.market === market);
  const N = pool[0].history.length;
  const days = Math.min(Math.round(years * 252), N - 261);
  const start = N - days;
  const curve = [];
  let peak = BT.capital, maxDD = 0;
  const w = BT.capital / pool.length;
  for (let i = start; i < N; i++) {
    const eq = pool.reduce((a, s) => a + (w / s.history[start].c) * s.history[i].c, 0);
    peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq / peak - 1);
    if ((i - start) % 5 === 0 || i === N - 1) curve.push({ i: i - start, eq });
  }
  const final = curve[curve.length - 1].eq;
  const yrs = days / 252;
  return { final, totalRet: final / BT.capital - 1, cagr: Math.pow(final / BT.capital, 1 / yrs) - 1, maxDD, curve, years: yrs };
}

/* ================================================================ 表示ユーティリティ */
const fmtP = (v, m) => (m === "JP" ? "¥" + Math.round(v).toLocaleString() : "$" + v.toFixed(2));
const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";

/* Gemini 連携用プロンプト生成 */
function geminiPrompt(s, hits, asof = "直近") {
  const reasons = hits.map((h) => `・${h.st.name}（${CAT[h.st.cat].label}）: スコア ${h.score.toFixed(2)}／根拠: ${h.st.thesis}`).join("\n");
  return `あなたは日米株のファンダメンタル分析を行うアナリストです。以下の銘柄について調査してください。

【銘柄】${s.code} ${s.name}（${s.market === "JP" ? "日本株" : "米国株"} / ${s.sector}）
【株価】${fmtP(s.price, s.market)}（${asof} 終値）

【この銘柄が機械的スクリーニングで抽出された理由】
${reasons}

【主要指標（スクリーニング時点）】
PER ${s.per.toFixed(1)}倍 / PBR ${s.pbr.toFixed(2)}倍 / ROE ${pct(s.roe)} / ROIC ${pct(s.roic)}
FCF利回り ${pct(s.fcfYield)} / 配当利回り ${pct(s.divYield)} / 配当性向 ${pct(s.payout, 0)}
EV/EBITDA ${s.evEbitda.toFixed(1)}倍 / Piotroski Fスコア ${s.fscore}/9 / Altman Z ${s.altmanZ.toFixed(1)}
12-1ヶ月モメンタム ${pct(s.mom12_1)} / 52週高値からの乖離 ${pct(s.dist52w)}

【調査してほしいこと】
1. 上記の定量シグナルは、事業の実態と整合しているか。数字だけが良く見えている「罠」ではないか。
2. 直近の決算・IR資料・適時開示で、この数字の背景にある事業上の出来事は何か。
3. この投資仮説が崩れるとしたら、どのような形か。最も可能性の高い失敗シナリオを挙げよ。
4. 同業他社と比較して、この銘柄固有の強み・弱みは何か。
5. 結論: 定量シグナルを支持するか、それとも定量が見落としている致命的な要因があるか。

※ 私は投資判断を自分で行います。推奨ではなく、判断材料としての事実と論点を提示してください。`;
}

/* ==================================================================== UI */
const css = `
:root{
  --ink:#0E1419; --ink2:#1B242E; --paper:#F4F5F2; --panel:#FFFFFF;
  --line:#D9DDD6; --line2:#E9ECE6;
  --pru:#1B3A5C; --pru-l:#2E5D8A;
  --grey:#6B7580; --grey-l:#98A1AA;
  --up:#2E6E62; --dn:#A63A28; --sig:#B8C900;
}
*{box-sizing:border-box;}
.ss{background:var(--paper);color:var(--ink);min-height:100vh;
  font-family:"Helvetica Neue",-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;
  -webkit-font-smoothing:antialiased;padding-bottom:76px;}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;}
.eyebrow{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--grey);font-weight:600;}

/* ---- instrument bar ---- */
.bar{background:var(--ink);color:#E8EBE6;padding:12px 16px;position:sticky;top:0;z-index:40;}
.bar-in{max-width:1180px;margin:0 auto;display:flex;align-items:center;gap:14px;flex-wrap:wrap;}
.logo{font-weight:800;letter-spacing:-.03em;font-size:19px;}
.logo span{color:var(--sig);}
.asof{font-size:11px;color:#8A939C;letter-spacing:.04em;}
.mkt-toggle{display:flex;background:#242E38;border-radius:6px;padding:2px;margin-left:auto;}
.mkt-toggle button{background:none;border:0;color:#8A939C;padding:5px 14px;border-radius:4px;
  font-size:12px;font-weight:700;cursor:pointer;letter-spacing:.05em;}
.mkt-toggle button[data-on="1"]{background:var(--sig);color:#0E1419;}

/* ---- regime ---- */
.regime{max-width:1180px;margin:0 auto;padding:14px 16px 0;display:flex;gap:10px;flex-wrap:wrap;}
.rg{flex:1;min-width:200px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:11px 13px;
  display:flex;align-items:center;gap:11px;}
.rg-dot{width:9px;height:9px;border-radius:50%;flex:none;}
.rg-t{font-size:12px;font-weight:700;}
.rg-s{font-size:11px;color:var(--grey);margin-top:2px;}

.wrap{max-width:1180px;margin:0 auto;padding:16px;}
.h1{font-size:24px;font-weight:800;letter-spacing:-.02em;margin:0 0 3px;}
.sub{font-size:12.5px;color:var(--grey);margin:0 0 18px;line-height:1.6;}

/* ---- strategy block ---- */
.sb{background:var(--panel);border:1px solid var(--line);border-radius:9px;margin-bottom:11px;overflow:hidden;}
.sb-h{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;}
.sb-h:hover{background:#FAFBF8;}
.tag{font-size:9.5px;font-weight:700;color:#fff;padding:2.5px 6px;border-radius:3px;letter-spacing:.05em;flex:none;}
.sb-n{font-weight:700;font-size:14.5px;letter-spacing:-.01em;}
.sb-sub{font-size:11px;color:var(--grey-l);margin-left:6px;font-weight:500;}
.cnt{margin-left:auto;font-size:11px;color:var(--grey);flex:none;}
.cnt b{color:var(--ink);font-size:14px;}
.info-b{background:none;border:1px solid var(--line);color:var(--grey);width:20px;height:20px;border-radius:50%;
  font-size:11px;cursor:pointer;flex:none;line-height:1;padding:0;}
.info-b:hover{border-color:var(--pru);color:var(--pru);}

.empty{padding:11px 14px 15px;font-size:12px;color:var(--grey-l);border-top:1px dashed var(--line2);}

/* ---- rows ---- */
.row{display:flex;align-items:center;gap:11px;padding:9px 14px;border-top:1px solid var(--line2);cursor:pointer;}
.row:hover{background:#FAFBF8;}
.row.strong{background:linear-gradient(90deg,rgba(184,201,0,.16),rgba(184,201,0,0) 62%);}
.rcode{font-size:12px;font-weight:700;width:52px;flex:none;}
.rname{font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rsec{font-size:10.5px;color:var(--grey-l);flex:none;}
.rpx{font-size:12px;width:78px;text-align:right;flex:none;}
.gauge{width:74px;height:5px;background:var(--line2);border-radius:3px;overflow:hidden;flex:none;}
.gauge i{display:block;height:100%;}
.rsc{font-size:11.5px;width:34px;text-align:right;color:var(--grey);flex:none;}
.bolt{font-size:10px;font-weight:800;color:#0E1419;background:var(--sig);padding:2px 5px;border-radius:3px;flex:none;letter-spacing:.03em;}
.add{background:none;border:1px solid var(--line);border-radius:4px;font-size:11px;padding:3px 9px;cursor:pointer;flex:none;color:var(--pru);font-weight:600;}
.add:hover{background:var(--pru);color:#fff;border-color:var(--pru);}
.add[disabled]{opacity:.4;cursor:default;}

/* ---- caliper (signature) ---- */
.cal{padding:12px 0 4px;}
.cal-t{display:flex;justify-content:space-between;font-size:10px;color:var(--grey-l);margin-bottom:5px;}
.rail{position:relative;height:26px;}
.rail-l{position:absolute;top:12px;left:0;right:0;height:2px;background:var(--line);}
.rail-z{position:absolute;top:6px;width:1px;height:14px;background:var(--ink);}
.rail-f{position:absolute;top:11px;height:4px;border-radius:2px;}
.rail-m{position:absolute;top:4px;width:1px;height:18px;}
.rail-c{position:absolute;top:5px;width:3px;height:16px;background:var(--ink);border-radius:1px;}
.rail-tk{position:absolute;top:14px;width:1px;height:5px;background:var(--line);}
.rail-lb{position:absolute;top:20px;font-size:8.5px;color:var(--grey-l);transform:translateX(-50%);}

/* ---- cards ---- */
.card{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:14px;margin-bottom:11px;}
.card.alert{border-color:var(--sig);box-shadow:0 0 0 3px rgba(184,201,0,.16);}
.c-h{display:flex;align-items:baseline;gap:9px;margin-bottom:2px;flex-wrap:wrap;}
.c-code{font-weight:800;font-size:15px;}
.c-name{font-size:13px;color:var(--grey);flex:1;min-width:0;}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(78px,1fr));gap:9px;margin:11px 0 0;}
.kv div{border-left:2px solid var(--line);padding-left:7px;}
.kv .k{font-size:9.5px;color:var(--grey-l);letter-spacing:.05em;}
.kv .v{font-size:13.5px;font-weight:700;margin-top:1px;}
.act{margin-top:11px;padding:9px 11px;background:#F7F9F4;border-left:3px solid var(--pru);font-size:12px;line-height:1.55;}
.act b{color:var(--pru);}

/* ---- table ---- */
.tbl{width:100%;border-collapse:collapse;font-size:12px;background:var(--panel);}
.tbl th{text-align:right;padding:8px 9px;border-bottom:2px solid var(--ink);font-size:10px;color:var(--grey);
  letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;}
.tbl th:first-child,.tbl td:first-child{text-align:left;}
.tbl td{padding:8px 9px;border-bottom:1px solid var(--line2);text-align:right;white-space:nowrap;}
.tbl tr:hover td{background:#FAFBF8;}
.tscroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px;}

/* ---- misc ---- */
.warn{background:#FFF8E6;border:1px solid #E8D9A0;border-radius:7px;padding:10px 12px;font-size:11.5px;
  line-height:1.6;margin-bottom:12px;color:#6B5A1F;}
.demo{background:var(--ink2);color:#C9D2C0;font-size:11px;padding:7px 16px;text-align:center;letter-spacing:.03em;}
.nav{position:fixed;bottom:0;left:0;right:0;background:var(--panel);border-top:1px solid var(--line);
  display:flex;z-index:50;padding-bottom:env(safe-area-inset-bottom);}
.nav button{flex:1;background:none;border:0;padding:9px 1px 10px;cursor:pointer;color:var(--grey-l);
  font-size:9.5px;font-weight:700;letter-spacing:.02em;}
.nav button b{display:block;font-size:16px;font-weight:400;margin-bottom:1px;}
.nav button[data-on="1"]{color:var(--pru);}
.modal{position:fixed;inset:0;background:rgba(14,20,25,.55);z-index:100;display:flex;align-items:flex-end;
  justify-content:center;padding:0;}
.sheet{background:var(--panel);width:100%;max-width:660px;max-height:88vh;overflow-y:auto;border-radius:14px 14px 0 0;padding:20px;}
.sheet h2{margin:6px 0 3px;font-size:19px;letter-spacing:-.02em;}
.sheet pre{white-space:pre-wrap;font-size:12.5px;line-height:1.75;color:#2A343E;
  font-family:inherit;margin:12px 0 0;}
.x{position:sticky;top:0;float:right;background:var(--line2);border:0;width:27px;height:27px;border-radius:50%;
  cursor:pointer;font-size:14px;color:var(--ink);}
.gbtn{width:100%;background:var(--pru);color:#fff;border:0;border-radius:7px;padding:11px;font-size:13px;
  font-weight:700;cursor:pointer;margin-top:11px;}
.gbtn:hover{background:var(--pru-l);}
.gnote{font-size:10.5px;color:var(--grey-l);margin-top:6px;line-height:1.55;}
.tog{display:flex;align-items:center;gap:9px;padding:9px 11px;border-bottom:1px solid var(--line2);cursor:pointer;}
.sw{width:34px;height:19px;border-radius:10px;background:var(--line);position:relative;transition:.15s;flex:none;}
.sw i{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:.15s;}
.sw[data-on="1"]{background:var(--pru);}
.sw[data-on="1"] i{left:17px;}
.pill{display:inline-block;font-size:10px;padding:2px 7px;border-radius:9px;border:1px solid var(--line);
  color:var(--grey);margin:0 4px 4px 0;cursor:pointer;background:var(--panel);}
.pill[data-on="1"]{background:var(--ink);color:#fff;border-color:var(--ink);}
.tmarks{display:inline-flex;gap:2px;flex:none;}
.tm{font-size:10px;font-weight:700;border:1px solid;border-radius:3px;padding:0 3px;line-height:1.5;
  font-family:ui-monospace,"SF Mono",Menlo,monospace;}
.tm i{font-style:normal;font-size:8px;opacity:.75;margin-right:1px;}
@media(max-width:640px){
  .rsec{display:none;} .rpx{width:64px;} .gauge{width:44px;}
  .wrap{padding:12px;} .h1{font-size:20px;}
}
`;

/* ------------------------------------------------------------ ローソク足 */
function Candles({ data, plan: p, market }) {
  const W = 640, H = 190, PAD = 34;
  const d = data.slice(-90);
  const lo = Math.min(...d.map((x) => x.l), p.stop) * 0.995;
  const hi = Math.max(...d.map((x) => x.h), p.target) * 1.005;
  const y = (v) => H - PAD / 2 - ((v - lo) / (hi - lo)) * (H - PAD);
  const bw = (W - 44) / d.length;
  const ma = (n) => d.map((_, i) => i < n - 1 ? null : d.slice(i - n + 1, i + 1).reduce((a, b) => a + b.c, 0) / n);
  const m25 = ma(25);
  const line = (arr, col) => {
    const pts = arr.map((v, i) => (v == null ? null : `${8 + i * bw + bw / 2},${y(v)}`)).filter(Boolean).join(" ");
    return <polyline points={pts} fill="none" stroke={col} strokeWidth="1.4" opacity=".8" />;
  };
  const lv = (v, col, lbl, dash) => (
    <g>
      <line x1="8" x2={W - 44} y1={y(v)} y2={y(v)} stroke={col} strokeWidth="1" strokeDasharray={dash || "4 3"} opacity=".85" />
      <text x={W - 41} y={y(v) + 3.5} fontSize="9" fill={col} fontWeight="700">{lbl}</text>
    </g>
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", marginTop: 10 }}>
      {d.map((c, i) => {
        const x = 8 + i * bw + bw / 2;
        const up = c.c >= c.o;
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={up ? "#2E6E62" : "#A63A28"} strokeWidth="1" />
            <rect x={x - bw * 0.3} y={y(Math.max(c.o, c.c))} width={Math.max(bw * 0.6, 1)}
              height={Math.max(Math.abs(y(c.o) - y(c.c)), 1)} fill={up ? "#2E6E62" : "#A63A28"} />
          </g>
        );
      })}
      {line(m25, "#B4531F")}
      {lv(p.target, "#1B3A5C", "利確")}
      {lv(p.entry, "#2E6E62", "買", "0")}
      {lv(p.stop, "#A63A28", "損切")}
    </svg>
  );
}

/* ------------------------------------------------------- Rレール(signature) */
function RRail({ cur, mae, mfe }) {
  const lo = -3, hi = 8;
  const x = (v) => ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * 100;
  return (
    <div className="cal">
      <div className="cal-t"><span>損失側</span><span className="mono">現在 {cur >= 0 ? "+" : ""}{cur.toFixed(2)}R</span><span>利益側</span></div>
      <div className="rail">
        <div className="rail-l" />
        <div className="rail-f" style={{
          left: `${x(Math.min(mae, 0))}%`, width: `${x(Math.max(mfe, 0)) - x(Math.min(mae, 0))}%`,
          background: "linear-gradient(90deg,rgba(166,58,40,.28),rgba(46,110,98,.28))",
        }} />
        <div className="rail-z" style={{ left: `${x(0)}%` }} />
        <div className="rail-m" style={{ left: `${x(mae)}%`, background: "#A63A28" }} />
        <div className="rail-m" style={{ left: `${x(mfe)}%`, background: "#2E6E62" }} />
        <div className="rail-c" style={{ left: `calc(${x(cur)}% - 1.5px)` }} />
        {[-2, 0, 2, 4, 6].map((t) => (
          <React.Fragment key={t}>
            <div className="rail-tk" style={{ left: `${x(t)}%` }} />
            <div className="rail-lb" style={{ left: `${x(t)}%` }}>{t}R</div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------- エクイティカーブ */
function EquityChart({ rows, bm }) {
  const W = 640, H = 210, L = 46, B = 20;
  const all = [bm.curve, ...rows.map((r) => r.bt.curve)];
  const maxI = Math.max(...all.map((c) => c[c.length - 1].i));
  const lo = Math.min(...all.flat().map((p) => p.eq)) * 0.97;
  const hi = Math.max(...all.flat().map((p) => p.eq)) * 1.03;
  const x = (i) => L + (i / maxI) * (W - L - 6);
  const y = (v) => H - B - ((v - lo) / (hi - lo)) * (H - B - 8);
  const path = (c) => c.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.eq).toFixed(1)}`).join("");
  const ticks = [lo, (lo + hi) / 2, hi];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", marginTop: 8 }}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={L} x2={W - 6} y1={y(t)} y2={y(t)} stroke="#E9ECE6" strokeWidth="1" />
          <text x={L - 5} y={y(t) + 3} fontSize="9" fill="#98A1AA" textAnchor="end" fontFamily="ui-monospace,monospace">
            {(t / 10000).toFixed(0)}万
          </text>
        </g>
      ))}
      {/* 元本ライン: ここを割ったら損 */}
      <line x1={L} x2={W - 6} y1={y(1000000)} y2={y(1000000)} stroke="#0E1419" strokeWidth="1" strokeDasharray="3 3" opacity=".5" />
      <text x={W - 8} y={y(1000000) - 4} fontSize="8.5" fill="#0E1419" textAnchor="end">元本100万</text>
      <path d={path(bm.curve)} fill="none" stroke="#98A1AA" strokeWidth="1.8" strokeDasharray="5 3" />
      {rows.map((r, i) => (
        <path key={i} d={path(r.bt.curve)} fill="none" stroke={CAT[r.st.cat].color} strokeWidth="1.6" opacity=".9" />
      ))}
      <text x={L} y={H - 5} fontSize="9" fill="#98A1AA">0年</text>
      <text x={W - 6} y={H - 5} fontSize="9" fill="#98A1AA" textAnchor="end">{(maxI / 252).toFixed(0)}年</text>
    </svg>
  );
}

/* ------------------------------------------------- トレンドマーク(株探風)
   銘柄名の横に、短期(25日)・中期(75日)・長期(200日)のチャートの形を
   ひと目で示す3つのマークを並べる。各時間軸について:
     ↗ (緑)  = 株価が移動平均の上 かつ 移動平均が上向き
     ↘ (赤)  = 株価が移動平均の下 かつ 移動平均が下向き
     → (灰)  = ねじれ(上抜け直後・下抜け直後・横ばい)
   「3つとも↗」がパーフェクトオーダー相当。ひと目で時間軸の揃い方が分かる。 */
function trendStates(history) {
  const h = history;
  const n = h.length;
  const calc = (win) => {
    if (n < win + 6) return 0;
    const ma = (end) => {
      let s = 0;
      for (let i = end - win + 1; i <= end; i++) s += h[i].c;
      return s / win;
    };
    const now = ma(n - 1), prev = ma(n - 6);
    const px = h[n - 1].c;
    if (px > now && now > prev) return 1;   // 上昇
    if (px < now && now < prev) return -1;  // 下降
    return 0;                                // ねじれ・横ばい
  };
  return [calc(25), calc(75), calc(200)];
}

const TREND_GLYPH = { 1: "↗", 0: "→", "-1": "↘" };
const TREND_COLOR = { 1: "#2E6E62", 0: "#98A1AA", "-1": "#A63A28" };

function TrendMarks({ history }) {
  const states = useMemo(() => trendStates(history), [history]);
  const labels = ["短", "中", "長"];
  return (
    <span className="tmarks" title={`短期(25日) / 中期(75日) / 長期(200日)のトレンド`}>
      {states.map((st, i) => (
        <span key={i} className="tm" style={{ color: TREND_COLOR[st], borderColor: TREND_COLOR[st] + "55" }}>
          <i>{labels[i]}</i>{TREND_GLYPH[st]}
        </span>
      ))}
    </span>
  );
}

/* ============================================================== メイン */
/* ============================================================================
   永続化フック
   ----------------------------------------------------------------------------
   ポートフォリオや登録銘柄はブラウザの localStorage に保存する。サーバを
   持たない設計(§3.1)なので、これが唯一の永続化手段になる。

   Claude.ai のアーティファクト・プレビュー環境では localStorage が使えない
   ことがあるため、try/catch で必ずガードし、失敗時は従来通りメモリ内の
   state のみで動作する(その場合はリロードで消える。プレビュー中は
   その挙動で構わないが、実際にデプロイした環境では永続化される)。
   ============================================================================ */
function usePersistentState(key, initial) {
  const [state, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw != null ? JSON.parse(raw) : initial;
    } catch (e) { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) { /* 保存不可環境は無視 */ }
  }, [key, state]);
  return [state, setState];
}

export default function StockScout() {
  const [snap, setSnap] = useState(null);
  const [market, setMarket] = useState("JP");
  const [tab, setTab] = useState("dash");
  /* 手法の表示ON/OFF。保存済み設定に「後から追加された手法」のIDが無い場合、
     undefined = falsy で新手法が永久に非表示になるバグがあったため、
     デフォルト(全ON)に保存値を上書きマージする形で復元する。 */
  const [enabled, setEnabled] = usePersistentState(
    "ss_enabled", Object.fromEntries(STRATEGIES.map((s) => [s.id, true]))
  );
  const enabledMerged = useMemo(
    () => ({ ...Object.fromEntries(STRATEGIES.map((s) => [s.id, true])), ...enabled }),
    [enabled]
  );
  const [watch, setWatch] = usePersistentState("ss_watch", []);
  const [modal, setModal] = useState(null);
  const [gemUrl, setGemUrl] = usePersistentState("ss_gemurl", "https://gemini.google.com/app");
  const [copied, setCopied] = useState(false);
  const [catFilter, setCatFilter] = useState(null);
  const [btYears, setBtYears] = useState(5);
  const [btResult, setBtResult] = useState(null);
  const [btRunning, setBtRunning] = useState(false);
  const [portfolio, setPortfolio] = usePersistentState("ss_portfolio", []);
  const [pfForm, setPfForm] = useState(null);
  const [fullUniverse, setFullUniverse] = useState(null);   // デモ運用タブ専用の全履歴(遅延ロード)
  const [historyStatus, setHistoryStatus] = useState("idle"); // idle | loading | ready | unavailable
  const [focusMode, setFocusMode] = usePersistentState("ss_focus", true);   // 各手法上位3件表示
  const [hideEmpty, setHideEmpty] = usePersistentState("ss_hideempty", false);
  const [capital, setCapital] = usePersistentState("ss_capital", 1000000);  // ポジションサイズ計算用の運用資金

  /* 「デモ運用」タブを初めて開いたときだけ、重い全履歴データを取りに行く。
     デモ表示中(snap.demo)は既に snap.universe が全履歴を持っているため不要。 */
  useEffect(() => {
    if (tab !== "demo" || fullUniverse || !snap || snap.demo) return;
    setHistoryStatus("loading");
    DATA_SOURCE.loadHistory().then((h) => {
      if (h?.universe) { setFullUniverse(h.universe); setHistoryStatus("ready"); }
      else setHistoryStatus("unavailable");
    });
  }, [tab, snap, fullUniverse]);

  const btUniverse = snap?.demo ? snap?.universe : (fullUniverse || snap?.universe);

  const runBacktest = () => {
    setBtRunning(true);
    /* 全手法×10年を回すと数秒かかる。描画をブロックしないよう次フレームへ逃がす */
    setTimeout(() => {
      const rows = [];
      for (const st of STRATEGIES) {
        if (!st.markets.includes(market)) continue;
        const bt = backtest(btUniverse, market, st, btYears);
        if (bt) rows.push({ st, bt });
      }
      rows.sort((a, b) => b.bt.cagr - a.bt.cagr);
      setBtResult({ rows, bm: benchmark(btUniverse, market, btYears), market, years: btYears });
      setBtRunning(false);
    }, 30);
  };

  useEffect(() => { DATA_SOURCE.load().then(setSnap); }, []);

  const signals = useMemo(() => (snap ? runScreen(snap.universe, market) : {}), [snap, market]);

  /* 通知は銘柄単位に集約する。同じ銘柄が手法の数だけ並ぶのは通知ではなく騒音 */
  const strongList = useMemo(() => {
    const by = new Map();
    for (const st of STRATEGIES) {
      if (!enabledMerged[st.id]) continue;
      for (const h of signals[st.id] || []) {
        if (!h._strong) continue;
        if (!by.has(h.code)) by.set(h.code, { s: h, sts: [] });
        by.get(h.code).sts.push(st);
      }
    }
    return [...by.values()].sort((a, b) => b.s._confluence - a.s._confluence);
  }, [signals, enabled]);

  const visible = STRATEGIES.filter(
    (st) => enabledMerged[st.id] && st.markets.includes(market) && (!catFilter || st.cat === catFilter)
  );

  /* ---------------------------------------------------------------------
     ポートフォリオの定期判定シミュレーション
     -----------------------------------------------------------------------
     本番では GitHub Actions の日次バッチが、株価更新後にこの同じ
     evaluateHolding() を全保有銘柄に対して実行し、結果を snapshot.json の
     portfolio_signals に書き出す。そこから notify_discord.py が
     「新たに買い増し/売りシグナルが立った銘柄」だけを通知する(既存銘柄の
     連日の再通知は行わない。仕様は Discord 通知の設計と同じ思想)。

     このクライアント側では、snap(前日終値データ)が更新されるたびに
     全保有銘柄を再評価することで、その日次バッチの動作を再現している。
     つまり「ページを開く」ことが「本日分のバッチが1回走る」ことに相当する。
  --------------------------------------------------------------------- */
  const pfEval = useMemo(() => {
    if (!snap) return [];
    return portfolio.map((h) => ({ h, ev: evaluateHolding(h, snap.universe) }));
  }, [portfolio, snap]);

  const pfAlerts = pfEval.filter((x) => x.ev.signal === "add" || x.ev.signal?.startsWith("sell"));

  const addWatch = (s, st) => {
    if (watch.some((w) => w.code === s.code && w.stId === st.id)) return;
    const p = plan(s, st);
    /* 銘柄の全履歴(数千日×25指標)は保存しない。localStorage の容量制限に
       すぐ達してしまうため。識別子だけ保存し、表示時に snap.universe から
       毎回引き直す(evaluateHolding と同じパターン)。 */
    setWatch((w) => [...w, {
      id: `${s.code}_${st.id}_${Date.now()}`, code: s.code, market: s.market,
      stId: st.id, date: snap.asof, plan: p,
    }]);
  };

  const openStock = (s) => {
    const hits = STRATEGIES.filter((st) => enabledMerged[st.id] && st.markets.includes(s.market))
      .map((st) => { let v = null; try { v = st.score(s); } catch (e) {} return v ? { st, score: Math.min(1, v) } : null; })
      .filter(Boolean).sort((a, b) => b.score - a.score);
    setModal({ type: "stock", s, hits });
  };

  const copyPrompt = (s, hits) => {
    const t = geminiPrompt(s, hits, snap?.asof);
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 2200); window.open(gemUrl, "_blank"); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(done).catch(() => {
      const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta);
      ta.select(); document.execCommand("copy"); ta.remove(); done();
    });
  };

  if (!snap) return <div className="ss"><style>{css}</style><div className="wrap"><p className="sub">読み込み中</p></div></div>;

  const rg = snap.regime[market];

  return (
    <div className="ss">
      <style>{css}</style>

      <div className="bar">
        <div className="bar-in">
          <div className="logo">Stock<span>Scout</span></div>
          <div className="asof mono">前日終値 {snap.asof}</div>
          <div className="mkt-toggle">
            {["JP", "US"].map((m) => (
              <button key={m} data-on={market === m ? 1 : 0} onClick={() => setMarket(m)}>{m === "JP" ? "日本株" : "米国株"}</button>
            ))}
          </div>
        </div>
      </div>

      {snap.demo && (
        <div className="demo">
          検証用データで表示しています。J-Quants / GOOGLEFINANCE のバッチを接続すると実データに切り替わります。
        </div>
      )}

      {/* 市場レジーム */}
      <div className="regime">
        {["JP", "US"].map((m) => {
          const r = snap.regime[m];
          const ok = r.above200 && r.breadth > 0.5;
          const col = ok ? "#2E6E62" : r.above200 ? "#B4531F" : "#A63A28";
          return (
            <div className="rg" key={m}>
              <div className="rg-dot" style={{ background: col }} />
              <div>
                <div className="rg-t">{m === "JP" ? "日本市場" : "米国市場"} — {r.label}</div>
                <div className="rg-s mono">
                  指数 {r.above200 ? "> 200日線" : "< 200日線"} / ブレッドス {pct(r.breadth, 0)}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="wrap">
        {/* ==================== ダッシュボード ==================== */}
        {tab === "dash" && (
          <>
            <h1 className="h1">今日の推薦</h1>
            <p className="sub">
              前日終値時点のデータで {visible.length} 手法を実行しました。条件を満たす銘柄が無い手法は「0件」と表示します。無理に推薦はしません。
            </p>

            {!rg.above200 && (
              <div className="warn">
                <b>市場レジーム警告</b> — {market === "JP" ? "TOPIX" : "S&P500"} が200日移動平均を下回っています。
                トレンドフォロー系の手法は新規推薦を停止しました。地合いの判断が個別銘柄の判断に優先します。
              </div>
            )}
            {rg.above200 && rg.breadth < 0.45 && (
              <div className="warn">
                <b>ブレッドス警告</b> — 指数は200日線の上ですが、200日線を上回る銘柄は {pct(rg.breadth, 0)} に留まります。
                上昇が一部の銘柄に偏っており、推薦の信頼度が普段より低い可能性があります。
              </div>
            )}

            {strongList.length > 0 && (
              <div className="card alert" style={{ marginBottom: 16 }}>
                <div className="eyebrow" style={{ color: "#7C8800" }}>強い推薦 {strongList.length} 件 — Discord 通知済み</div>
                <p className="sub" style={{ margin: "6px 0 10px" }}>
                  性格の異なる 4 カテゴリ以上の手法が、同時に同じ銘柄を指しました。逆を向くはずの手法が一致するのは偶然では起きにくく、それ自体が情報です。
                </p>
                {strongList.map(({ s, sts }, i) => (
                  <div key={i} style={{ padding: "8px 0", borderTop: i ? "1px solid var(--line2)" : 0, cursor: "pointer" }}
                    onClick={() => openStock(s)}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span className="bolt">合流 {s._confluence}</span>
                      <b className="mono" style={{ fontSize: 13 }}>{s.code}</b>
                      <span style={{ fontSize: 13 }}>{s.name}</span>
                      <span className="mono" style={{ marginLeft: "auto", fontSize: 12 }}>{fmtP(s.price, s.market)}</span>
                    </div>
                    <div style={{ marginTop: 5 }}>
                      {sts.map((st) => (
                        <span key={st.id} className="tag" style={{ background: CAT[st.cat].color, marginRight: 4, display: "inline-block" }}>{st.name}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginBottom: 11 }}>
              <span className="pill" data-on={catFilter === null ? 1 : 0} onClick={() => setCatFilter(null)}>すべて</span>
              {Object.entries(CAT).map(([k, v]) => (
                <span key={k} className="pill" data-on={catFilter === k ? 1 : 0} onClick={() => setCatFilter(catFilter === k ? null : k)}>{v.label}</span>
              ))}
            </div>

            {/* 表示モード切替: 43手法×最大8件では多すぎて選定作業にならない。
                フォーカスモード(既定ON)は各手法の上位3件だけに絞り、
                0件の手法も畳む。全量が見たいときだけ解除する。 */}
            <div style={{ marginBottom: 11, display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span className="pill" data-on={focusMode ? 1 : 0} onClick={() => setFocusMode(!focusMode)}>
                フォーカス表示(各手法 上位3件)
              </span>
              <span className="pill" data-on={hideEmpty ? 1 : 0} onClick={() => setHideEmpty(!hideEmpty)}>
                0件の手法を隠す
              </span>
            </div>

            {visible.map((st) => {
              const hitsAll = signals[st.id] || [];
              if (hideEmpty && hitsAll.length === 0) return null;
              const hits = focusMode ? hitsAll.slice(0, 3) : hitsAll;
              return (
                <div className="sb" key={st.id}>
                  <div className="sb-h" onClick={() => setModal({ type: "strategy", st })}>
                    <span className="tag" style={{ background: CAT[st.cat].color }}>{CAT[st.cat].label}</span>
                    <span className="sb-n">{st.name}</span>
                    <span className="sb-sub">{st.subtitle}</span>
                    <button className="info-b" onClick={(e) => { e.stopPropagation(); setModal({ type: "strategy", st }); }}>i</button>
                    <span className="cnt"><b>{hitsAll.length}</b> 件{focusMode && hitsAll.length > 3 ? `（上位3件を表示）` : ""}</span>
                  </div>
                  {hitsAll.length === 0 ? (
                    <div className="empty">本日は条件を満たす銘柄がありませんでした。</div>
                  ) : (
                    hits.map((h) => (
                      <div className={"row" + (h._strong ? " strong" : "")} key={h.code} onClick={() => openStock(h)}>
                        {h._strong && <span className="bolt">強</span>}
                        <span className="rcode mono">{h.code}</span>
                        <span className="rname">{h.name}</span>
                        <TrendMarks history={h.history} />
                        <span className="rsec">{h.sector}</span>
                        <span className="rpx mono">{fmtP(h.price, h.market)}</span>
                        <span className="gauge"><i style={{ width: `${h._score * 100}%`, background: CAT[st.cat].color }} /></span>
                        <span className="rsc mono">{h._score.toFixed(2)}</span>
                        <button className="add" disabled={watch.some((w) => w.code === h.code && w.stId === st.id)}
                          onClick={(e) => { e.stopPropagation(); addWatch(h, st); }}>
                          {watch.some((w) => w.code === h.code && w.stId === st.id) ? "登録済" : "登録"}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* ==================== 登録銘柄 ==================== */}
        {tab === "watch" && (
          <>
            <h1 className="h1">登録銘柄</h1>
            <p className="sub">
              推薦した手法のルールに基づいて、買う位置・損切り・利確を表示します。損益はすべて R（初期リスクの何倍か）で測ります。
              円とドル、値がさ株と低位株を同じ物差しで比べるためです。
            </p>
            {watch.length === 0 ? (
              <div className="card" style={{ textAlign: "center", padding: 34 }}>
                <div style={{ fontSize: 13, color: "var(--grey)" }}>まだ登録がありません。</div>
                <button className="gbtn" style={{ maxWidth: 220, margin: "13px auto 0" }} onClick={() => setTab("dash")}>
                  今日の推薦を見る
                </button>
              </div>
            ) : (
              watch.map((w) => {
                const st = STRATEGIES.find((x) => x.id === w.stId);
                const cs = snap.universe.find((x) => x.code === w.code && x.market === w.market);
                if (!cs) {
                  return (
                    <div className="card" key={w.id}>
                      <div className="c-h"><span className="c-code mono">{w.code}</span><span className="c-name">現在データが見つかりません</span></div>
                      <button className="add" style={{ marginTop: 9, color: "var(--dn)" }} onClick={() => setWatch((x) => x.filter((y) => y.id !== w.id))}>削除</button>
                    </div>
                  );
                }
                const curR = (cs.price - w.plan.entry) / w.plan.r;
                return (
                  <div className="card" key={w.id}>
                    <div className="c-h">
                      <span className="c-code mono">{w.code}</span>
                      <span className="c-name">{cs.name}</span>
                      <span className="tag" style={{ background: CAT[st.cat].color }}>{st.name}</span>
                    </div>
                    <div className="eyebrow">{HORIZON[st.horizon]} ・ 登録 {w.date}</div>
                    <Candles data={cs.history} plan={w.plan} market={w.market} />
                    <RRail cur={curR} mae={Math.min(curR, 0)} mfe={Math.max(curR, 0)} />
                    <div className="kv">
                      <div><div className="k">買い目安</div><div className="v mono">{fmtP(w.plan.entry, w.market)}</div></div>
                      <div style={{ borderColor: "#A63A28" }}><div className="k">損切り</div><div className="v mono" style={{ color: "var(--dn)" }}>{fmtP(w.plan.stop, w.market)}</div></div>
                      <div style={{ borderColor: "#1B3A5C" }}><div className="k">利確目安</div><div className="v mono" style={{ color: "var(--pru)" }}>{fmtP(w.plan.target, w.market)}</div></div>
                      <div><div className="k">現在値</div><div className="v mono">{fmtP(cs.price, w.market)}</div></div>
                      <div><div className="k">現在の実績</div><div className="v mono" style={{ color: curR >= 0 ? "var(--up)" : "var(--dn)" }}>{curR >= 0 ? "+" : ""}{curR.toFixed(2)}R</div></div>
                      <div style={{ borderColor: "#2E6E62" }}>
                        <div className="k">推奨株数</div>
                        <div className="v mono">{Math.max(0, Math.floor((capital * 0.01) / w.plan.r)).toLocaleString()}株</div>
                      </div>
                    </div>
                    <p className="gnote" style={{ marginTop: 4 }}>
                      推奨株数 = 運用資金{(capital / 10000).toLocaleString()}万円の1%を、この銘柄の損切り幅で割った数。
                      損切りに掛かっても資金の1%しか失わない株数です(資金は設定で変更可)。
                    </p>
                    <div className="act">
                      <b>次にすること</b> — {st.exitRule}
                    </div>
                    <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
                      <button className="add" style={{ flex: 1, padding: "7px" }} onClick={() => openStock(cs)}>詳細を見る</button>
                      <button className="add" style={{ padding: "7px 11px", color: "var(--dn)", borderColor: "#E3C9C3" }}
                        onClick={() => setWatch((x) => x.filter((y) => y.id !== w.id))}>削除</button>
                    </div>
                  </div>
                );
              })
            )}
          </>
        )}

        {/* ==================== ポートフォリオ ==================== */}
        {tab === "pf" && (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <h1 className="h1" style={{ marginBottom: 3 }}>ポートフォリオ</h1>
              <button className="add" style={{ marginLeft: "auto" }} onClick={() => setPfForm({ mode: "new", code: "", market, costBasis: "", shares: "", date: snap.asof, stId: "" })}>
                + 保有銘柄を登録
              </button>
            </div>
            <p className="sub">
              取得単価をもとに、買い増し・売りのシグナルを毎日自動で再判定します。含み損だから買い増す、含み益だから安心する、
              という理由付けはしません。判定基準は「選んだときの手法が、今この瞬間も同じ結論を出すかどうか」だけです。
            </p>

            {portfolio.length === 0 ? (
              <div className="card" style={{ textAlign: "center", padding: 34 }}>
                <div style={{ fontSize: 13, color: "var(--grey)" }}>保有銘柄が登録されていません。</div>
              </div>
            ) : (
              <>
                {(() => {
                  const rows = pfEval.filter((x) => x.ev.s);
                  const cost = rows.reduce((a, x) => a + x.h.costBasis * x.h.shares, 0);
                  const val = rows.reduce((a, x) => a + x.ev.s.price * x.h.shares, 0);
                  return (
                    <div className="card">
                      <div className="kv">
                        <div><div className="k">取得総額(概算)</div><div className="v mono">{Math.round(cost).toLocaleString()}</div></div>
                        <div><div className="k">評価額(概算)</div><div className="v mono">{Math.round(val).toLocaleString()}</div></div>
                        <div style={{ borderColor: val >= cost ? "#2E6E62" : "#A63A28" }}>
                          <div className="k">含み損益</div>
                          <div className="v mono" style={{ color: val >= cost ? "var(--up)" : "var(--dn)" }}>
                            {val >= cost ? "+" : ""}{Math.round(val - cost).toLocaleString()}（{val >= cost ? "+" : ""}{((val / cost - 1) * 100).toFixed(1)}%）
                          </div>
                        </div>
                        <div><div className="k">要対応</div><div className="v mono" style={{ color: pfAlerts.length ? "var(--dn)" : "inherit" }}>{pfAlerts.length}件</div></div>
                      </div>
                      <p className="gnote" style={{ marginTop: 8 }}>
                        円と米ドルの保有が混在する場合、この合計は為替換算をしていない概算値です(通貨別に見てください)。
                      </p>
                    </div>
                  );
                })()}

                {pfAlerts.length > 0 && (
                  <div className="card alert" style={{ borderColor: pfAlerts.some(x => x.ev.signal?.startsWith("sell")) ? "#D9A08F" : "#B8C900" }}>
                    <div className="eyebrow" style={{ color: "#7C8800" }}>本日の再判定 — 要対応 {pfAlerts.length} 件</div>
                    {pfAlerts.map(({ h, ev }, i) => (
                      <div key={i} style={{ padding: "8px 0", borderTop: i ? "1px solid var(--line2)" : 0, display: "flex", gap: 9, alignItems: "flex-start" }}>
                        <span className="bolt" style={{ background: SIGNAL_UI[ev.signal].color, color: "#fff" }}>{SIGNAL_UI[ev.signal].label}</span>
                        <div style={{ fontSize: 12 }}>
                          <b className="mono">{h.code}</b> {ev.s?.name} — <span style={{ color: "var(--grey)" }}>{ev.reason}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {pfEval.map(({ h, ev }) => {
                  if (!ev.s) {
                    return (
                      <div className="card" key={h.id}>
                        <div className="c-h"><span className="c-code mono">{h.code}</span><span className="c-name">データが見つかりません</span></div>
                      </div>
                    );
                  }
                  const sig = SIGNAL_UI[ev.signal];
                  const p = { entry: h.costBasis, stop: ev.stop, target: h.costBasis + ev.rUnit * (ev.st?.horizon === "swing" ? 3 : ev.st?.horizon === "mid" ? 4 : 6), r: ev.rUnit };
                  return (
                    <div className={"card" + (ev.signal !== "hold" ? " alert" : "")} key={h.id} style={ev.signal !== "hold" ? { borderColor: sig.color, boxShadow: `0 0 0 3px ${sig.bg}` } : {}}>
                      <div className="c-h">
                        <span className="c-code mono">{h.code}</span>
                        <span className="c-name">{ev.s.name}</span>
                        {ev.st ? <span className="tag" style={{ background: CAT[ev.st.cat].color }}>{ev.st.name}</span>
                          : <span className="tag" style={{ background: "#6B7580" }}>自己管理</span>}
                      </div>
                      <div className="eyebrow">取得日 {h.date} ・ {h.shares.toLocaleString()}株</div>

                      <Candles data={ev.s.history} plan={p} market={h.market} />
                      <RRail cur={ev.curR} mae={Math.min(ev.curR, 0)} mfe={Math.max(ev.curR, 0)} />

                      <div className="kv">
                        <div><div className="k">取得単価</div><div className="v mono">{fmtP(h.costBasis, h.market)}</div></div>
                        <div><div className="k">現在値</div><div className="v mono">{fmtP(ev.s.price, h.market)}</div></div>
                        <div style={{ borderColor: ev.unrealizedYen >= 0 ? "#2E6E62" : "#A63A28" }}>
                          <div className="k">含み損益</div>
                          <div className="v mono" style={{ color: ev.unrealizedYen >= 0 ? "var(--up)" : "var(--dn)" }}>
                            {ev.unrealizedYen >= 0 ? "+" : ""}{Math.round(ev.unrealizedYen).toLocaleString()}
                          </div>
                        </div>
                        <div><div className="k">損益率</div><div className="v mono">{ev.unrealizedPct >= 0 ? "+" : ""}{pct(ev.unrealizedPct)}</div></div>
                        <div style={{ borderColor: "#A63A28" }}><div className="k">損切り水準</div><div className="v mono" style={{ color: "var(--dn)" }}>{fmtP(ev.stop, h.market)}</div></div>
                      </div>

                      <div className="act" style={{ borderColor: sig.color, background: sig.bg }}>
                        <b style={{ color: sig.color }}>{sig.label}</b> — {ev.reason}
                      </div>

                      <div style={{ display: "flex", gap: 7, marginTop: 9 }}>
                        <button className="add" style={{ flex: 1, padding: "7px" }} onClick={() => openStock(ev.s)}>詳細を見る</button>
                        <button className="add" style={{ padding: "7px 11px" }}
                          onClick={() => setPfForm({ mode: "edit", id: h.id, code: h.code, market: h.market, costBasis: h.costBasis, shares: h.shares, date: h.date, stId: h.stId || "" })}>
                          編集
                        </button>
                        <button className="add" style={{ padding: "7px 11px", color: "var(--dn)", borderColor: "#E3C9C3" }}
                          onClick={() => setPortfolio((x) => x.filter((y) => y.id !== h.id))}>削除</button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}

            <div className="card">
              <div className="eyebrow">この判定について</div>
              <p className="sub" style={{ margin: "7px 0 0" }}>
                買い増しシグナルは「価格が下がったこと」を理由にしません。割り当てた手法のスクリーニング条件を、
                今この瞬間も強く満たしている場合にだけ出します。手法を割り当てていない銘柄(自己管理)には、
                そもそも買い増しシグナルを出しません。判断の拠り所となる仮説が存在しないためです。<br /><br />
                本番運用では、日次バッチが株価更新のたびにこの判定を全保有銘柄に対して実行し、新たに立った
                シグナルだけを Discord へ通知します(前日と同じ内容は再通知しません)。
              </p>
            </div>
          </>
        )}

        {/* ==================== 手法比較 ==================== */}
        {tab === "perf" && (
          <>
            <h1 className="h1">手法比較</h1>
            <p className="sub">
              このアプリの心臓部です。全手法に同じ土俵で推薦を出させ、その後を機械的に追跡します。ここに十分な件数が溜まるまで、成績は運と区別できません。
            </p>
            <div className="warn">
              <b>まだ計測が始まっていません</b> — フォワードテストは、バッチが毎営業日シグナルを記録し始めた時点からカウントされます。
              各手法が 100 件程度に達するまで、この画面の数値で判断してはいけません。20件の勝率60%は、コイン投げと区別がつきません。
            </div>
            <div className="tscroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>手法</th><th>本日</th><th>件数</th><th>勝率</th><th>平均R</th><th>PF</th><th>最大DD</th>
                  </tr>
                </thead>
                <tbody>
                  {STRATEGIES.filter((st) => st.markets.includes(market)).map((st) => (
                    <tr key={st.id} style={{ cursor: "pointer" }} onClick={() => setModal({ type: "strategy", st })}>
                      <td>
                        <span className="tag" style={{ background: CAT[st.cat].color, marginRight: 6 }}>{CAT[st.cat].label}</span>
                        {st.name}
                      </td>
                      <td className="mono">{(signals[st.id] || []).length}</td>
                      <td className="mono" style={{ color: "var(--grey-l)" }}>0</td>
                      <td className="mono" style={{ color: "var(--grey-l)" }}>—</td>
                      <td className="mono" style={{ color: "var(--grey-l)" }}>—</td>
                      <td className="mono" style={{ color: "var(--grey-l)" }}>—</td>
                      <td className="mono" style={{ color: "var(--grey-l)" }}>—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sub" style={{ marginTop: 13 }}>
              モードB（J-Quants の12週遅延データを使い、12週前を「現在」と見立てて疑似的に日を進める）を回すと、
              この表は数時間で埋まります。手法の絞り込みは、実運用より先にそこで済ませるのが合理的です。
            </p>
          </>
        )}

        {/* ==================== デモトレード(モードB) ==================== */}
        {tab === "demo" && (
          <>
            <h1 className="h1">デモトレード</h1>
            <p className="sub">
              100万円を各手法に渡して、過去{btYears}年間その手法だけで運用させたらどうなったかを計算します。
              約定は翌日始値、手数料とスリッページを往復0.2%引き、損切りは日中の安値で判定します。
            </p>

            {snap.demo && (
              <div className="warn" style={{ background: "#FBEEEA", borderColor: "#E0BFB6", color: "#7A3E2E" }}>
                <b>この数字を投資判断に使ってはいけません</b><br />
                いま動いているのは検証用の乱数データです。ここに出るリターンは「計算エンジンが正しく動いている証拠」であって、
                「手法が儲かる証拠」ではありません。乱数に対しても、成績の良い手法と悪い手法は必ず生まれます。それは実力ではなく偶然です。<br />
                数字が並ぶと人は信じてしまいます。実データを接続するまで、この画面は順位ではなく<b>挙動</b>だけを見てください。
              </div>
            )}

            {!snap.demo && historyStatus === "loading" && (
              <div className="warn">全期間の履歴データを読み込んでいます…(初回のみ数秒かかります)</div>
            )}
            {!snap.demo && historyStatus === "unavailable" && (
              <div className="warn" style={{ background: "#FBEEEA", borderColor: "#E0BFB6", color: "#7A3E2E" }}>
                <b>全期間の履歴データ(history.json)が見つかりません。</b><br />
                ダッシュボード表示用の短い履歴のみで計算するため、バックテストの期間が実際より短く扱われます。
                日次バッチが history.json を出力しているか確認してください。
              </div>
            )}

            <div className="card">
              <div className="eyebrow">運用期間</div>
              <div style={{ margin: "9px 0 0" }}>
                {[1, 2, 3, 5, 7, 10].map((y) => (
                  <span key={y} className="pill" data-on={btYears === y ? 1 : 0}
                    onClick={() => { setBtYears(y); setBtResult(null); }}>{y}年</span>
                ))}
              </div>
              {btYears > 5 && (
                <p className="gnote" style={{ color: "#A63A28", marginTop: 8 }}>
                  J-Quants Light プランで取得できるのは 5年前まで です。{btYears}年の実データ検証には Standard プラン以上が必要になります。
                  この画面は検証用データのため{btYears}年でも計算できますが、実データ接続後は 5年 が上限になります。
                </p>
              )}
              <div className="kv" style={{ marginTop: 13 }}>
                <div><div className="k">初期資金</div><div className="v mono">¥1,000,000</div></div>
                <div><div className="k">1回のリスク</div><div className="v mono">1.0%</div></div>
                <div><div className="k">最大同時保有</div><div className="v mono">5銘柄</div></div>
                <div><div className="k">売買コスト</div><div className="v mono">0.2%</div></div>
              </div>
              <button className="gbtn" onClick={runBacktest} disabled={btRunning}>
                {btRunning ? "計算中…" : `${market === "JP" ? "日本株" : "米国株"} で ${btYears}年間 運用させる`}
              </button>
            </div>

            {btResult && (
              <>
                <div className="card">
                  <div className="eyebrow">資産推移 — 上位5手法とベンチマーク</div>
                  <EquityChart rows={btResult.rows.slice(0, 5)} bm={btResult.bm} />
                  <div style={{ marginTop: 9, fontSize: 11, lineHeight: 1.9 }}>
                    <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                      <span style={{ width: 16, height: 2, background: "#98A1AA", flex: "none" }} />
                      <span style={{ color: "var(--grey)" }}>
                        ベンチマーク(均等買い持ち) — {Math.round(btResult.bm.final).toLocaleString()}円 / 年率 {pct(btResult.bm.cagr)}
                      </span>
                    </div>
                    {btResult.rows.slice(0, 5).map((r, i) => (
                      <div key={i} style={{ display: "flex", gap: 7, alignItems: "center" }}>
                        <span style={{ width: 16, height: 2, background: CAT[r.st.cat].color, flex: "none" }} />
                        <span>{r.st.name} — {Math.round(r.bt.final).toLocaleString()}円 / 年率 {pct(r.bt.cagr)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="act" style={{ marginTop: 12 }}>
                    <b>ベンチマークに勝てない手法は不要です</b> — 手間をかけて銘柄を選んだ結果が、
                    全銘柄を等しく買って放置するより悪いなら、その手法は存在価値がありません。
                    上の灰色の線を超えられているかが、最初の関門です。
                  </div>
                </div>

                <div className="tscroll">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>手法</th><th>最終資産</th><th>年率</th><th>最大DD</th>
                        <th>件数</th><th>勝率</th><th>平均R</th><th>PF</th><th>平均保有</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr style={{ background: "#F2F4F1" }}>
                        <td><b>ベンチマーク</b>（均等買い持ち）</td>
                        <td className="mono"><b>{Math.round(btResult.bm.final).toLocaleString()}</b></td>
                        <td className="mono"><b>{pct(btResult.bm.cagr)}</b></td>
                        <td className="mono">{pct(btResult.bm.maxDD)}</td>
                        <td colSpan={5} className="mono" style={{ color: "var(--grey-l)" }}>—</td>
                      </tr>
                      {btResult.rows.map((r) => {
                        const beat = r.bt.cagr > btResult.bm.cagr;
                        return (
                          <tr key={r.st.id} style={{ cursor: "pointer" }} onClick={() => setModal({ type: "strategy", st: r.st })}>
                            <td>
                              <span className="tag" style={{ background: CAT[r.st.cat].color, marginRight: 6 }}>{CAT[r.st.cat].label}</span>
                              {r.st.name}
                            </td>
                            <td className="mono" style={{ fontWeight: beat ? 700 : 400 }}>{Math.round(r.bt.final).toLocaleString()}</td>
                            <td className="mono" style={{ color: r.bt.cagr >= 0 ? "var(--up)" : "var(--dn)", fontWeight: beat ? 700 : 400 }}>
                              {r.bt.cagr >= 0 ? "+" : ""}{pct(r.bt.cagr)}
                            </td>
                            <td className="mono" style={{ color: "var(--dn)" }}>{pct(r.bt.maxDD)}</td>
                            <td className="mono" style={{ color: r.bt.n < 30 ? "var(--dn)" : "inherit" }}>{r.bt.n}</td>
                            <td className="mono">{pct(r.bt.winRate, 0)}</td>
                            <td className="mono">{r.bt.avgR >= 0 ? "+" : ""}{r.bt.avgR.toFixed(2)}</td>
                            <td className="mono">{isFinite(r.bt.pf) ? r.bt.pf.toFixed(2) : "—"}</td>
                            <td className="mono">{Math.round(r.bt.avgDays)}日</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="card" style={{ marginTop: 12 }}>
                  <div className="eyebrow">この表の読み方</div>
                  {(() => {
                    const beat = btResult.rows.filter((r) => r.bt.cagr > btResult.bm.cagr).length;
                    const thin = btResult.rows.filter((r) => r.bt.n < 30).length;
                    return (
                      <div className="act" style={{ margin: "9px 0 12px", borderColor: thin > btResult.rows.length / 2 ? "#A63A28" : "#1B3A5C" }}>
                        <b>この {btYears}年の集計では</b> — {btResult.rows.length}手法中 <b>{beat}手法</b>がベンチマークを超え、
                        <b>{thin}手法</b>が試行30件未満でした。
                        {thin > btResult.rows.length / 2 && (
                          <> 半数以上が件数不足です。<b>この期間の順位はほぼ偶然の産物</b>と考えてください。
                            期間を伸ばすとベンチマーク超えの手法数は必ず減ります。それは手法が劣化したのではなく、
                            短期間に紛れ込んでいた偽の勝者が消えただけです。</>
                        )}
                      </div>
                    );
                  })()}
                  <p className="sub" style={{ margin: 0 }}>
                    <b>件数が赤い手法（30件未満）の順位は無視してください。</b>
                    数回の当たりで上位に来ているだけで、次の5年で同じ結果になる保証はどこにもありません。<br /><br />
                    <b>年率より最大DDを先に見てください。</b> 年率20%でも途中で40%減ったなら、
                    多くの人はその底で降ります。降りたら年率20%は手に入りません。実際に持ち続けられる深さかどうかが先です。<br /><br />
                    <b>平均Rが正でも年率が低い手法があります。</b> それは1回あたりは勝っているが、
                    試行回数が足りず資金が働いていないということ。逆に平均Rが低くても回数が多ければ複利は効きます。
                  </p>
                </div>
              </>
            )}
          </>
        )}

        {/* ==================== 設定 ==================== */}
        {tab === "set" && (
          <>
            <h1 className="h1">設定</h1>

            <div className="card">
              <div className="eyebrow">運用資金(ポジションサイズ計算用)</div>
              <p className="sub" style={{ margin: "7px 0 9px" }}>
                登録銘柄カードの「推奨株数」の計算に使います。1トレードのリスクは資金の1%固定です。
              </p>
              <input type="number" value={capital} onChange={(e) => setCapital(Math.max(0, Number(e.target.value) || 0))}
                style={{ width: "100%", padding: 9, border: "1px solid var(--line)", borderRadius: 6, fontSize: 13 }} />
              <p className="gnote">現在: {(capital / 10000).toLocaleString()}万円 → 1トレードの許容損失 {(capital * 0.01 / 10000).toFixed(1)}万円</p>
            </div>

            <div className="card">
              <div className="eyebrow">Gemini 連携</div>
              <p className="sub" style={{ margin: "7px 0 9px" }}>
                銘柄詳細の調査ボタンを押すと、その銘柄用の調査プロンプトをコピーして、ここで指定した Gem を開きます。
                Gem の URL は Gemini で作成後、共有リンクを貼り付けてください。
              </p>
              <input value={gemUrl} onChange={(e) => setGemUrl(e.target.value)}
                style={{ width: "100%", padding: 9, border: "1px solid var(--line)", borderRadius: 6, fontSize: 12 }} />
              <p className="gnote">
                Gemini には「URL でプロンプトを自動投入する」公式の手段がありません。そのため、プロンプトを自動生成してクリップボードに入れ、
                Gem を開くところまでを担当します。貼り付けだけ手で行ってください。ここを自動化したように見せかけることはしません。
              </p>
            </div>

            <div className="card" style={{ padding: 0 }}>
              <div style={{ padding: "13px 13px 4px" }}>
                <div className="eyebrow">手法の表示</div>
                <p className="sub" style={{ margin: "6px 0 0" }}>
                  オフにした手法はダッシュボードから消えますが、記録は裏で取り続けます。見ないことと、測らないことは別です。
                </p>
              </div>
              {STRATEGIES.map((st) => (
                <div className="tog" key={st.id} onClick={() => setEnabled((e) => ({ ...e, [st.id]: !enabledMerged[st.id] }))}>
                  <div className="sw" data-on={enabledMerged[st.id] ? 1 : 0}><i /></div>
                  <span className="tag" style={{ background: CAT[st.cat].color }}>{CAT[st.cat].label}</span>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{st.name}</span>
                  <span style={{ fontSize: 11, color: "var(--grey-l)", marginLeft: "auto" }}>
                    {st.markets.join("/")}
                  </span>
                </div>
              ))}
            </div>

            <div className="card">
              <div className="eyebrow">実装しなかった手法</div>
              <p className="sub" style={{ margin: "7px 0 11px" }}>
                手法の数は多ければ良いというものではありません。以下は意図的に除外しています。
              </p>
              {EXCLUDED.map((e, i) => (
                <div key={i} style={{ padding: "9px 0", borderTop: i ? "1px solid var(--line2)" : 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700 }}>{e.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--grey)", marginTop: 3, lineHeight: 1.6 }}>{e.reason}</div>
                </div>
              ))}
            </div>

            <div className="card">
              <div className="eyebrow">この画面について</div>
              <p className="sub" style={{ margin: "7px 0 0" }}>
                StockScout はスクリーニング条件に合致した銘柄を機械的に抽出して表示するツールであり、投資助言ではありません。
                個人利用を前提としています。判断と執行はすべて利用者が行ってください。
              </p>
            </div>
          </>
        )}
      </div>

      {/* ==================== モーダル ==================== */}
      {modal && (
        <div className="modal" onClick={() => setModal(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <button className="x" onClick={() => setModal(null)}>×</button>

            {modal.type === "strategy" && (
              <>
                <span className="tag" style={{ background: CAT[modal.st.cat].color }}>{CAT[modal.st.cat].label}</span>
                <h2>{modal.st.name}</h2>
                <div className="eyebrow">{modal.st.subtitle} ・ {HORIZON[modal.st.horizon]} ・ {modal.st.markets.join(" / ")}</div>
                <p style={{ fontSize: 13.5, lineHeight: 1.75, margin: "13px 0 0", fontWeight: 600 }}>{modal.st.thesis}</p>
                <pre>{modal.st.detail}</pre>
                <div className="act" style={{ marginTop: 14 }}>
                  <b>手仕舞いルール</b> — {modal.st.exitRule}
                </div>
              </>
            )}

            {modal.type === "stock" && (
              <>
                <div className="eyebrow">{modal.s.market === "JP" ? "日本株" : "米国株"} ・ {modal.s.sector}</div>
                <h2 className="mono">{modal.s.code} <span style={{ fontFamily: "inherit" }}>{modal.s.name}</span></h2>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
                  <TrendMarks history={modal.s.history} />
                  {modal.s.market === "JP" && modal.s.earningsInDays != null && modal.s.earningsInDays <= 20 && (
                    <span className="pill" style={{ cursor: "default", color: modal.s.earningsInDays <= 7 ? "var(--dn)" : "var(--grey)", borderColor: modal.s.earningsInDays <= 7 ? "#E3C9C3" : "var(--line)" }}>
                      決算発表 推定{modal.s.earningsInDays}営業日後{modal.s.earningsInDays <= 7 ? " ⚠ またぎ注意" : ""}
                    </span>
                  )}
                  {modal.s.market === "JP" && modal.s.daysToRights != null && modal.s.daysToRights <= 45 && (
                    <span className="pill" style={{ cursor: "default" }}>
                      権利確定 推定{modal.s.daysToRights}営業日後{modal.s.hasYutai ? " ・優待あり" : ""}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 21, fontWeight: 800, marginTop: 5 }} className="mono">{fmtP(modal.s.price, modal.s.market)}</div>

                <div className="kv" style={{ marginTop: 15 }}>
                  <div><div className="k">PER</div><div className="v mono">{modal.s.per.toFixed(1)}</div></div>
                  <div><div className="k">PBR</div><div className="v mono">{modal.s.pbr.toFixed(2)}</div></div>
                  <div><div className="k">ROE</div><div className="v mono">{pct(modal.s.roe)}</div></div>
                  <div><div className="k">FCF利回り</div><div className="v mono">{pct(modal.s.fcfYield)}</div></div>
                  <div><div className="k">配当利回り</div><div className="v mono">{pct(modal.s.divYield)}</div></div>
                  <div><div className="k">Fスコア</div><div className="v mono">{modal.s.fscore}/9</div></div>
                  <div><div className="k">12-1モメンタム</div><div className="v mono">{pct(modal.s.mom12_1)}</div></div>
                  <div><div className="k">52週高値差</div><div className="v mono">{pct(modal.s.dist52w)}</div></div>
                </div>

                <div style={{ marginTop: 19 }}>
                  <div className="eyebrow">なぜ推薦されたか</div>
                  {modal.hits.length === 0 ? (
                    <p className="sub" style={{ marginTop: 7 }}>現時点でこの銘柄を推薦している手法はありません。</p>
                  ) : (
                    modal.hits.map(({ st, score }, i) => (
                      <div key={i} style={{ padding: "9px 0", borderTop: i ? "1px solid var(--line2)" : 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                          <span className="tag" style={{ background: CAT[st.cat].color }}>{CAT[st.cat].label}</span>
                          <b style={{ fontSize: 13 }}>{st.name}</b>
                          <span className="gauge" style={{ marginLeft: "auto" }}>
                            <i style={{ width: `${score * 100}%`, background: CAT[st.cat].color }} />
                          </span>
                          <span className="rsc mono">{score.toFixed(2)}</span>
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--grey)", marginTop: 4, lineHeight: 1.6 }}>{st.thesis}</div>
                      </div>
                    ))
                  )}
                </div>

                <button className="gbtn" onClick={() => copyPrompt(modal.s, modal.hits)}>
                  {copied ? "プロンプトをコピーしました — Gemini に貼り付けてください" : "Gemini でファンダメンタルを調べる"}
                </button>
                <p className="gnote">
                  この銘柄の指標と、推薦した手法の論拠を組み込んだ調査プロンプトをコピーして Gem を開きます。貼り付けは手動です。
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {/* ==================== 保有銘柄 登録/編集フォーム ==================== */}
      {pfForm && (
        <div className="modal" onClick={() => setPfForm(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <button className="x" onClick={() => setPfForm(null)}>×</button>
            <h2>{pfForm.mode === "new" ? "保有銘柄を登録" : "保有銘柄を編集"}</h2>
            <div className="eyebrow">取得単価を入れると、そこを基準に損切り水準と買い増し判定を行います</div>

            <div style={{ marginTop: 15 }}>
              <div className="mkt-toggle" style={{ background: "#EEF0EA", margin: "0 0 12px" }}>
                {["JP", "US"].map((m) => (
                  <button key={m} data-on={pfForm.market === m ? 1 : 0}
                    style={{ color: pfForm.market === m ? "#0E1419" : "#6B7580" }}
                    onClick={() => setPfForm((f) => ({ ...f, market: m, code: "" }))}>{m === "JP" ? "日本株" : "米国株"}</button>
                ))}
              </div>

              <label style={{ fontSize: 11, color: "var(--grey)", display: "block", marginBottom: 4 }}>銘柄コード</label>
              <input list="pf-codes" value={pfForm.code} placeholder={pfForm.market === "JP" ? "例: 7203" : "例: AAPL"}
                onChange={(e) => setPfForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                style={{ width: "100%", padding: 9, border: "1px solid var(--line)", borderRadius: 6, fontSize: 13, marginBottom: 11 }} />
              <datalist id="pf-codes">
                {snap.universe.filter((s) => s.market === pfForm.market).map((s) => (
                  <option key={s.code} value={s.code}>{s.name}</option>
                ))}
              </datalist>

              <div style={{ display: "flex", gap: 9 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, color: "var(--grey)", display: "block", marginBottom: 4 }}>取得単価</label>
                  <input type="number" value={pfForm.costBasis} onChange={(e) => setPfForm((f) => ({ ...f, costBasis: e.target.value }))}
                    style={{ width: "100%", padding: 9, border: "1px solid var(--line)", borderRadius: 6, fontSize: 13, marginBottom: 11 }} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, color: "var(--grey)", display: "block", marginBottom: 4 }}>株数</label>
                  <input type="number" value={pfForm.shares} onChange={(e) => setPfForm((f) => ({ ...f, shares: e.target.value }))}
                    style={{ width: "100%", padding: 9, border: "1px solid var(--line)", borderRadius: 6, fontSize: 13, marginBottom: 11 }} />
                </div>
              </div>

              <label style={{ fontSize: 11, color: "var(--grey)", display: "block", marginBottom: 4 }}>取得日</label>
              <input type="date" value={pfForm.date} onChange={(e) => setPfForm((f) => ({ ...f, date: e.target.value }))}
                style={{ width: "100%", padding: 9, border: "1px solid var(--line)", borderRadius: 6, fontSize: 13, marginBottom: 11 }} />

              <label style={{ fontSize: 11, color: "var(--grey)", display: "block", marginBottom: 4 }}>
                監視する手法(この基準で買い増し/売りを判定します)
              </label>
              <select value={pfForm.stId} onChange={(e) => setPfForm((f) => ({ ...f, stId: e.target.value }))}
                style={{ width: "100%", padding: 9, border: "1px solid var(--line)", borderRadius: 6, fontSize: 13, marginBottom: 6 }}>
                <option value="">自己管理(手法を割り当てない — 損切り監視のみ)</option>
                {STRATEGIES.filter((st) => st.markets.includes(pfForm.market)).map((st) => (
                  <option key={st.id} value={st.id}>{st.name}（{CAT[st.cat].label}）</option>
                ))}
              </select>
              <p className="gnote">
                手法を割り当てない場合、買い増しシグナルは出ません。仮説がない状態で「強気」と判定する根拠がないためです。
              </p>

              <button className="gbtn" disabled={!pfForm.code || !pfForm.costBasis || !pfForm.shares}
                onClick={() => {
                  const rec = {
                    id: pfForm.mode === "edit" ? pfForm.id : `pf_${Date.now()}`,
                    code: pfForm.code, market: pfForm.market,
                    costBasis: parseFloat(pfForm.costBasis), shares: parseFloat(pfForm.shares),
                    date: pfForm.date, stId: pfForm.stId || null,
                  };
                  setPortfolio((p) => pfForm.mode === "edit"
                    ? p.map((x) => (x.id === rec.id ? rec : x))
                    : [...p, rec]);
                  setPfForm(null);
                }}>
                {pfForm.mode === "new" ? "登録する" : "更新する"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== ナビ ==================== */}
      <div className="nav">
        {[["dash", "◎", "推薦"], ["watch", "▤", "登録銘柄"], ["pf", "◆", "保有"], ["demo", "▲", "デモ運用"], ["perf", "◫", "手法比較"], ["set", "⚙", "設定"]].map(([k, i, l]) => (
          <button key={k} data-on={tab === k ? 1 : 0} onClick={() => setTab(k)}>
            <b>{i}</b>{l}
          </button>
        ))}
      </div>
    </div>
  );
}
