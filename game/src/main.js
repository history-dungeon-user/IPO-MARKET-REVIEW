import { Game } from './game.js';

const mount = document.getElementById('app');
let game;
try {
  game = new Game(mount);
} catch (err) {
  console.error('Failed to start SKYWARD:', err);
  document.getElementById('loader').innerHTML =
    '<div style="color:#fff4e0;font:600 15px system-ui;text-align:center;padding:24px">WebGL init failed.<br>' +
    (err && err.message ? err.message : '') + '</div>';
  throw err;
}

// expose for the screenshot / test harness
window.__SKYWARD__ = game;

const clock = { last: performance.now() };
let raf;
function frame(now) {
  const dt = Math.min(0.05, (now - clock.last) / 1000) || 0.016;
  clock.last = now;
  game.update(dt);
  game.render(dt);
  raf = requestAnimationFrame(frame);
}

// hide loader on the first rendered frame
requestAnimationFrame((t) => {
  clock.last = t;
  game.update(0.016);
  game.render(0.016);
  game.ui.hideLoader();
  raf = requestAnimationFrame(frame);
});

// pause the day-cycle audio when tab hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (game.audio) game.audio.setPad(false); }
  else if (game.state === 'playing' && game.audio) game.audio.setPad(true);
});
