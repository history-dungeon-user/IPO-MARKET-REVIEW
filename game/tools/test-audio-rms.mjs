// Measure actual audio output: is the SONG producing sound (not just the pad)?
// Taps an AnalyserNode on the master bus and reports RMS with the song playing.
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
await p.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil:'load' });
await p.waitForFunction(()=>window.__SKYWARD__&&window.__SKYWARD__.postfx, null, {timeout:20000});
await new Promise(r=>setTimeout(r,3500)); // let the built-in song decode
const info = await p.evaluate(async () => {
  const g = window.__SKYWARD__;
  const a = g.audio;
  // buffer RMS (is the decoded song non-silent?)
  let bufRms = null;
  if (a.songBuffer) { const d=a.songBuffer.getChannelData(0); let s=0; const N=Math.min(d.length,200000); for(let i=0;i<N;i++)s+=d[i]*d[i]; bufRms=Math.sqrt(s/N); }
  // tap the master bus with an analyser
  const an = a.ctx.createAnalyser(); an.fftSize = 2048; a.master.connect(an);
  const buf = new Float32Array(an.fftSize);
  a.resume(); g.startGame();               // starts the song
  const samples=[];
  for (let k=0;k<20;k++){ await new Promise(z=>setTimeout(z,100)); an.getFloatTimeDomainData(buf); let s=0; for(let i=0;i<buf.length;i++)s+=buf[i]*buf[i]; samples.push(Math.sqrt(s/buf.length)); }
  const outRms = samples.reduce((x,y)=>x+y,0)/samples.length;
  return { hasSong:a.hasSong, padGain: a.padGain? a.padGain.gain.value : null, songGain: a.songGain? a.songGain.gain.value : null, bufRms:+(bufRms||0).toFixed(4), outRms:+outRms.toFixed(4), maxOut:+Math.max(...samples).toFixed(4) };
});
console.log('AUDIO_RMS:', JSON.stringify(info), '| errors:', errs.length?errs:'none');
await b.close(); server.close();
