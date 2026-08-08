import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const ROOT='/home/user/IPO-MARKET-REVIEW/game';
const MIME={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
const server=http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';const fp=path.join(ROOT,p);if(!fs.existsSync(fp)||fs.statSync(fp).isDirectory()){res.writeHead(404);res.end('nf');return;}res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'application/octet-stream'});fs.createReadStream(fp).pipe(res);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox']});
const errs=[];const p=await b.newPage();
p.on('pageerror',e=>errs.push('PAGEERR:'+e.message));
p.on('console',m=>{if(m.type()==='error'&&!/404/.test(m.text()))errs.push('con:'+m.text());});
await p.goto(`http://127.0.0.1:${port}/index.html`,{waitUntil:'load'});
await p.waitForFunction(()=>window.__SKYWARD__&&window.__SKYWARD__.postfx,null,{timeout:20000});
await new Promise(r=>setTimeout(r,3500)); // allow _loadBuiltinSong to decode
const st=await p.evaluate(()=>({hasSong:window.__SKYWARD__.audio.hasSong, bpm:window.__SKYWARD__.audio.bpm, off:window.__SKYWARD__.audio.firstBeatOffset, bpm:window.__SKYWARD__.audio.bpm, note:document.getElementById('songNote').textContent}));
console.log('BOOT:',JSON.stringify(st),'errors:',errs.length?errs:'none');
await b.close();server.close();
