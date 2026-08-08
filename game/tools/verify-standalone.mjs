import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const errs=[]; const p = await b.newPage({ viewport:{width:440,height:950}, deviceScaleFactor:2 });
p.on('pageerror', e=>errs.push('pageerror:'+e.message));
p.on('console', m=>{ if(m.type()==='error') errs.push('console:'+m.text()); });
await p.goto('file://'+path.join(ROOT,'index-standalone.html'), { waitUntil:'load' });
await p.waitForFunction(()=>window.__SKYWARD__&&window.__SKYWARD__.postfx, null, {timeout:20000});
await new Promise(r=>setTimeout(r,800));
await p.evaluate(()=>window.__SKYWARD__.startGame());
for(let i=0;i<12;i++){ await p.waitForFunction(()=>{const g=window.__SKYWARD__;return g.state!=='playing'||g.player.state==='idle';},null,{timeout:4000}).catch(()=>{}); await p.evaluate(()=>{const g=window.__SKYWARD__;if(g.state!=='playing')return;const r=g.stairs.requiredDir(g.playerIndex);g.onAction(r===0?'right':'left');}); await new Promise(r=>setTimeout(r,60)); }
await new Promise(r=>setTimeout(r,300));
const score = await p.evaluate(()=>window.__SKYWARD__.score);
await p.screenshot({ path: path.join(ROOT,'shots/standalone_check.png') });
console.log('standalone OK — score reached', score, '| errors:', errs.length?errs:'none');
await b.close();
