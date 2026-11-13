/**
 * ghostMixin — «тінь» (onion skin) сусідніх фото у Polygons-табі.
 *
 * Перемикачі «◀ Попереднє» / «Наступне ▶» показують полігони попереднього /
 * наступного фото за списком (state.catalog, без виключених) напівпрозорим
 * пунктиром: попереднє — рожеве, наступне — зелене (як onion skin в анімації).
 * Тінь — лише для огляду: не входить у pg.shapes, не зберігається, клікам не
 * заважає. Інструмент "ghost" («📋 З тіні», клавіша G): клік усередині
 * полігона-тіні копіює його в поточну розмітку (той самий клас; невідомий у
 * labels.json → перший клас, як у _loadPolygons). Одна дія = один undo.
 *
 *   pg.ghost = {
 *     showPrev, showNext,            // перемикачі (пам'ятаються між фото, localStorage)
 *     prev, next,                    // null | {stem, shapes:[{label, points}], scaled}
 *     hover,                         // null | {side, idx} — підсвітка в інструменті ghost
 *   }
 *
 * Джерело тіні — polygons/<stem>.json сусіда (GET /api/polygons). Маска моделі
 * сусіда (растр без полігонів) у тінь НЕ потрапляє. Якщо розмір сусіднього
 * фото інший — координати масштабуються пропорційно.
 */

import { $, _hexToRgba, _pointInPoly, showToast } from "../util.js";
import { api } from "../api.js";
import { state, appLabels, DEFAULT_LABEL } from "../state.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const GHOST_COLORS = { prev: "#ff6b9d", next: "#5ee08a" };
const GHOST_TITLES = { prev: "попереднього", next: "наступного" };
const PREFS_KEY = "mask_picker_ghost";

function _loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch (_) { return {}; }
}
function _savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) {}
}

