import React, { useEffect, useState } from 'react';

const yen = value => Number(value).toLocaleString('ja-JP', {maximumFractionDigits: 2});
const percent = value => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;

function ForecastChart({row}) {
  const points = [{day: 0, price: row.base, low: row.base, high: row.base}, ...row.path];
  const min = Math.min(...points.map(p => p.low));
  const max = Math.max(...points.map(p => p.high));
  const span = max - min || 1;
  const x = day => 70 + day / 20 * 510;
  const y = value => 185 - (value - min) / span * 155;
  const line = (data, key) => data.map(p => `${x(p.day)},${y(p[key])}`).join(' ');
  return <svg viewBox="0 0 620 230" role="img" aria-label={`${row.name}の20営業日先までの予測。実線は予測値、帯は10〜90分位点。`} style={{width:'100%', height:'auto'}}>
    {[min, (min + max) / 2, max].map((value, i) => <g key={i}>
      <line x1="70" x2="580" y1={y(value)} y2={y(value)} stroke="#ddd"/>
      <text x="62" y={y(value) + 4} textAnchor="end" fontSize="11" fill="#667">{yen(value)}</text>
    </g>)}
    <polygon points={`${line(points, 'low')} ${line([...points].reverse(), 'high')}`} fill="#2e6e6225"/>
    <line x1="70" x2="580" y1={y(row.base)} y2={y(row.base)} stroke="#889" strokeDasharray="4 4"/>
    <polyline points={line(points, 'price')} fill="none" stroke="#2e6e62" strokeWidth="2.5"/>
    {[0, 5, 10, 20].map(day => <text key={day} x={x(day)} y="214" textAnchor="middle" fontSize="12" fill="#667">{day === 0 ? '基準日' : `${day}営業日先`}</text>)}
  </svg>;
}

export default function ForecastPage({universe, asof}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('^N225');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    fetch('/data/forecasts.json', {signal: controller.signal}).then(r => {
      if (!r.ok) throw new Error('unavailable');
      return r.json();
    }).then(d => {
      if (!Array.isArray(d.rows)) throw new Error('invalid');
      setData(d);
    }).catch(e => {if (e.name !== 'AbortError') setError(true);});
    return () => controller.abort();
  }, [reload]);
  const choices = new Map([['^N225', {code:'^N225', name:'日経平均'}]]);
  for (const s of universe.filter(s => s.market === 'JP')) choices.set(s.code, s);
  for (const s of data?.rows || []) choices.set(s.code, s);
  const needle = query.trim().normalize('NFKC').toLowerCase();
  const matches = [...choices.values()].filter(s => `${s.code} ${s.name}`.normalize('NFKC').toLowerCase().includes(needle));
  const row = data?.rows.find(s => s.code === selected);
  const current = choices.get(selected);
  return <>
    <h1 className="h1">株価予測</h1>
    <p className="sub">日経平均と収録日本株の終値から、1・5・20営業日先を予測します。引け後の日次更新です。</p>
    <div className="card" style={{padding:16, marginBottom:16}}>
      <button className="pill" onClick={() => {setSelected('^N225'); setQuery('');}}>日経平均を見る</button>
      <label htmlFor="forecast-search" style={{display:'block', margin:'12px 0 6px'}}>銘柄名・証券コードで検索</label>
      <input id="forecast-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="例：トヨタ、7203" style={{width:'100%', boxSizing:'border-box', padding:12, fontSize:16, border:'1px solid #ccc', borderRadius:8}}/>
      {needle && <div aria-live="polite" style={{marginTop:8}}>
        <p className="sub">{matches.length}件{matches.length > 30 ? '（先頭30件を表示）' : ''}</p>
        {matches.slice(0,30).map(s => <button key={s.code} className="pill" data-on={s.code === selected ? 1 : 0} onClick={() => setSelected(s.code)}>{s.name} · {s.code}</button>)}
        {!matches.length && <p>収録銘柄に該当がありません。別の名前・コードで検索してください。</p>}
      </div>}
    </div>
    <div className="card" style={{padding:16}}>
      <div className="eyebrow">TIMESFM 2.5 · 予測</div>
      <h2>{current?.name || selected} <small style={{fontSize:12}}>{selected}</small></h2>
      {error ? <div role="alert"><p>予測データを読み込めません。初回生成前、または更新・通信に失敗しています。</p><button className="pill" onClick={() => setReload(x => x + 1)}>再読み込み</button></div>
        : !data ? <p role="status">予測を読み込んでいます…</p>
        : !row || row.status !== 'ok' ? <p role="status">{row?.reason || 'この銘柄の予測はまだ生成されていません。'}</p>
        : <>
          <p className="sub">基準日 {row.asof} · 終値 {yen(row.base)}円 · {row.source}</p>
          {(row.asof < asof || Date.now() - Date.parse(row.asof + 'T00:00:00+09:00') > 5 * 86400000) && <div className="warn">基準日が最新ではない可能性があります。古い予測を今日の予測として使用しないでください。</div>}
          <div className="perfgrid">{[1,5,20].map(day => {
            const p = row.path.find(p => p.day === day);
            return p && <div className="perfkpi" key={day}>
              <div className="k">{day}営業日先</div>
              <div className="v mono">{yen(p.price)}円</div>
              <p style={{color:p.return >= 0 ? '#2e6e62' : '#a63a28'}}>{percent(p.return)} · {p.return > 0 ? '上昇予測' : p.return < 0 ? '下落予測' : '横ばい'}</p>
              <small>予測レンジ {yen(p.low)}〜{yen(p.high)}円</small>
            </div>;
          })}</div>
          <ForecastChart row={row}/>
          <p className="sub">帯はモデルの10〜90分位点です。日本株で80%当たると検証された区間ではありません。株価予測は売買の推奨ではなく、方向的中率・利益は未検証です。</p>
        </>}
      {data && <p className="sub">生成日時：{new Date(data.generatedAt).toLocaleString('ja-JP', {timeZone:'Asia/Tokyo'})} JST</p>}
    </div>
  </>;
}
