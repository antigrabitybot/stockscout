/** Forward test: fixed-horizon signal quality + capital-constrained paper account. */
import { STRATEGIES, plan, featuresAt, BT } from "../logic.mjs";
const VERSION=2, CHECKPOINTS=[5,20,60,120], LIMIT=40;
const emptyPortfolio=(startedAt=null)=>({startedAt,initialCapital:BT.capital,cash:BT.capital,pending:[],open:[],closed:[],equityCurve:[],peak:BT.capital,maxDD:0});
function barOn(s,date){const index=s.history.findIndex(x=>x.date===date);return index<0?null:{bar:s.history[index],index};}
function strategyState(state,market,id){
  state.markets||={}; state.markets[market]||={lastProcessedAt:null,benchmark:{value:1,lastDate:null},strategies:{}};
  return state.markets[market].strategies[id]||=( {signals:[],portfolio:emptyPortfolio()} );
}
function migrate(state){
  if(state.version===VERSION)return;
  if(state.version!==1)throw new Error(`未対応の forwardTest version: ${state.version}`);
  for(const ms of Object.values(state.markets||{})){
    ms.benchmark||={value:1,lastDate:ms.lastProcessedAt||null};
    for(const ss of Object.values(ms.strategies||{})){
      const pending=ss.pending||[],open=ss.open||[],closed=ss.recentClosed||[];
      ss.signals=[...pending,...open,...closed].map(x=>({code:x.code,name:x.name,signalDate:x.signalDate,signalClose:x.entry||null,benchmarkEntry:ms.benchmark.value,latestDate:x.exitDate||x.entryDate||x.signalDate,latest:x.exit||x.entry||null,checkpoints:{},mfe:0,mae:0,migrated:true}));
      ss.legacy={pending,open,stats:ss.stats,recentClosed:closed};
      ss.portfolio=emptyPortfolio(ms.lastProcessedAt||state.startedAt);
      delete ss.pending;delete ss.open;delete ss.stats;delete ss.recentClosed;
    }
  }
  state.version=VERSION;state.migratedAt||=new Date().toISOString();
}
function hydrateLegacyAccounts(state){
  if(state.legacyHydrated)return;
  for(const ms of Object.values(state.markets||{}))for(const ss of Object.values(ms.strategies||{})){
    const pf=ss.portfolio||=emptyPortfolio(ms.lastProcessedAt||state.startedAt);
    if(!pf.open.length&&!pf.equityCurve.length&&ss.legacy){
      for(const old of (ss.legacy.open||[]).slice(0,BT.maxPos)){
        if(!(old.entry>0&&old.initialR>0))continue;
        let shares=Math.floor((BT.capital*BT.riskPct)/old.initialR);
        shares=Math.min(shares,Math.floor(pf.cash/(old.entry*(1+BT.cost/2))));
        if(shares<=0)continue;
        pf.cash-=shares*old.entry*(1+BT.cost/2);
        pf.open.push({...old,shares,last:old.entry,returnPct:0,currentR:-BT.cost,mfe:0,mae:0,path:[0]});
      }
      pf.pending=(ss.legacy.pending||[]).map(x=>({...x}));
    }
  }
  state.legacyHydrated=true;
}
function advanceBenchmark(ms,market,date,stocks){
  ms.benchmark||={value:1,lastDate:null};if(ms.benchmark.lastDate===date)return;
  const rs=[];for(const s of stocks){if(s.market!==market)continue;const f=barOn(s,date);const prev=f?.index>0?s.history[f.index-1].c:null;if(prev>0&&f.bar.c>0)rs.push(f.bar.c/prev-1);}
  ms.benchmark.value*=1+(rs.length?rs.reduce((a,b)=>a+b,0)/rs.length:0);ms.benchmark.lastDate=date;
}
function updateSignals(ss,date,byCode,bm){
  for(const x of ss.signals){const s=byCode.get(x.code),f=s&&barOn(s,date);if(!f||!(x.signalClose>0))continue;const start=s.history.findIndex(b=>b.date===x.signalDate);if(start<0||f.index<start)continue;
    const days=f.index-start;x.latestDate=date;x.latest=f.bar.c;x.elapsedDays=days;x.returnPct=f.bar.c/x.signalClose-1;x.mfe=Math.max(x.mfe||0,f.bar.h/x.signalClose-1);x.mae=Math.min(x.mae||0,f.bar.l/x.signalClose-1);x.path||=[];x.path.push(x.returnPct);if(x.path.length>60)x.path.shift();
    for(const n of CHECKPOINTS)if(days>=n&&x.checkpoints?.[n]==null){x.checkpoints||={};const br=x.benchmarkEntry>0?bm/x.benchmarkEntry-1:0;x.checkpoints[n]={returnPct:x.returnPct,benchmarkReturn:br,excessReturn:x.returnPct-br};}
  }
}
function equity(pf,date,byCode){return pf.cash+pf.open.reduce((sum,p)=>{const s=byCode.get(p.code),f=s&&barOn(s,date);return sum+(f?.bar.c||p.last||p.entry)*p.shares;},0);}
function close(pf,p,px,date,reason){pf.cash+=px*p.shares*(1-BT.cost/2);const pnl=(px-p.entry)*p.shares-p.entry*p.shares*BT.cost,r=pnl/(p.initialR*p.shares);pf.closed.push({...p,exitDate:date,exit:px,pnl,r,reason});if(pf.closed.length>LIMIT)pf.closed.shift();}

