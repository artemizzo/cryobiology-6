/**
 * tracksMixin — треки об'єктів між кадрами серії (як track у CVAT). Серверна
 * логіка — tracks.py / routes/api_tracks.py (див. docs/architecture/17_TRACKS.md).
 *
 * Полігон треку = звичайний shape з `flags.track_id` (+ `flags.keyframe`).
 * Ключові кадри / інтерполяцію / outside рахує сервер на КОЖНЕ збереження
 * полігонів кадру (POST /api/polygons/<stem> → відповідь `tracks`), тож
 * звичайні правки (тягнути точки, розрив, видалення) працюють з треками самі:
 * змінив форму на кадрі → ключовий кадр; видалив полігон треку → outside.
 *
 * Кнопки (видно лише доречні, `_tracksUpdateButtons`):
 *   🎞 Трек      — обраний звичайний полігон → новий трек з цього кадру
 *   ⛔ Outside   — трек закінчується на цьому кадрі (= видалити його полігон тут)
 *   ✂ Розділити — від цього кадру — новий номер треку
 *   🔗 Злити…    — влити інший трек (номер) у цей
 *   🗑 Трек      — видалити трек з усіх кадрів серії
 *   📎 До треку… — обраний звичайний полігон стає формою НАЯВНОГО треку на цьому
 *                  кадрі (номер лишається; стара форма треку тут прибирається)
 * Розділення / злиття / видалення перезаписують і поточний кадр на сервері →
 * кадр перечитується; сервер знімає знімок файлів до операції (undo_id), і
 * операція лягає в глобальну історію: Ctrl+Z → /api/tracks/undo, Ctrl+Shift+Z →
 * повтор операції.
 */

