// Fast iteration: one portrait page, menu + a mid-run frame. node tools/quick.mjs [steps]
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const STEPS = parseInt(process.argv[2] || '16', 10);
const MIME = { '.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.png':'image/png' };
const server = http.createServer((req,res)=>{ let p=decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html'; const fp=path.join(ROOT,p); if(!fp.startsWith(ROOT)||!fs.existsSync(fp)||fs.statSync(fp).isDirectory()){res.writeHead(404);res.end('nf');return;} res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'application/octet-stream'}); fs.createReadStream(fp).pipe(res); });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox'] });
const errs=[]; const p = await b.newPage({ viewport:{width:440,height:950}, deviceScaleFactor:2 });
p.on('pageerror', e=>errs.push('pageerror:'+e.message));
p.on('console', m=>{ if(m.type()==='error' && !/404/.test(m.text())) errs.push('console:'+m.text()); });
await p.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil:'load' });
await p.waitForFunction(()=>window.__SKYWARD__&&window.__SKYWARD__.postfx, null, {timeout:20000});
await sleep(900);
await p.screenshot({ path: path.join(OUT,'q_menu.png') });
await p.evaluate(()=>window.__SKYWARD__.startGame());
for (let i=0;i<STEPS;i++){
  await p.waitForFunction(()=>{const g=window.__SKYWARD__;return g.state!=='playing'||g.player.state==='idle';},null,{timeout:4000}).catch(()=>{});
  await p.evaluate(()=>{const g=window.__SKYWARD__; if(g.state!=='playing')return; const r=g.stairs.requiredDir(g.playerIndex); g.onAction(r===0?'right':'left');});
  await sleep(60);
}
await sleep(350);
await p.screenshot({ path: path.join(OUT,'q_play.png') });
console.log('quick shots done; errors:', errs.length?errs:'none');
await b.close(); server.close();
