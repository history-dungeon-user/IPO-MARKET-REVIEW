// Two-zone touch (left half / right half) + keyboard. Emits 'left' | 'right'.
export class Input {
  constructor(el, onAction) {
    this.onAction = onAction;
    this.enabled = false;

    const zone = (clientX) => (clientX < window.innerWidth / 2 ? 'left' : 'right');

    this._touch = (e) => {
      if (!this.enabled) return;
      // fire once per new touch point for rapid tapping
      for (const t of e.changedTouches) {
        this.onAction(zone(t.clientX));
      }
      e.preventDefault();
    };
    this._mouse = (e) => {
      if (!this.enabled) return;
      this.onAction(zone(e.clientX));
    };
    this._key = (e) => {
      if (!this.enabled) return;
      if (e.repeat) return;
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') this.onAction('left');
      else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') this.onAction('right');
    };

    el.addEventListener('touchstart', this._touch, { passive: false });
    el.addEventListener('mousedown', this._mouse);
    window.addEventListener('keydown', this._key);
  }
  enable() { this.enabled = true; }
  disable() { this.enabled = false; }
}