export const ghostMixin = {
  // Сусіди поточного фото у списку (без виключених).
  _ghostNeighbors() {
    const list = (state.catalog || []).filter((it) => !it.excluded
      && !(it.state && it.state.status === "excluded"));
    const i = list.findIndex((it) => it.stem === this.state.stem);
    if (i < 0) return { prev: null, next: null };
    return {
      prev: i > 0 ? list[i - 1].stem : null,
      next: i < list.length - 1 ? list[i + 1].stem : null,
    };
  },

  async _ghostLoad(side) {
    const pg = this.state.polygons;
    const stem = this._ghostNeighbors()[side];
    if (!stem) { pg.ghost[side] = null; return null; }
    try {
      const data = await api(`/api/polygons/${encodeURIComponent(stem)}`);
      const W = this.state.W, H = this.state.H;
      const sx = data.imageWidth ? W / data.imageWidth : 1;
      const sy = data.imageHeight ? H / data.imageHeight : 1;
      const shapes = (data.shapes || [])
        .filter((sh) => (sh.shape_type || "polygon") === "polygon" && (sh.points || []).length >= 3)
        .map((sh) => ({
          label: sh.label || "",
          points: sh.points.map((p) => [+p[0] * sx, +p[1] * sy]),
        }));
      // Редактор могли вже переключити на інше фото, поки йшов запит.
      if (!this.state.open || this._ghostNeighbors()[side] !== stem) return null;
      pg.ghost[side] = { stem, shapes, scaled: Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6 };
      return pg.ghost[side];
    } catch (e) {
      console.warn("ghost load failed:", e);
      pg.ghost[side] = null;
      return null;
    }
  },

  // Викликається з open() після _loadPolygons: відновити увімкнені перемикачі.
  async _ghostOnOpen() {
    const prefs = _loadPrefs();
    this.state.polygons.ghost = {
      showPrev: !!prefs.showPrev, showNext: !!prefs.showNext,
      prev: null, next: null, hover: null,
    };
    this._ghostUpdateButtons();
    const jobs = [];
    if (prefs.showPrev) jobs.push(this._ghostLoad("prev"));
    if (prefs.showNext) jobs.push(this._ghostLoad("next"));
    await Promise.all(jobs);
    this._ghostRedraw();
  },

  async _ghostToggle(side) {
    const pg = this.state.polygons;
    if (!pg.ghost) return;
    const key = side === "prev" ? "showPrev" : "showNext";
    pg.ghost[key] = !pg.ghost[key];
    _savePrefs({ showPrev: pg.ghost.showPrev, showNext: pg.ghost.showNext });
    this._ghostUpdateButtons();
    if (pg.ghost[key]) {
      const g = await this._ghostLoad(side);
      const stem = this._ghostNeighbors()[side];
      if (!stem) {
        showToast(`Немає ${GHOST_TITLES[side]} фото у списку`, "warn", 2500);
      } else if (!g || !g.shapes.length) {
        showToast(`Тінь: на ${GHOST_TITLES[side]} фото (${stem}) ще немає полігонів`, "warn", 3000);
      } else {
        showToast(`Тінь ${GHOST_TITLES[side]} фото (${stem}): ${g.shapes.length} полігонів` +
          (g.scaled ? " — інший розмір фото, масштабовано" : "") +
          ". Скопіювати — «📋 З тіні» (G)", "ok", 3500);
      }
    } else if (!pg.ghost.showPrev && !pg.ghost.showNext && pg.tool === "ghost") {
      this._setPolyTool(null);
    }
    this._ghostRedraw();
  },

  _ghostUpdateButtons() {
    const g = this.state.polygons.ghost || {};
    const bp = $("#polyGhostPrev"), bn = $("#polyGhostNext");
    if (bp) bp.classList.toggle("btn--mini-active", !!g.showPrev);
    if (bn) bn.classList.toggle("btn--mini-active", !!g.showNext);
  },

  _ghostSides() {
    const g = this.state.polygons.ghost;
    if (!g) return [];
    const out = [];
    if (g.showNext && g.next) out.push("next");
    if (g.showPrev && g.prev) out.push("prev");
    return out;
  },

  // Полігон-тінь під курсором → {side, idx} або null (менший за площею — пріоритетніше,
  // щоб вкладені/дрібні везикули можна було взяти поверх великих).
  _ghostHit(pt) {
    const g = this.state.polygons.ghost;
    let best = null, bestArea = Infinity;
    for (const side of this._ghostSides()) {
      g[side].shapes.forEach((sh, idx) => {
        if (!_pointInPoly(pt.x, pt.y, sh.points)) return;
        let a = 0;
        const p = sh.points;
        for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
        a = Math.abs(a / 2);
        if (a < bestArea) { bestArea = a; best = { side, idx }; }
      });
    }
    return best;
  },

  _ghostCopy(hit) {
    const pg = this.state.polygons;
    const src = pg.ghost[hit.side].shapes[hit.idx];
    const pts = src.points.map((p) => [+p[0], +p[1]]);
    const key = JSON.stringify(pts.map((p) => p.map((v) => Math.round(v * 10))));
    if (pg.shapes.some((sh) => JSON.stringify(sh.points.map((p) => p.map((v) => Math.round(v * 10)))) === key)) {
      showToast("Цей полігон уже скопійовано", "warn", 2000);
      return;
    }
    const label = appLabels.some((l) => l.name === src.label)
      ? src.label : (appLabels[0] && appLabels[0].name) || DEFAULT_LABEL;
    this._polyPushUndoSnapshot();
    pg.shapes.push({ label, points: pts, shape_type: "polygon", group_id: null, flags: {} });
    pg.selectedShape = pg.shapes.length - 1;
    pg.selectedVertices.clear();
    this._polyMarkDirty();
    this._polyUpdateButtons();
    this._polyRedraw();
    showToast(`📋 Скопійовано з ${GHOST_TITLES[hit.side]} фото (${label})`, "ok", 1800);
  },

  _ghostMouseDown(e, pt) {
    e.preventDefault();
    if (!this._ghostSides().length) {
      showToast("Спершу увімкни тінь: «◀ Попереднє» або «Наступне ▶»", "err", 2500);
      return;
    }
    const hit = this._ghostHit(pt);
    if (hit) this._ghostCopy(hit);
    else showToast("Клікни всередині полігона-тіні", "warn", 1500);
  },

  _ghostMouseMove(pt) {
    const g = this.state.polygons.ghost;
    if (!g) return;
    const hit = this._ghostHit(pt);
    if (JSON.stringify(hit) !== JSON.stringify(g.hover)) {
      g.hover = hit;
      this._ghostRedraw();
    }
  },

  _ghostRedraw() {
    const layer = this._layerGhost();
    if (!layer) return;
    layer.innerHTML = "";
    const pg = this.state.polygons;
    if (this.state.activeTab !== "polygons" || !pg.ghost) return;
    const hover = pg.tool === "ghost" ? pg.ghost.hover : null;
    for (const side of this._ghostSides()) {
      const color = GHOST_COLORS[side];
      pg.ghost[side].shapes.forEach((sh, idx) => {
        const hot = hover && hover.side === side && hover.idx === idx;
        const poly = document.createElementNS(SVG_NS, "polygon");
        poly.setAttribute("points", sh.points.map((p) => `${p[0]},${p[1]}`).join(" "));
        poly.setAttribute("class", `polygon-ghost polygon-ghost--${side}`);
        poly.setAttribute("style",
          `fill:${_hexToRgba(color, hot ? 0.3 : 0.07)};stroke:${_hexToRgba(color, hot ? 1 : 0.75)};` +
          `stroke-width:calc(${hot ? 2.5 : 1.5}px * var(--zinv, 1));` +
          (hot ? "" : "stroke-dasharray:6 4;") +
          "vector-effect:non-scaling-stroke;pointer-events:none;");
        layer.appendChild(poly);
      });
    }
  },
};