export function advanceForwardTestDay(state,market,date,stocks,strategies=STRATEGIES){
  state.version||=VERSION;state.markets||={};state.markets[market]||={lastProcessedAt:null,benchmark:{value:1,lastDate:null},strategies:{}};const ms=state.markets[market];advanceBenchmark(ms,market,date,stocks);const bm=ms.benchmark.value,byCode=new Map(stocks.map(s=>[s.code,s]));
  for(const st of strategies.filter(s=>s.markets.includes(market))){const ss=strategyState(state,market,st.id),pf=ss.portfolio||=emptyPortfolio(date);pf.startedAt||=date;updateSignals(ss,date,byCode,bm);
    const slots=Math.max(0,BT.maxPos-pf.open.length),pending=[...(pf.pending||[])].sort((a,b)=>b.score-a.score);
    for(const item of pending.slice(0,slots)){const s=byCode.get(item.code),f=s&&barOn(s,date);if(!f||item.signalDate>=date)continue;const entry=f.bar.o,p=plan({...s,price:entry},st),initialR=entry-p.stop;if(!(entry>0&&initialR>0))continue;let shares=Math.floor((equity(pf,date,byCode)*BT.riskPct)/initialR);shares=Math.min(shares,Math.floor(pf.cash/(entry*(1+BT.cost/2))));if(shares<=0)continue;pf.cash-=shares*entry*(1+BT.cost/2);pf.open.push({code:s.code,name:s.name,signalDate:item.signalDate,entryDate:date,entry,stop:p.stop,target:p.target,initialR,shares,days:0,last:entry,currentR:-BT.cost,returnPct:-BT.cost,mfe:0,mae:0,path:[0]});}
    pf.pending=[];const survivors=[];
    for(const p of pf.open){const s=byCode.get(p.code),f=s&&barOn(s,date);if(!f){survivors.push(p);continue;}const {bar,index}=f;if(date!==p.entryDate)p.days++;p.last=bar.c;p.returnPct=bar.c/p.entry-1;p.currentR=(bar.c-p.entry-p.entry*BT.cost)/p.initialR;p.mfe=Math.max(p.mfe||0,bar.h/p.entry-1);p.mae=Math.min(p.mae||0,bar.l/p.entry-1);p.path||=[];p.path.push(p.returnPct);if(p.path.length>60)p.path.shift();let reason=null,px=null;if(bar.l<=p.stop){reason="損切り";px=Math.min(p.stop,bar.o);}else if(bar.h>=p.target){reason="利確";px=p.target;}else{const n=st.horizon==="swing"?10:st.horizon==="mid"?50:200;if(p.days>n&&index+1>=n){const w=s.history.slice(index-n+1,index+1),ma=w.reduce((a,x)=>a+x.c,0)/w.length;if(bar.c<ma){reason="トレンド転換";px=bar.c;}}if(!reason&&bar.c>p.entry+p.initialR&&p.stop<p.entry)p.stop=p.entry;}if(reason)close(pf,p,px,date,reason);else survivors.push(p);}
    pf.open=survivors;const eq=equity(pf,date,byCode);pf.peak=Math.max(pf.peak||BT.capital,eq);pf.maxDD=Math.min(pf.maxDD||0,eq/pf.peak-1);pf.equityCurve.push({date,equity:eq});if(pf.equityCurve.length>520)pf.equityCurve.shift();
    const candidates=[];for(const s of stocks){if(s.market!==market)continue;const f=barOn(s,date);if(!f)continue;let view=featuresAt(s,f.index);if(!view&&f.index===s.history.length-1)view=s;if(!view)continue;let score=null;try{score=st.score(view);}catch{}if(score!=null&&Number.isFinite(score)&&score>0)candidates.push({code:s.code,name:s.name,score,close:f.bar.c});}candidates.sort((a,b)=>b.score-a.score);
    for(const x of candidates.slice(0,8))if(!ss.signals.some(s=>s.code===x.code&&s.signalDate===date))ss.signals.push({code:x.code,name:x.name,signalDate:date,signalClose:x.close,benchmarkEntry:bm,latestDate:date,latest:x.close,elapsedDays:0,returnPct:0,checkpoints:{},mfe:0,mae:0,path:[0]});
    const active=new Set(pf.open.map(x=>x.code));pf.pending=candidates.slice(0,8).filter(x=>!active.has(x.code)).map(x=>({...x,signalDate:date}));
  }ms.lastProcessedAt=date;
}
function marketDates(universe,market){const dates=new Set();for(const s of universe)if(s.market===market)for(const b of s.history)if(b.date)dates.add(b.date);return [...dates].sort();}
export function updateForwardTests(store,universe){const state=store.forwardTest||={version:VERSION,startedAt:null,markets:{}};migrate(state);hydrateLegacyAccounts(state);for(const market of ["JP","US"]){const dates=marketDates(universe,market);if(!dates.length)continue;const latest=dates.at(-1),last=state.markets?.[market]?.lastProcessedAt,toProcess=last?dates.filter(d=>d>last):[latest];for(const date of toProcess)advanceForwardTestDay(state,market,date,universe);state.startedAt||=toProcess[0]||latest;}return summarizeForwardTests(state);}
function portfolioMetrics(pf){const curve=pf.equityCurve||[],eq=curve.at(-1)?.equity??pf.initialCapital,rs=curve.slice(1).map((x,i)=>x.equity/curve[i].equity-1).filter(Number.isFinite),mean=rs.length?rs.reduce((a,b)=>a+b,0)/rs.length:0,v=rs.length>1?rs.reduce((a,x)=>a+(x-mean)**2,0)/(rs.length-1):0,closed=pf.closed||[],years=Math.max(curve.length/252,1/252);return{startedAt:pf.startedAt,initialCapital:pf.initialCapital,equity:eq,cash:pf.cash,totalReturn:eq/pf.initialCapital-1,cagr:Math.pow(eq/pf.initialCapital,1/years)-1,maxDD:pf.maxDD||0,sharpe:v>0?mean/Math.sqrt(v)*Math.sqrt(252):null,activeCount:pf.open.length,pendingCount:pf.pending.length,closedCount:closed.length,winRate:closed.length?closed.filter(x=>x.pnl>0).length/closed.length:null,tracked:[...pf.open.map(x=>({status:"open",...x})),...pf.pending.map(x=>({status:"pending",...x}))],recentClosed:closed.slice(-15).reverse().map(x=>({status:"closed",...x})),equityCurve:curve.slice(-260)};}
function signalMetrics(signals){const checkpoints={};for(const n of CHECKPOINTS){const rows=signals.map(s=>s.checkpoints?.[n]).filter(Boolean);checkpoints[n]={count:rows.length,avgReturn:rows.length?rows.reduce((a,x)=>a+x.returnPct,0)/rows.length:null,avgExcess:rows.length?rows.reduce((a,x)=>a+x.excessReturn,0)/rows.length:null,winRate:rows.length?rows.filter(x=>x.excessReturn>0).length/rows.length:null};}return{totalSignals:signals.length,checkpoints,avgMfe:signals.length?signals.reduce((a,x)=>a+(x.mfe||0),0)/signals.length:null,avgMae:signals.length?signals.reduce((a,x)=>a+(x.mae||0),0)/signals.length:null,recent:signals.slice(-20).reverse()};}
export function summarizeForwardTests(state){const out={version:VERSION,computedAt:new Date().toISOString().slice(0,10),startedAt:state.startedAt,rules:{capital:BT.capital,riskPct:BT.riskPct,maxPositions:BT.maxPos,roundTripCost:BT.cost,checkpoints:CHECKPOINTS},markets:{}};for(const [market,ms]of Object.entries(state.markets||{})){const strategies={};for(const [id,ss]of Object.entries(ms.strategies||{}))strategies[id]={signalQuality:signalMetrics(ss.signals||[]),portfolio:portfolioMetrics(ss.portfolio||emptyPortfolio())};out.markets[market]={asof:ms.lastProcessedAt,benchmark:ms.benchmark?.value,strategies};}return out;}