import { $, showToast } from "../util.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { _clearPolygonsCache } from "../polyoverlay.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export const tracksMixin = {
  _trackOfSelected() {
    const pg = this.state.polygons;
    const sh = pg.shapes[pg.selectedShape];
    if (!sh) return null;
    const tid = (sh.flags || {}).track_id;
    return tid === undefined || tid === null ? { shape: sh, tid: null } : { shape: sh, tid };
  },

  _tracksUpdateButtons() {
    const cur = this.state.polygons.tool === null ? this._trackOfSelected() : null;
    const show = (id, on) => { const b = $(id); if (b) b.style.display = on ? "" : "none"; };
    show("#trackCreate", !!cur && cur.tid === null);
    show("#trackAssign", !!cur && cur.tid === null);
    for (const id of ["#trackOutside", "#trackSplit", "#trackMerge", "#trackDelete"]) {
      show(id, !!cur && cur.tid !== null);
    }
    if (this._timelineDraw && this._tl) this._timelineDraw();   // підсвітити рядок обраного треку
    const lbl = $("#trackSelected");
    if (lbl) {
      lbl.style.display = cur && cur.tid !== null ? "" : "none";
      if (cur && cur.tid !== null) lbl.textContent = `🎞 #${cur.tid}`;
    }
  },

  // Відповідь сервера на збереження кадру / операцію з треком → каталог + повідомлення.
  _tracksApplyServerResult(res, verb) {
    // Таймлайн: полігони / треки кадру змінились → перечитати (з невеликою паузою —
    // autosave може йти серіями).
    clearTimeout(this._tlRefreshT);
    this._tlRefreshT = setTimeout(() => this._timelineRefresh && this._timelineRefresh(), 250);
    if (!res || res.error) {
      if (res && res.error) showToast(`Треки: ${res.error}`, "err", 5000);
      return;
    }
    const frames = res.frames || [];
    for (const s of frames) {
      const it = (state.catalog || []).find((x) => x.stem === s);
      if (it && res.states && res.states[s]) it.state = res.states[s];
      _clearPolygonsCache(s);
    }
    if (frames.length && verb !== false) {
      showToast(`🎞 ${verb || "Трек оновлено"}: змінено кадрів — ${frames.length}`, "ok", 2500);
    }
  },

  async _trackCreate() {
    const cur = this._trackOfSelected();
    if (!cur || cur.tid !== null) return;
    try {
      const r = await api("/api/tracks/new", { method: "POST", body: "{}" });
      this._polyPushUndoSnapshot();
      cur.shape.flags = { ...(cur.shape.flags || {}), track_id: r.track_id, keyframe: true };
      this._polyMarkDirty();
      this._polyRedraw();
      this._tracksUpdateButtons();
      await this._polySave(true);          // сервер розносить трек на наступні кадри серії
      showToast(`🎞 Трек #${r.track_id} створено — він продовжиться на наступних кадрах серії. ` +
        "Виправите форму на іншому кадрі — проміжні кадри підлаштуються самі.", "ok", 5000);
    } catch (e) {
      showToast(`Трек: ${e.message || e}`, "err", 5000);
    }
  },

  async _trackOutside() {
    const cur = this._trackOfSelected();
    if (!cur || cur.tid === null) return;
    this._polyDeleteSelectedShape();       // зник полігон треку з кадру = outside (сервер)
    await this._polySave(true);
    showToast(`⛔ Трек #${cur.tid} закінчується на цьому кадрі (Ctrl+Z — повернути)`, "ok", 3500);
  },

  // Операція, що перезаписує й поточний кадр: зберегти → виконати → перечитати
  // кадр → покласти в історію (Ctrl+Z скасує її на сервері).
  async _trackServerOp(url, method, body, verb) {
    try {
      const r = await this._trackRunOp(url, method, body, verb);
      const h = this._historyEnsure();
      h.undo.push({ snaps: {}, primary: "polygons", trackop: { url, method, body, verb, undo_id: r.undo_id } });
      h.redo.length = 0;
      this._historyUpdateButtons();
      return r;
    } catch (e) {
      showToast(`Трек: ${e.message || e}`, "err", 5000);
      return null;
    }
  },

  async _trackRunOp(url, method, body, verb) {
    if (this.state.polygons.dirty) await this._polySave(true);
    const r = await api(url, { method, body: body ? JSON.stringify(body) : undefined });
    this._tracksApplyServerResult(r, verb);
    await this._trackReloadFrame();
    return r;
  },

  // Перечитати полігони й групи кадру після зміни на сервері (без зміни історії).
  async _trackReloadFrame() {
    await this._loadPolygons();
    await this._groupsLoad();
    const pg = this.state.polygons;
    pg.selectedShape = -1;
    pg.selectedVertices.clear();
    pg.dirty = false;
    this._polyUpdateButtons();
    this._polyRedraw();
    this._ghostOnOpen();                   // сусідні кадри теж могли змінитись
  },

  // Ctrl+Z по серверній операції (history.js): повернути файли до операції.
  async _trackOpUndo(op) {
    try {
      if (this.state.polygons.dirty) await this._polySave(true);
      const r = await api("/api/tracks/undo", { method: "POST", body: JSON.stringify({ undo_id: op.undo_id }) });
      this._tracksApplyServerResult(r, false);
      await this._trackReloadFrame();
      showToast(`↶ Скасовано: ${op.verb || "операцію з треком"}`, "ok", 2500);
    } catch (e) {
      showToast(`Скасувати не вдалося: ${e.message || e}`, "err", 5000);
    }
  },

  // Ctrl+Shift+Z: повторити операцію (новий знімок → новий undo_id).
  async _trackOpRedo(op) {
    try {
      const r = await this._trackRunOp(op.url, op.method, op.body, op.verb);
      this._historyEnsure().undo.push({ snaps: {}, primary: "polygons", trackop: { ...op, undo_id: r.undo_id } });
      this._historyUpdateButtons();
    } catch (e) {
      showToast(`Повторити не вдалося: ${e.message || e}`, "err", 5000);
    }
  },

  // Обраний звичайний полігон → форма наявного треку на цьому кадрі.
  async _trackAssign() {
    const cur = this._trackOfSelected();
    if (!cur || cur.tid !== null) return;
    const m = /^(.*?)(\d+)$/.exec(this.state.stem);
    const series = m ? m[1] : this.state.stem;
    let list = [];
    try { list = ((await api("/api/tracks")).tracks || []).filter((t) => t.series === series); } catch (_) {}
    const hint = list.length
      ? list.map((t) => `#${t.id} (${t.label}, ${t.first || "—"} … ${t.last || "—"})`).join("\n")
      : "(у цій серії ще нема треків)";
    const ans = prompt("Зробити обраний полігон формою треку на цьому кадрі (номер лишається).\n" +
      `Номер треку:\n${hint}`, "");
    if (ans === null) return;
    const tid = parseInt(String(ans).replace("#", "").trim(), 10);
    if (!list.some((t) => t.id === tid)) { showToast(`Треку #${ans} у цій серії нема`, "err", 3000); return; }
    const pg = this.state.polygons;
    this._polyPushUndoSnapshot();
    const shape = pg.shapes[pg.selectedShape];
    shape.flags = { ...(shape.flags || {}), track_id: tid, keyframe: true };
    const old = pg.shapes.findIndex((sh, i) => sh !== shape && Number((sh.flags || {}).track_id) === tid);
    if (old >= 0) {
      pg.shapes.splice(old, 1);
      this._polyRemapGroupsAfterShapeDelete([old]);   // groups-snap у той самий undo-запис
    }
    pg.selectedShape = pg.shapes.indexOf(shape);
    this._polyMarkDirty();
    this._polyUpdateButtons();
    this._polyRedraw();
    await this._polySave(true);
    showToast(`📎 Полігон тепер — трек #${tid} на цьому кадрі` + (old >= 0 ? " (стару форму прибрано)" : ""), "ok", 3500);
  },

  async _trackSplit() {
    const cur = this._trackOfSelected();
    if (!cur || cur.tid === null) return;
    const r = await this._trackServerOp(`/api/tracks/${cur.tid}/split`, "POST",
      { stem: this.state.stem }, "Трек розділено");
    if (r) showToast(`✂ Від цього кадру — новий трек #${r.new_track_id} (#${cur.tid} закінчується перед ним)`, "ok", 4000);
  },

  async _trackMerge() {
    const cur = this._trackOfSelected();
    if (!cur || cur.tid === null) return;
    let list = [];
    try { list = (await api("/api/tracks")).tracks || []; } catch (_) { /* лише підказка */ }
    const mine = list.find((t) => t.id === Number(cur.tid));
    const others = list.filter((t) => t.id !== Number(cur.tid) && (!mine || t.series === mine.series));
    const hint = others.length
      ? others.map((t) => `#${t.id} (${t.label}, ${t.first} … ${t.last})`).join("\n")
      : "(інших треків у цій серії нема)";
    const ans = prompt(`Злити в трек #${cur.tid} інший трек тієї ж серії.\nНомер треку:\n${hint}`, "");
    if (ans === null) return;
    const src = parseInt(String(ans).replace("#", "").trim(), 10);
    if (!Number.isInteger(src)) { showToast("Потрібен номер треку", "err", 2500); return; }
    const r = await this._trackServerOp(`/api/tracks/${cur.tid}/merge`, "POST", { from: src }, "Треки злито");
    if (r) showToast(`🔗 Трек #${src} злито в #${cur.tid}`, "ok", 3500);
  },

  async _trackDelete() {
    const cur = this._trackOfSelected();
    if (!cur || cur.tid === null) return;
    if (!confirm(`Видалити трек #${cur.tid} з УСІХ кадрів серії?`)) return;
    const r = await this._trackServerOp(`/api/tracks/${cur.tid}`, "DELETE", null, "Трек видалено");
    if (r) showToast(`🗑 Трек #${cur.tid} видалено з усіх кадрів`, "ok", 3500);
  },

  // Підпис «#id» (◆ — ключовий кадр) у центрі полігона треку.
  _tracksDrawLabel(layer, sh) {
    const tid = (sh.flags || {}).track_id;
    if (tid === undefined || tid === null || !sh.points.length) return;
    let cx = 0, cy = 0;
    for (const [x, y] of sh.points) { cx += x; cy += y; }
    cx /= sh.points.length; cy /= sh.points.length;
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(cx));
    t.setAttribute("y", String(cy));
    t.setAttribute("class", "polygon-track-label");
    t.setAttribute("style",
      `font-size:${12 * this._pxPerCss()}px;fill:#fff;stroke:#000;` +
      "stroke-width:calc(3px * var(--zinv, 1));paint-order:stroke;vector-effect:non-scaling-stroke;" +
      "text-anchor:middle;dominant-baseline:central;pointer-events:none;font-weight:600;");
    t.textContent = `#${tid}${(sh.flags || {}).keyframe ? "◆" : ""}`;
    layer.appendChild(t);
  },
};
