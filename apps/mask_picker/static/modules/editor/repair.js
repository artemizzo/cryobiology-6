/**
 * repairMixin — «розрив» полігона (tool "break", клавіша B) у Polygons-табі.
 *
 * Сценарій користувача: розірвати замкнений контур в одному місці (по ребру —
 * на місці кліку з'являються дві точки-кінці; по вершині — вона стає двома
 * кінцями), за потреби розірвати вдруге → контур розпадається на два
 * фрагменти, неправильний фрагмент видалити кнопкою, від кінця домалювати
 * правильну ділянку і з'єднати з іншим кінцем → полігон знову замкнений.
 *
 * == Модель: СЕАНС РЕМОНТУ одного shape ==
 *   pg.repair = {
 *     si,                 // індекс shape у pg.shapes, який ремонтуємо
 *     pieces: [[[x,y],…], …],   // відкриті ламані (фрагменти контуру)
 *     selPiece,           // обраний фрагмент (для видалення) або -1
 *     extend,             // null | {piece, end: "start"|"end"} — домальовування
 *     undo: [],           // локальний стек знімків pieces (Ctrl+Z у сеансі)
 *   }
 * Під час сеансу pg.shapes[si] НЕ змінюється (лишається старий валідний
 * полігон): autosave / bake / groups / covered бачать лише замкнені полігони,
 * відкриті лінії НІКОЛИ не потрапляють у дані. Коли фрагмент один і його кінці
 * з'єднані — `_repairCommit` записує новий контур у ТОЙ САМИЙ індекс si одним
 * глобальним undo-записом → polygon_indices груп лишаються валідними (клітина
 * не випадає з групи). Esc / зміна табу / закриття редактора = скасування
 * (полігон без змін).
 *
 * Жести (tool "break"):
 *   клік по ребру/вершині полігона         → почати сеанс + розрив тут
 *   клік по ребру/внутр. вершині фрагмента → розрив фрагмента на два
 *                                            (коротший стає обраним)
 *   Shift+клік по фрагменту                → обрати фрагмент
 *   Delete / «🗑 Фрагмент»                 → видалити обраний фрагмент
 *   клік по кінцю фрагмента                → домальовувати від нього
 *     (далі клік = точка, Shift+рух = freehand, Backspace — прибрати точку)
 *   клік по кінцю під час домальовування   → з'єднати: інший фрагмент →
 *                                            злиття; свій інший кінець →
 *                                            замкнути полігон (commit)
 *   Enter / «✔ Замкнути»                   → замкнути (єдиний фрагмент,
 *                                            кінці з'єднуються прямою)
 *   Ctrl+Z                                 → крок назад у сеансі
 *   Esc                                    → вийти з домальовування; ще раз —
 *                                            скасувати сеанс
 */

import { _hexToRgba, _projectPointOnSegment, showToast } from "../util.js";
import { getLabelColor, DEFAULT_LABEL } from "../state.js";

const VERTEX_CLICK_PX = 10;     // як у polygons.js
const EDGE_CLICK_PX = 10;
const FREEHAND_MIN_DIST = 15;
const SVG_NS = "http://www.w3.org/2000/svg";

const _clonePieces = (pieces) => pieces.map((pc) => pc.map((p) => [p[0], p[1]]));
const _d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const _len = (pc) => {
  let s = 0;
  for (let i = 1; i < pc.length; i++) s += Math.sqrt(_d2(pc[i - 1], pc[i]));
  return s;
};

