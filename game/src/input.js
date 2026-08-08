// Unified Pointer-event input. Using pointerdown (instead of touchstart + mousedown)
// eliminates the classic double-fire where one touch also emits a synthetic mouse
// event. A short debounce additionally collapses any residual duplicate and any
// near-simultaneous two-finger tap into a single action, so "left+right at once
// then it stops" can't happen. Emits 'left' | 'right'.
export class Input {
  constructor(el, onAction) {
    this.onAction = onAction;
    this.enabled = false;
    this.last = 0;
    this.DEBOUNCE = 32;           // ms — kills simultaneous dupes but never eats fast taps

    const fire = (clientX) => {
      const now = performance.now();
      if (now - this.last < this.DEBOUNCE) return;   // ignore duplicate / simultaneous
      this.last = now;
      this.onAction(clientX < window.innerWidth / 2 ? 'left' : 'right');
    };

    this._pointer = (e) => {
      if (!this.enabled) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return; // primary click only
      fire(e.clientX);
      e.preventDefault();
    };
    this._key = (e) => {
      if (!this.enabled || e.repeat) return;
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') fire(0);
      else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') fire(window.innerWidth);
    };

    // pointerdown covers mouse, touch and pen with one code path
    el.addEventListener('pointerdown', this._pointer, { passive: false });
    window.addEventListener('keydown', this._key);
  }
  enable() { this.enabled = true; this.last = 0; }
  disable() { this.enabled = false; }
}
