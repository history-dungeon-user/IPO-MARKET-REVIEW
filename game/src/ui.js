// Thin wrapper over the DOM HUD & overlays.
const $ = (id) => document.getElementById(id);

export class UI {
  constructor() {
    this.hud = $('hud');
    this.score = $('score');
    this.best = $('best');
    this.stamina = $('stamina');
    this.staminaFill = $('staminaFill');
    this.combo = $('combo');
    this.flash = $('flash');
    this.start = $('startScreen');
    this.over = $('overScreen');
    this.finalScore = $('finalScore');
    this.finalBest = $('finalBest');
    this.newBest = $('newBest');
    this.touchzones = $('touchzones');
    this.loader = $('loader');
    this._lastScore = -1;
  }

  hideLoader() { this.loader.classList.add('hidden'); }

  showStart() {
    this.start.classList.remove('hidden');
    this.over.classList.add('hidden');
    this.hud.classList.remove('playing');
  }
  showPlaying() {
    this.start.classList.add('hidden');
    this.over.classList.add('hidden');
    this.hud.classList.add('playing');
    this.touchzones.classList.add('hint');
  }
  hideHint() { this.touchzones.classList.remove('hint'); }

  showOver(score, best, isNew) {
    this.finalScore.textContent = score;
    this.finalBest.textContent = best;
    this.newBest.classList.toggle('show', isNew);
    this.over.classList.remove('hidden');
    this.hud.classList.remove('playing');
  }

  setBest(b) { this.best.textContent = b; }

  setScore(s) {
    if (s === this._lastScore) return;
    this._lastScore = s;
    this.score.textContent = s;
    this.score.classList.remove('pop');
    void this.score.offsetWidth;
    this.score.classList.add('pop');
  }

  setStamina(frac) {
    const f = Math.max(0, Math.min(1, frac));
    this.staminaFill.style.transform = `scaleX(${f})`;
    this.stamina.classList.toggle('low', f < 0.28);
  }

  showCombo(text) {
    this.combo.textContent = text;
    this.combo.classList.remove('show');
    void this.combo.offsetWidth;
    this.combo.classList.add('show');
  }

  doFlash(alpha = 0.5, ms = 90) {
    this.flash.style.transition = 'none';
    this.flash.style.opacity = alpha;
    requestAnimationFrame(() => {
      this.flash.style.transition = `opacity ${ms}ms ease-out`;
      this.flash.style.opacity = 0;
    });
  }
}
