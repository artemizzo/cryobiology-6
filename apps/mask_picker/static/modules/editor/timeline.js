/**
 * timelineMixin — таймлайн як у CVAT (панель під зображенням, клавіша T / кнопка 🎞).
 *
 * Показує кадри СЕРІЇ поточного фото (cell_001, cell_002… — tracks.series_of) і рядок
 * на кожен трек серії: суцільна смуга — клітина є на кадрі (копія / інтерполяція),
 * ◆ — ключовий кадр, ✕ — Outside (клітина зникла). Над рядками — лінійка кадрів:
 * смужка знизу = на кадрі є полігони, крапка = стан фото (обрано / пропущено / 🟡 не запечено).
 *
 * Дії: клік / протягування по лінійці — перейти на кадр (через gotoPhoto: зберігає й
 * перестрибує, зум лишається); клік по рядку треку — перейти на кадр і обрати полігон
 * цього треку; ◆◀ / ▶◆ — попередній / наступний ключовий кадр обраного треку;
 * ▶ / ⏸ — відтворення кадрів підряд (швидкість 2 / 4 / 8 кадрів/с).
 *
 * Дані — GET /api/timeline/<stem> (tracks.timeline), перечитуються при відкритті фото,
 * після кожного збереження полігонів і операцій з треками (_tracksApplyServerResult).
 * Малюється в один <canvas> (сотні кадрів × десятки треків — без тисяч DOM-елементів).
 */
import { $, showToast } from "../util.js";
import { api } from "../api.js";
import { filtered, state as appState, getLabelColor } from "../state.js";

const RULER_H = 24;
const ROW_H = 18;
const LABEL_W = 118;
const PREF_KEY = "mp.timelineOpen";
const SPEED_KEY = "mp.timelineFps";

