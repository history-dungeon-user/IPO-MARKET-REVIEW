// Climb deep (default 260 steps) to reproduce the freeze. Reports any page/
// console error and detects a stall (score stops advancing) with the state.
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = parseInt(process.argv[2] || '260', 10);
const MIME = { '.html':'text/html','.js':'text/javascript','.json':'application/json' };
const server = http.createServer((req,res)=>{ let p=decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html'; const fp=path.join(ROOT,p); if(!fs.existsSync(fp)||fs.statSync(fp).isDirectory()){res.writeHead(404);res.end('nf');return;} res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'application/octet-stream'}); fs.createReadStream(fp).pipe(res); });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const errs=[]; const p = await b.newPage({ viewport:{width:440,height:950}, deviceScaleFactor:1 });
p.on('pageerror', e=>errs.push('PAGEERROR: '+e.message+' @ '+(e.stack||'').split('\n')[1]));
p.on('console', m=>{ if(m.type()==='error' && !/404/.test(m.text())) errs.push('console: '+m.text()); });
await p.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil:'load' });
await p.waitForFunction(()=>window.__SKYWARD__&&window.__SKYWARD__.postfx, null, {timeout:20000});
await p.evaluate(()=>window.__SKYWARD__.startGame());

let last=-1, stallCount=0, stalledAt=null;
for (let i=0;i<TARGET*3 && !stalledAt;i++){
  await p.waitForFunction(()=>{const g=window.__SKYWARD__;return g.state!=='playing'||g.player.state==='idle';},null,{timeout:3000}).catch(()=>{});
  const st = await p.evaluate(()=>{
    const g=window.__SKYWARD__;
    if(g.state==='playing'){ const r=g.stairs.requiredDir(g.playerIndex); g.onAction(g.buttonForDir(r)); }
    return { score:g.score, state:g.state, pstate:g.player.state, idx:g.playerIndex,
             req:g.stairs.requiredDir(g.playerIndex), aheadFront: g.stairs.steps.length? g.stairs.steps[g.stairs.steps.length-1].index: null };
  });
  if (st.state!=='playing'){ stalledAt={reason:'gameover/other', ...st}; break; }
  if (st.score===last){ stallCount++; if(stallCount>6){ stalledAt={reason:'STALL (score frozen)', ...st}; break; } }
  else { stallCount=0; last=st.score; }
  if (st.score>=TARGET) break;
  await new Promise(z=>setTimeout(z,40));
}
const final = await p.evaluate(()=>({score:window.__SKYWARD__.score, state:window.__SKYWARD__.state, pstate:window.__SKYWARD__.player.state}));
console.log('STRESS result — final:', JSON.stringify(final), 'stalledAt:', JSON.stringify(stalledAt));
console.log('errors:', errs.length?errs:'none');
await b.close(); server.close();
