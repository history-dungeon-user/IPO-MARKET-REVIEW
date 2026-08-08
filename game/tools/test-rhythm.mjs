// Verify continuous-song rhythm mode: hasSong, continuous playback advances the
// beat clock (beatCount grows over real time), grid aligned, no slicing per tap.
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html','.js':'text/javascript','.json':'application/json' };
const server = http.createServer((req,res)=>{ let p=decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html'; const fp=path.join(ROOT,p); if(!fs.existsSync(fp)||fs.statSync(fp).isDirectory()){res.writeHead(404);res.end('nf');return;} res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'application/octet-stream'}); fs.createReadStream(fp).pipe(res); });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--autoplay-policy=no-user-gesture-required'] });
const errs=[]; const p = await b.newPage();
p.on('pageerror', e=>errs.push('PAGEERR:'+e.message));
p.on('console', m=>{ if(m.type()==='error' && !/404/.test(m.text())) errs.push('con:'+m.text()); });
await p.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil:'load' });
await p.waitForFunction(()=>window.__SKYWARD__&&window.__SKYWARD__.postfx, null, {timeout:20000});
const setup = await p.evaluate(async () => {
  const sr=22050, dur=6, n=sr*dur; const buf=new ArrayBuffer(44+n*2); const dv=new DataView(buf);
  const ws=(o,s)=>{for(let i=0;i<s.length;i++)dv.setUint8(o+i,s.charCodeAt(i));};
  ws(0,'RIFF');dv.setUint32(4,36+n*2,true);ws(8,'WAVE');ws(12,'fmt ');dv.setUint32(16,16,true);
  dv.setUint16(20,1,true);dv.setUint16(22,1,true);dv.setUint32(24,sr,true);dv.setUint32(28,sr*2,true);
  dv.setUint16(32,2,true);dv.setUint16(34,16,true);ws(36,'data');dv.setUint32(40,n*2,true);
  for(let i=0;i<n;i++){ const t=i/sr; const beat=(t%0.5)<0.06?1:0; const env=beat*Math.exp(-((t%0.5))*30);
    dv.setInt16(44+i*2,(Math.sin(t*220*2*Math.PI)*env)*16000,true); }
  const g=window.__SKYWARD__;
  g.audio.init(); g.audio.resume();
  const bpm=await g.audio.loadUserSong(buf);
  g.audio.setPad(true);   // continuous playback should start
  return { bpm, hasSong:g.audio.hasSong, tmLen:(g.audio.turnMap||[]).length, beat0:g.audio.beatCount() };
});
await new Promise(r=>setTimeout(r,1200));   // let the transport clock advance ~2 beats @120bpm
const after = await p.evaluate(()=>({ beat1:window.__SKYWARD__.audio.beatCount(), nbe:typeof window.__SKYWARD__.audio.nearestBeatError() }));
console.log('RHYTHM:', JSON.stringify({...setup, ...after, clockAdvanced: after.beat1>setup.beat0}), '| errors:', errs.length?errs:'none');
await b.close(); server.close();