export const timelineMixin = {
  _tlIsOpen() {
    try { return localStorage.getItem(PREF_KEY) !== "0"; } catch { return true; }
  },

  _tlToggle() {
    const open = !this._tlIsOpen();
    try { localStorage.setItem(PREF_KEY, open ? "1" : "0"); } catch { /* приватний режим */ }
    this._tlApplyVisibility();
    if (open) this._timelineRefresh();
  },

  _tlApplyVisibility() {
    const panel = $("#editorTimeline");
    if (!panel) return;
    const open = this._tlIsOpen();
    panel.classList.toggle("timeline--collapsed", !open);
    const b = $("#tlToggle");
    if (b) b.classList.toggle("btn--mini-active", open);
  },

  _tlBind() {
    if (this._tlBound) return;
    this._tlBound = true;
    const cv = $("#tlCanvas");
    $("#tlToggle").onclick = () => this._tlToggle();
    $("#tlPlay").onclick = () => this._tlPlayToggle();
    $("#tlPrevKey").onclick = () => this._tlJumpKey(-1);
    $("#tlNextKey").onclick = () => this._tlJumpKey(1);
    $("#tlFirst").onclick = () => this._tlGotoIndex(0);
    $("#tlLast").onclick = () => this._tlGotoIndex((this._tl?.frames.length || 1) - 1);
    const sp = $("#tlSpeed");
    try { sp.value = localStorage.getItem(SPEED_KEY) || "4"; } catch { /* */ }
    sp.onchange = () => { try { localStorage.setItem(SPEED_KEY, sp.value); } catch { /* */ } };

    const hit = (e) => {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const tl = this._tl;
      if (!tl || !tl.frames.length) return null;
      const fi = Math.floor((x - LABEL_W) / this._tlCellW());
      const row = y < RULER_H ? -1 : Math.floor((y - RULER_H) / ROW_H);
      return { fi: x < LABEL_W ? -1 : Math.max(0, Math.min(tl.frames.length - 1, fi)), row };
    };
    let scrubbing = false;
    cv.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const h = hit(e);
      if (!h) return;
      e.preventDefault();
      if (h.row >= 0 && h.row < this._tl.tracks.length) {
        const tr = this._tl.tracks[h.row];
        const fi = h.fi >= 0 ? h.fi : this._tlFirstVisible(tr);
        if (fi >= 0) this._tlGotoIndex(fi, tr.id);
        return;
      }
      if (h.fi < 0) return;
      scrubbing = true;
      this._tlGotoIndex(h.fi);
    });
    window.addEventListener("mousemove", (e) => {
      if (scrubbing) { const h = hit(e); if (h && h.fi >= 0) this._tlGotoIndex(h.fi); return; }
      if (e.target === cv) this._tlHover(hit(e));
    });
    window.addEventListener("mouseup", () => { scrubbing = false; });
    cv.addEventListener("mouseleave", () => this._tlHover(null));
    window.addEventListener("resize", () => { if (this.state.open) this._timelineDraw(); });
  },

  // Відкрито нове фото (editor.open) → дані серії.
  _timelineOnOpen() {
    this._tlBind();
    this._tlApplyVisibility();
    this._timelineRefresh();
  },

  async _timelineRefresh() {
    if (!this.state.open || !this._tlIsOpen()) { this._timelineDraw(); return; }
    const stem = this.state.stem;
    const tok = (this._tlTok = (this._tlTok || 0) + 1);
    try {
      const r = await api(`/api/timeline/${encodeURIComponent(stem)}`);
      if (tok !== this._tlTok || stem !== this.state.stem) return;
      this._tl = r;
    } catch (e) {
      console.warn("timeline:", e);
      return;
    }
    this._timelineDraw();
  },

  _tlCellW() {
    const cv = $("#tlCanvas");
    const n = (this._tl && this._tl.frames.length) || 1;
    const avail = Math.max(50, (cv.parentElement.clientWidth || 600) - LABEL_W - 4);
    return Math.max(6, Math.min(70, avail / n));
  },

  _tlCurIndex() {
    const tl = this._tl;
    if (!tl) return -1;
    // Під час швидкого перестрибування показуємо кінцеве фото (gotoPhoto._navTarget).
    const list = filtered();
    const stem = this._navTarget != null && list[this._navTarget] ? list[this._navTarget].stem : this.state.stem;
    return tl.frames.findIndex((f) => f.stem === stem);
  },

  _tlSelectedTrack() {
    const cur = this._trackOfSelected && this._trackOfSelected();
    return cur && cur.tid !== null ? Number(cur.tid) : null;
  },

  _timelineDraw() {
    const cv = $("#tlCanvas");
    const info = $("#tlInfo");
    if (!cv) return;
    const tl = this._tl;
    if (!this._tlIsOpen() || !tl || !tl.frames.length || tl.frames[0] === undefined) {
      cv.width = 0; cv.height = 0;
      return;
    }
    const n = tl.frames.length;
    const cw = this._tlCellW();
    const rows = tl.tracks.length;
    const cssW = LABEL_W + Math.ceil(cw * n) + 2;
    const cssH = RULER_H + Math.max(1, rows) * ROW_H + 2;
    const dpr = window.devicePixelRatio || 1;
    cv.style.width = `${cssW}px`; cv.style.height = `${cssH}px`;
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    g.font = "11px system-ui, sans-serif";
    g.textBaseline = "middle";
    const X = (i) => LABEL_W + i * cw;
    const cur = this._tlCurIndex();
    const selT = this._tlSelectedTrack();

    // Лінійка кадрів
    g.fillStyle = "rgba(255,255,255,0.04)";
    g.fillRect(LABEL_W, 0, cw * n, RULER_H);
    g.fillStyle = "#9aa4b4";
    g.textAlign = "left";
    g.fillText(`Серія ${tl.series || ""} · ${n} кадр.`, 4, RULER_H / 2);
    const every = Math.max(1, Math.ceil(28 / cw));
    g.textAlign = "center";
    tl.frames.forEach((f, i) => {
      const x = X(i);
      if (f.polygons > 0) {                 // смужка: на кадрі є полігони
        g.fillStyle = f.tracked ? "rgba(90,170,255,0.75)" : "rgba(160,170,190,0.6)";
        g.fillRect(x + 1, RULER_H - 4, Math.max(1, cw - 2), 3);
      }
      const dot = f.dirty ? "#e0b030" : f.status === "selected" ? "#3cbf6a" : f.status === "skipped" ? "#777" : null;
      if (dot && cw >= 8) { g.fillStyle = dot; g.beginPath(); g.arc(x + cw / 2, 5, 2, 0, 7); g.fill(); }
      if (i % every === 0) {
        g.fillStyle = "#c7cedb";
        g.fillText(String(f.num || i + 1), x + cw / 2, RULER_H / 2 + 1);
        g.fillStyle = "rgba(255,255,255,0.15)";
        g.fillRect(x, RULER_H - 6, 1, 6);
      }
    });

    // Рядки треків
    if (!rows) {
      g.fillStyle = "#7d8696"; g.textAlign = "left";
      g.fillText("Треків у цій серії ще нема — обери полігон → 🎞 Трек", LABEL_W + 6, RULER_H + ROW_H / 2);
    }
    tl.tracks.forEach((tr, r) => {
      const y = RULER_H + r * ROW_H;
      const col = getLabelColor ? getLabelColor(tr.label) : "#4488ff";
      if (tr.id === selT) { g.fillStyle = "rgba(255,255,255,0.08)"; g.fillRect(0, y, cssW, ROW_H); }
      if (r % 2) { g.fillStyle = "rgba(255,255,255,0.025)"; g.fillRect(LABEL_W, y, cw * n, ROW_H); }
      g.textAlign = "left";
      g.fillStyle = col; g.fillRect(4, y + 5, 8, 8);
      g.fillStyle = tr.id === selT ? "#fff" : "#c7cedb";
      g.fillText(`#${tr.id} ${tr.label || ""}`.slice(0, 16), 16, y + ROW_H / 2);
      // суцільні смуги видимості
      g.globalAlpha = 0.55; g.fillStyle = col;
      let start = -1;
      for (let i = 0; i <= n; i++) {
        const vis = i < n && (tr.cells[i] === "v" || tr.cells[i] === "k");
        if (vis && start < 0) start = i;
        if (!vis && start >= 0) { g.fillRect(X(start) + 1, y + 5, (i - start) * cw - 2, ROW_H - 10); start = -1; }
      }
      g.globalAlpha = 1;
      tr.cells.forEach((c, i) => {
        const cx = X(i) + cw / 2, cy = y + ROW_H / 2;
        const sz = Math.min(5, Math.max(3, cw / 3));
        if (c === "k") {
          g.fillStyle = col; g.strokeStyle = "#fff"; g.lineWidth = 1;
          g.beginPath(); g.moveTo(cx, cy - sz); g.lineTo(cx + sz, cy); g.lineTo(cx, cy + sz); g.lineTo(cx - sz, cy); g.closePath();
          g.fill(); g.stroke();
        } else if (c === "o") {
          g.strokeStyle = "#e06060"; g.lineWidth = 1.5;
          g.beginPath(); g.moveTo(cx - sz, cy - sz); g.lineTo(cx + sz, cy + sz); g.moveTo(cx + sz, cy - sz); g.lineTo(cx - sz, cy + sz); g.stroke();
        }
      });
    });

    // Поточний кадр — колонка + лінія через усе
    if (cur >= 0) {
      g.fillStyle = "rgba(80,160,255,0.18)";
      g.fillRect(X(cur), 0, cw, cssH);
      g.fillStyle = "#4da3ff";
      g.fillRect(X(cur) + cw / 2 - 1, 0, 2, cssH);
    }
    // Підсвітка під курсором
    if (this._tlHoverIdx != null && this._tlHoverIdx >= 0) {
      g.strokeStyle = "rgba(255,255,255,0.5)"; g.lineWidth = 1;
      g.strokeRect(X(this._tlHoverIdx) + 0.5, 0.5, cw - 1, cssH - 1);
    }
    // Тримати поточний кадр у видимій частині (довгі серії прокручуються)
    const sc = $("#tlScroll");
    if (sc && cur >= 0) {
      const cx = X(cur);
      if (cx < sc.scrollLeft + LABEL_W || cx + cw > sc.scrollLeft + sc.clientWidth) {
        sc.scrollLeft = Math.max(0, cx - sc.clientWidth / 2);
      }
    }
    if (info && !this._tlHoverIdx && this._tlHoverIdx !== 0) {
      const f = tl.frames[cur];
      info.textContent = f ? `Кадр ${f.num || cur + 1} (${cur + 1} з ${n}) · полігонів: ${f.polygons}` : "";
    }
  },

  _tlHover(h) {
    const tl = this._tl;
    const info = $("#tlInfo");
    const idx = h && h.fi >= 0 ? h.fi : null;
    if (idx !== this._tlHoverIdx) { this._tlHoverIdx = idx; this._timelineDraw(); }
    if (!info || !tl) return;
    if (idx == null) { this._tlHoverIdx = null; this._timelineDraw(); return; }
    const f = tl.frames[idx];
    let txt = `Кадр ${f.num || idx + 1} · ${f.stem} · полігонів: ${f.polygons}`;
    if (h.row >= 0 && h.row < tl.tracks.length) {
      const tr = tl.tracks[h.row];
      const c = tr.cells[idx];
      txt += ` · #${tr.id} ${tr.label || ""}: ` +
        (c === "k" ? "ключовий кадр ◆" : c === "v" ? "є (проміжний кадр)" : c === "o" ? "Outside ✕ — зникла" : "нема");
    }
    info.textContent = txt;
  },

  _tlFirstVisible(tr) {
    const cur = this._tlCurIndex();
    if (cur >= 0 && (tr.cells[cur] === "v" || tr.cells[cur] === "k")) return cur;
    return tr.cells.findIndex((c) => c === "v" || c === "k");
  },

  // Перейти на кадр серії за індексом (через gotoPhoto — зберігає, зум лишається).
  // selectTrack — після відкриття обрати полігон цього треку.
  _tlGotoIndex(fi, selectTrack = null) {
    const tl = this._tl;
    if (!tl || !tl.frames[fi]) return;
    const stem = tl.frames[fi].stem;
    if (selectTrack != null) this._tlPendingSelect = { stem, tid: selectTrack };
    if (stem === this.state.stem && this._navTarget == null) { this._tlApplyPendingSelect(); return; }
    const list = filtered();
    const to = list.findIndex((it) => it.stem === stem);
    if (to < 0) { showToast(`${stem} прихований фільтром списку — обери «Все»`, "warn", 2500); return; }
    const from = this._navTarget ?? appState.idx;
    if (to !== from) this.gotoPhoto(to - from);
    this._timelineDraw();
  },

  // Викликається після кожного відкриття фото (кінець _navRun / open).
  _tlApplyPendingSelect() {
    const p = this._tlPendingSelect;
    if (!p || p.stem !== this.state.stem) return;
    this._tlPendingSelect = null;
    const pg = this.state.polygons;
    const idx = pg.shapes.findIndex((sh) => Number((sh.flags || {}).track_id) === Number(p.tid));
    if (idx < 0) { showToast(`На цьому кадрі треку #${p.tid} нема`, "warn", 1800); return; }
    if (this.state.activeTab !== "polygons") this.switchTab("polygons");
    pg.selectedShape = idx;
    pg.selectedVertices = new Set();
    this._polyRedraw();
    this._tracksUpdateButtons();
    this._timelineDraw();
  },

  // ◆◀ / ▶◆ — попередній / наступний ключовий кадр обраного треку (як у CVAT).
  _tlJumpKey(dir) {
    const tl = this._tl;
    const tid = this._tlSelectedTrack();
    if (!tl) return;
    const tr = tl.tracks.find((t) => t.id === tid);
    if (!tr) { showToast("Обери полігон треку (клік усередині), щоб ходити його ключовими кадрами", "warn", 2500); return; }
    const cur = this._tlCurIndex();
    for (let i = cur + dir; i >= 0 && i < tr.cells.length; i += dir) {
      if (tr.cells[i] === "k" || tr.cells[i] === "o") { this._tlGotoIndex(i, tr.cells[i] === "k" ? tid : null); return; }
    }
    showToast(dir < 0 ? "Раніше ключових кадрів нема" : "Далі ключових кадрів нема", "warn", 1500);
  },

  // ▶ / ⏸ — відтворення: кадр за кадром уперед із заданою швидкістю.
  _tlPlayToggle() {
    if (this._tlPlaying) { this._tlStop(); return; }
    this._tlPlaying = true;
    $("#tlPlay").textContent = "⏸";
    const tick = () => {
      if (!this._tlPlaying || !this.state.open) { this._tlStop(); return; }
      const tl = this._tl;
      const cur = this._tlCurIndex();
      if (!tl || cur < 0 || cur >= tl.frames.length - 1) { this._tlStop(); return; }
      if (!this._navBusy) this._tlGotoIndex(cur + 1);
      const fps = Number($("#tlSpeed").value) || 4;
      this._tlPlayT = setTimeout(tick, 1000 / fps);
    };
    tick();
  },

  _tlStop() {
    this._tlPlaying = false;
    clearTimeout(this._tlPlayT);
    const b = $("#tlPlay");
    if (b) b.textContent = "▶";
  },
};
