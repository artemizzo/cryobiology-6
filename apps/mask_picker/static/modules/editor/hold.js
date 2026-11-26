/**
 * holdMixin — затиснуті Q / W (та Shift+Q / Shift+W) гортають кадри з прискоренням.
 *
 * Коротке натискання — як раніше: один крок (gotoPhoto / _bgPeekStep). Якщо клавішу
 * тримати довше HOLD_DELAY, починається «перемотування»: спершу повільно, далі швидше
 * (інтервал множиться на ACCEL до MIN_INTERVAL). Системний автоповтор клавіш ігнорується —
 * темп задає власний таймер.
 *
 * Q / W під час перемотування НЕ відкривають кожне фото: кадри показуються з пам'яті так
 * само, як при протягуванні повзунка (timeline._previewFrame; зображення наперед вантажить
 * timeline.js, а на кілька кадрів уперед — ця перемотка). Відпустив клавішу — відкривається
 * фото, на якому зупинився (gotoPhoto: поточне зберігається, зум лишається).
 * Shift+Q / Shift+W — те саме для фону сусіднього кадру (полігони лишаються свої).
 */
import { filtered, state as appState } from "../state.js";
import { loadFrameImage } from "./timeline.js";

const HOLD_DELAY = 380;     // мс — після цього тримання вважається перемоткою
const START_INTERVAL = 240; // мс між кадрами на початку
const ACCEL = 0.86;         // кожен крок швидший
const MIN_INTERVAL = 35;    // мс — найвища швидкість (~28 кадрів/с)
const PREFETCH = 6;         // кадрів наперед у напрямку перемотки

export const holdMixin = {
  // keydown Q/W (без автоповтору). mode: "nav" (Q/W) або "peek" (Shift+Q/W).
  _holdStart(code, dir, mode) {
    this._holdStop(false);
    if (mode === "peek") this._bgPeekStep(dir);
    else this.gotoPhoto(dir);
    const h = { code, dir, mode, interval: START_INTERVAL, target: null };
    this._hold = h;
    h.timer = setTimeout(() => this._holdTick(h), HOLD_DELAY);
  },

  _holdTick(h) {
    if (this._hold !== h || !this.state.open) return;
    if (h.mode === "peek") {
      this._bgPeekStep(h.dir);
    } else {
      const list = filtered();
      if (h.target === null) h.target = this._navTarget ?? appState.idx;
      const next = h.target + h.dir;
      if (next < 0 || next >= list.length) { h.timer = setTimeout(() => this._holdTick(h), h.interval); return; }
      h.target = next;
      const stem = list[next].stem;
      this._previewFrame(stem, null, `${next + 1} / ${list.length}`);
      // бігунок повзунка в шапці — теж на цей кадр (якщо він із тієї самої серії)
      this._scrubIdx = this._tl ? this._tl.frames.findIndex((f) => f.stem === stem) : -1;
      if (this._scrubIdx < 0) this._scrubIdx = null;
      for (let k = 1; k <= PREFETCH; k++) {          // підвантажити кадри наперед
        const it = list[next + k * h.dir];
        if (it) loadFrameImage(it.stem).catch(() => {});
      }
      if (this._timelineDraw) this._timelineDraw();
    }
    h.interval = Math.max(MIN_INTERVAL, h.interval * ACCEL);
    h.timer = setTimeout(() => this._holdTick(h), h.interval);
  },

  // keyup Q/W (або втрата фокусу). go=true — відкрити кадр, на якому зупинилась перемотка.
  _holdStop(go = true) {
    const h = this._hold;
    if (!h) return;
    this._hold = null;
    clearTimeout(h.timer);
    if (!go || h.mode !== "nav" || h.target === null) return;
    const from = this._navTarget ?? appState.idx;
    if (h.target !== from) {
      this.gotoPhoto(h.target - from);     // прев'ю лишається, поки кадр відкривається
    } else if (this._scrubClear) {
      this._scrubClear();
      this._updateTitle();
    }
  },

  _holdBindBlur() {
    if (this._holdBlurBound) return;
    this._holdBlurBound = true;
    window.addEventListener("blur", () => this._holdStop(true));
  },
};