export const repairMixin = {
  _repairActive() {
    return !!this.state.polygons.repair;
  },

  // ---------- hit-tests ----------

  // Вершина/ребро ЗАМКНЕНОГО shape (старт сеансу).
  _repairHitShapeContour(pt) {
    const pg = this.state.polygons;
    const s = this._pxPerCss();
    const tv = (VERTEX_CLICK_PX * s) ** 2;
    for (let si = pg.shapes.length - 1; si >= 0; si--) {
      const pts = pg.shapes[si].points;
      for (let vi = 0; vi < pts.length; vi++) {
        if (_d2(pts[vi], [pt.x, pt.y]) <= tv) return { si, vi };
      }
    }
    const te = (EDGE_CLICK_PX * s) ** 2;
    let best = null, bestD = te;
    pg.shapes.forEach((sh, si) => {
      const pts = sh.points, n = pts.length;
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        const pr = _projectPointOnSegment(pt.x, pt.y, a[0], a[1], b[0], b[1], false);
        if (pr.t <= 0 || pr.t >= 1) continue;
        const d = (pr.x - pt.x) ** 2 + (pr.y - pt.y) ** 2;
        if (d < bestD) { bestD = d; best = { si, edge: i, q: [pr.x, pr.y] }; }
      }
    });
    return best;
  },

  // Кінець фрагмента: {piece, end}.
  _repairHitEnd(pt) {
    const r = this.state.polygons.repair;
    const t = (VERTEX_CLICK_PX * this._pxPerCss()) ** 2;
    let best = null, bestD = t;
    r.pieces.forEach((pc, k) => {
      for (const [end, p] of [["end", pc[pc.length - 1]], ["start", pc[0]]]) {
        const d = _d2(p, [pt.x, pt.y]);
        if (d <= bestD) { bestD = d; best = { piece: k, end }; }
      }
    });
    return best;
  },

  // Внутрішня вершина або ребро фрагмента: {piece, vi} | {piece, edge, q}.
  _repairHitPiece(pt) {
    const r = this.state.polygons.repair;
    const s = this._pxPerCss();
    const tv = (VERTEX_CLICK_PX * s) ** 2;
    for (let k = 0; k < r.pieces.length; k++) {
      const pc = r.pieces[k];
      for (let vi = 1; vi < pc.length - 1; vi++) {
        if (_d2(pc[vi], [pt.x, pt.y]) <= tv) return { piece: k, vi };
      }
    }
    const te = (EDGE_CLICK_PX * s) ** 2;
    let best = null, bestD = te;
    r.pieces.forEach((pc, k) => {
      for (let i = 0; i < pc.length - 1; i++) {
        const a = pc[i], b = pc[i + 1];
        const pr = _projectPointOnSegment(pt.x, pt.y, a[0], a[1], b[0], b[1], false);
        if (pr.t <= 0 || pr.t >= 1) continue;
        const d = (pr.x - pt.x) ** 2 + (pr.y - pt.y) ** 2;
        if (d < bestD) { bestD = d; best = { piece: k, edge: i, q: [pr.x, pr.y] }; }
      }
    });
    return best;
  },

  // ---------- сеанс ----------

  _repairPushLocal() {
    const r = this.state.polygons.repair;
    r.undo.push({ pieces: _clonePieces(r.pieces), extend: r.extend ? { ...r.extend } : null });
    if (r.undo.length > 200) r.undo.shift();
  },

  _repairStart(hit) {
    const pg = this.state.polygons;
    const ring = pg.shapes[hit.si].points.map((p) => [p[0], p[1]]);
    const n = ring.length;
    let piece;
    if (hit.vi != null) {
      // Розрив у вершині: вона стає обома кінцями.
      piece = [];
      for (let k = 0; k <= n; k++) piece.push([...ring[(hit.vi + k) % n]]);
    } else {
      // Розрив на ребрі edge→edge+1: дві нові точки-кінці на місці кліку.
      piece = [[...hit.q]];
      for (let k = 1; k <= n; k++) piece.push([...ring[(hit.edge + k) % n]]);
      piece.push([...hit.q]);
    }
    pg.repair = { si: hit.si, pieces: [piece], selPiece: -1, extend: null, undo: [] };
    pg.selectedShape = -1;
    pg.selectedVertices.clear();
    pg.draft = null;
    showToast("✂ Полігон розірвано. Розірви ще раз, щоб відокремити ділянку, " +
      "або клікни по кінцю, щоб домалювати.", "ok", 3500);
    this._repairAfterChange();
  },

  _repairSplit(hit) {
    const r = this.state.polygons.repair;
    const pc = r.pieces[hit.piece];
    let a, b;
    if (hit.vi != null) {
      a = pc.slice(0, hit.vi + 1);
      b = pc.slice(hit.vi);
    } else {
      a = pc.slice(0, hit.edge + 1).concat([[...hit.q]]);
      b = [[...hit.q]].concat(pc.slice(hit.edge + 1));
    }
    a = a.map((p) => [p[0], p[1]]);
    b = b.map((p) => [p[0], p[1]]);
    this._repairPushLocal();
    r.pieces.splice(hit.piece, 1, a, b);
    // Коротший фрагмент — найімовірніше неправильна ділянка → одразу обраний.
    r.selPiece = _len(a) <= _len(b) ? hit.piece : hit.piece + 1;
    r.extend = null;
    this._repairAfterChange();
  },

  _repairDeleteSelected() {
    const r = this.state.polygons.repair;
    if (!r) return;
    if (r.selPiece < 0) {
      showToast("Спершу обери фрагмент (Shift+клік або розірви ще раз)", "err", 2500);
      return;
    }
    if (r.pieces.length <= 1) {
      showToast("Це єдиний фрагмент — його не можна видалити (Esc — скасувати розрив)", "err", 3000);
      return;
    }
    this._repairPushLocal();
    r.pieces.splice(r.selPiece, 1);
    r.selPiece = -1;
    r.extend = null;
    this._repairAfterChange();
  },

  // Злиття: кінець (k1,e1) з'єднується з кінцем (k2,e2) іншого фрагмента.
  _repairJoin(k1, e1, k2, e2) {
    const r = this.state.polygons.repair;
    let a = r.pieces[k1].slice();
    let b = r.pieces[k2].slice();
    if (e1 === "start") a.reverse();          // a закінчується з'єднуваним кінцем
    if (e2 === "end") b.reverse();            // b починається з'єднуваним кінцем
    if (_d2(a[a.length - 1], b[0]) < 1e-6) b = b.slice(1);   // не дублювати точку
    const merged = a.concat(b);
    this._repairPushLocal();
    const hi = Math.max(k1, k2), lo = Math.min(k1, k2);
    r.pieces.splice(hi, 1);
    r.pieces.splice(lo, 1, merged);
    r.selPiece = -1;
    r.extend = null;
    this._repairAfterChange();
  },

  // Замкнути єдиний фрагмент → записати контур у shape si.
  _repairCommit() {
    const pg = this.state.polygons;
    const r = pg.repair;
    if (!r) return;
    if (r.pieces.length !== 1) {
      showToast(`Фрагментів: ${r.pieces.length}. Видали зайві або з'єднай їх, щоб замкнути полігон.`, "err", 3500);
      return;
    }
    const ring = [];
    for (const p of r.pieces[0]) {
      if (!ring.length || _d2(ring[ring.length - 1], p) > 1e-6) ring.push([+p[0], +p[1]]);
    }
    if (ring.length > 1 && _d2(ring[0], ring[ring.length - 1]) <= 1e-6) ring.pop();
    if (ring.length < 3) {
      showToast("Замало точок для полігона (потрібно ≥3)", "err", 2500);
      return;
    }
    const si = r.si;
    pg.repair = null;
    this._polyPushUndoSnapshot();          // глобальний undo: стан ДО ремонту
    pg.shapes[si].points = ring;
    pg.selectedShape = si;
    this._polyMarkDirty();
    this._polyUpdateButtons();
    this._updateHint();
    this._polyRedraw();
    showToast("✓ Полігон замкнено", "ok", 1800);
  },

  _repairCancel(reason) {
    const pg = this.state.polygons;
    if (!pg.repair) return;
    pg.repair = null;
    if (reason) showToast(`Розрив скасовано${reason === true ? "" : ` (${reason})`} — полігон без змін`, "warn", 2500);
    this._polyUpdateButtons();
    this._updateHint();
    this._polyRedraw();
  },

  _repairUndo() {
    const r = this.state.polygons.repair;
    if (!r) return;
    const snap = r.undo.pop();
    if (!snap) { this._repairCancel(true); return; }
    r.pieces = snap.pieces;
    r.extend = snap.extend;
    r.selPiece = -1;
    this._repairAfterChange();
  },

  _repairPopExtendPoint() {
    const r = this.state.polygons.repair;
    if (!r || !r.extend) return;
    const pc = r.pieces[r.extend.piece];
    if (pc.length <= 2) return;
    this._repairPushLocal();
    if (r.extend.end === "end") pc.pop(); else pc.shift();
    this._repairAfterChange();
  },

  _repairAfterChange() {
    this._polyUpdateButtons();
    this._updateHint();
    this._polyRedraw();
  },

  // ---------- миша (викликається з polygons.js, коли tool==="break" або йде сеанс) ----------

  _repairMouseDown(e, pt) {
    const pg = this.state.polygons;
    const r = pg.repair;
    e.preventDefault();
    if (!r) {
      const hit = this._repairHitShapeContour(pt);
      if (hit) this._repairStart(hit);
      else showToast("Клікни по контуру (ребру або точці) полігона, який треба розірвати", "err", 2200);
      return;
    }
    if (r.extend) {
      const end = this._repairHitEnd(pt);
      if (end) {
        const { piece, end: e1 } = r.extend;
        if (end.piece === piece && end.end !== e1) {
          this._repairCommit();                 // свій інший кінець → замкнути
        } else if (end.piece !== piece) {
          this._repairJoin(piece, e1, end.piece, end.end);
        }
        return;
      }
      this._repairPushLocal();
      const pc = r.pieces[r.extend.piece];
      if (r.extend.end === "end") pc.push([pt.x, pt.y]); else pc.unshift([pt.x, pt.y]);
      this._repairAfterChange();
      return;
    }
    if (e.shiftKey) {
      const hp = this._repairHitPiece(pt) || this._repairHitEnd(pt);
      r.selPiece = hp ? (r.selPiece === hp.piece ? -1 : hp.piece) : -1;
      this._repairAfterChange();
      return;
    }
    const end = this._repairHitEnd(pt);
    if (end) {
      r.extend = end;
      r.selPiece = -1;
      this._repairAfterChange();
      return;
    }
    const hp = this._repairHitPiece(pt);
    if (hp) { this._repairSplit(hp); return; }
    r.selPiece = -1;
    this._repairAfterChange();
  },

  _repairMouseMove(e, pt) {
    const r = this.state.polygons.repair;
    if (r && r.extend && e.shiftKey) {
      const pc = r.pieces[r.extend.piece];
      const last = r.extend.end === "end" ? pc[pc.length - 1] : pc[0];
      if (_d2(last, [pt.x, pt.y]) >= FREEHAND_MIN_DIST * FREEHAND_MIN_DIST) {
        this._repairPushLocal();
        if (r.extend.end === "end") pc.push([pt.x, pt.y]); else pc.unshift([pt.x, pt.y]);
      }
    }
    this._repairRedraw();
  },

  // ---------- клавіші (з keys.js); true = оброблено ----------

  _repairOnKey(e) {
    const r = this.state.polygons.repair;
    if (!r) return false;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") {
      e.preventDefault();
      if (r.extend) { r.extend = null; this._repairAfterChange(); }
      else this._repairCancel(true);
      return true;
    }
    if (ctrl && e.code === "KeyZ" && !e.shiftKey) { e.preventDefault(); this._repairUndo(); return true; }
    if (ctrl && (e.code === "KeyY" || e.code === "KeyZ")) { e.preventDefault(); return true; }
    // Space НЕ замикає (лишається pan): випадкове утримання не має завершувати ремонт.
    if (e.key === "Enter") { e.preventDefault(); this._repairCommit(); return true; }
    if (e.key === "Delete") { e.preventDefault(); this._repairDeleteSelected(); return true; }
    if (e.key === "Backspace") { e.preventDefault(); this._repairPopExtendPoint(); return true; }
    return false;
  },

  // ---------- рендер (шар draft) ----------

  _repairRedraw() {
    const pg = this.state.polygons;
    const r = pg.repair;
    if (!r) return;
    const layer = this._layerDraft();
    layer.innerHTML = "";
    const sh = pg.shapes[r.si];
    const color = getLabelColor((sh && sh.label) || DEFAULT_LABEL);
    const rad = this._polyVertexR();
    r.pieces.forEach((pc, k) => {
      const line = document.createElementNS(SVG_NS, "polyline");
      line.setAttribute("points", pc.map((p) => `${p[0]},${p[1]}`).join(" "));
      const sel = k === r.selPiece;
      line.setAttribute("class", "repair-piece" + (sel ? " repair-piece--selected" : ""));
      line.setAttribute("style",
        `fill:none;stroke:${sel ? "#ff4d4f" : _hexToRgba(color, 0.95)};` +
        `stroke-width:calc(${sel ? 3 : 2}px * var(--zinv, 1));vector-effect:non-scaling-stroke;` +
        (sel ? "stroke-dasharray:6 4;" : ""));
      layer.appendChild(line);
      pc.forEach(([x, y], vi) => {
        const isEnd = vi === 0 || vi === pc.length - 1;
        const c = document.createElementNS(SVG_NS, "circle");
        c.setAttribute("cx", String(x));
        c.setAttribute("cy", String(y));
        c.setAttribute("r", String(isEnd ? rad * 1.5 : rad * 0.8));
        const active = r.extend && r.extend.piece === k &&
          ((r.extend.end === "end") === (vi === pc.length - 1)) && isEnd;
        c.setAttribute("class", "repair-vertex" + (isEnd ? " repair-vertex--end" : ""));
        c.setAttribute("style", isEnd
          ? `fill:${active ? "#ffd666" : "#ffffff"};stroke:${_hexToRgba(color, 1)};stroke-width:calc(2px * var(--zinv, 1));vector-effect:non-scaling-stroke;`
          : `fill:${_hexToRgba(color, 0.9)};`);
        layer.appendChild(c);
      });
    });
    // Прев'ю домальовування: від активного кінця до курсора.
    if (r.extend && pg.cursor) {
      const pc = r.pieces[r.extend.piece];
      const from = r.extend.end === "end" ? pc[pc.length - 1] : pc[0];
      const ln = document.createElementNS(SVG_NS, "line");
      ln.setAttribute("x1", String(from[0])); ln.setAttribute("y1", String(from[1]));
      ln.setAttribute("x2", String(pg.cursor.x)); ln.setAttribute("y2", String(pg.cursor.y));
      ln.setAttribute("style",
        `stroke:${_hexToRgba(color, 0.8)};stroke-width:calc(1.5px * var(--zinv, 1));stroke-dasharray:4 3;vector-effect:non-scaling-stroke;`);
      layer.appendChild(ln);
    }
  },
};
