/**
 * timelineMixin — повзунок кадрів серії у шапці редактора (як смужка кадрів у CVAT).
 *
 * Рішення мейнтейнера (2026-11-25): без великої панелі, кнопок і автовідтворення — лише
 * тонка смужка, по якій тягнеш повзунок, і кадри змінюються. Навігація кнопками — хоткеями
 * (Q / W, Alt+Q / Alt+W — ключові кадри обраного треку).
 *
 * Швидкість: при відкритті фото у фоні завантажуються ВСІ кадри серії (зображення —
 * `_frameImgs`, контури полігонів — `/api/timeline/<stem>?shapes=1`). Під час протягування
 * повзунка редактор НЕ відкриває кожен кадр, а миттєво показує готове: фото з пам'яті на
 * базовому полотні + контури полігонів того кадру в окремому шарі (`#polygonScrubLayer`).
 * Відпустив мишку — відкривається вибраний кадр повністю (gotoPhoto: зберігає поточний, зум
 * лишається). Ті самі зображення бере `_loadImage` → перехід Q / W теж швидший.
 *
 * Смужка: тонка лінія кадрів, рисочки — на кадрі є полігони (сині — є полігони треків),
 * ромбики — ключові кадри обраного треку, «бігунок» з номером — поточний кадр.
 */
import { $, showToast } from "../util.js";
import { api } from "../api.js";
import { filtered, state as appState, getLabelColor } from "../state.js";

const PAD = 10;                       // відступ смужки зліва / справа (px)
const MAX_PRELOAD = 400;              // кадрів серії, що тримаємо в пам'яті
const PRELOAD_PARALLEL = 3;
const frameImgs = new Map();          // stem → HTMLImageElement (decoded); спільний між відкриттями
const frameLoading = new Map();       // stem → Promise

function loadFrameImage(stem) {
  if (frameImgs.has(stem)) return Promise.resolve(frameImgs.get(stem));
  if (frameLoading.has(stem)) return frameLoading.get(stem);
  const pr = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = async () => {
      try { await img.decode(); } catch { /* вже декодовано */ }
      frameImgs.set(stem, img);
      if (frameImgs.size > MAX_PRELOAD) frameImgs.delete(frameImgs.keys().next().value);
      frameLoading.delete(stem);
      resolve(img);
    };
    img.onerror = () => { frameLoading.delete(stem); reject(new Error(`не завантажилось: ${stem}`)); };
    img.src = `/api/image/${encodeURIComponent(stem)}`;
  });
  frameLoading.set(stem, pr);
  return pr;
}

/** Готове зображення кадру з пам'яті (або null) — для editor._loadImage. */
export function cachedFrameImage(stem) { return frameImgs.get(stem) || null; }
export { loadFrameImage };

export const timelineMixin = {
  _tlBind() {
    if (this._tlBound) return;
    this._tlBound = true;
    const cv = $("#scrubCanvas");
    const idxAt = (clientX) => {
      const tl = this._tl;
      if (!tl || !tl.frames.length) return -1;
      const r = cv.getBoundingClientRect();
      const n = tl.frames.length;
      const t = (clientX - r.left - PAD) / Math.max(1, r.width - 2 * PAD);
      return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
    };
    let dragging = false;
    cv.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !this._tl || this._tl.frames.length < 2) return;
      e.preventDefault();
      dragging = true;
      this._scrubShow(idxAt(e.clientX));
    });
    window.addEventListener("mousemove", (e) => {
      if (dragging) { this._scrubShow(idxAt(e.clientX)); return; }
      if (e.target === cv) {
        const i = idxAt(e.clientX);
        const f = this._tl && this._tl.frames[i];
        cv.title = f ? `Кадр ${f.num || i + 1} (${f.stem}) · полігонів: ${f.polygons} — тягни, щоб гортати кадри` : "";
      }
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      this._scrubEnd();
    });
    window.addEventListener("resize", () => { if (this.state.open) this._timelineDraw(); });
  },

  // Відкрито нове фото (editor.open) → дані серії + фонове завантаження кадрів.
  _timelineOnOpen() {
    this._tlBind();
    this._timelineRefresh();
  },

  async _timelineRefresh() {
    if (!this.state.open) return;
    const stem = this.state.stem;
    const tok = (this._tlTok = (this._tlTok || 0) + 1);
    let r;
    try {
      r = await api(`/api/timeline/${encodeURIComponent(stem)}?shapes=1`);
    } catch (e) {
      console.warn("timeline:", e);
      return;
    }
    if (tok !== this._tlTok || stem !== this.state.stem) return;
    this._tl = r;
    this._timelineDraw();
    this._preloadFrames();
  },

  // Фонове завантаження зображень кадрів серії: спершу найближчі до поточного.
  async _preloadFrames() {
    const tl = this._tl;
    if (!tl) return;
    const cur = Math.max(0, this._tlCurIndex());
    const order = tl.frames.map((f, i) => ({ stem: f.stem, d: Math.abs(i - cur) }))
      .sort((a, b) => a.d - b.d).slice(0, MAX_PRELOAD).map((x) => x.stem)
      .filter((s) => !frameImgs.has(s));
    const tok = (this._preTok = (this._preTok || 0) + 1);
    let next = 0;
    const worker = async () => {
      while (next < order.length && tok === this._preTok && this.state.open) {
        const s = order[next++];
        try { await loadFrameImage(s); } catch { /* пропустити */ }
        if (this._tl && tok === this._preTok) this._timelineDraw();   // показати прогрес на смужці
      }
    };
    await Promise.all(Array.from({ length: PRELOAD_PARALLEL }, worker));
  },

  _tlCurIndex() {
    const tl = this._tl;
    if (!tl) return -1;
    if (this._scrubIdx != null) return this._scrubIdx;
    const list = filtered();
    const stem = this._navTarget != null && list[this._navTarget] ? list[this._navTarget].stem : this.state.stem;
    return tl.frames.findIndex((f) => f.stem === stem);
  },

  _tlSelectedTrack() {
    const cur = this._trackOfSelected && this._trackOfSelected();
    return cur && cur.tid !== null ? Number(cur.tid) : null;
  },

  _timelineDraw() {
    const cv = $("#scrubCanvas");
    const wrap = $("#editorScrub");
    if (!cv || !wrap) return;
    const tl = this._tl;
    const n = tl ? tl.frames.length : 0;
    wrap.style.visibility = n >= 2 ? "visible" : "hidden";   // фото без серії — смужки нема
    if (n < 2) return;
    const cssW = Math.max(60, wrap.clientWidth);
    const cssH = 26;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(cssW * dpr)) {
      cv.style.width = `${cssW}px`; cv.style.height = `${cssH}px`;
      cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    }
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    const X = (i) => PAD + (cssW - 2 * PAD) * (i / (n - 1));
    const midY = 15;

    // лінія + завантажені кадри (світліша частина — уже в пам'яті)
    g.fillStyle = "rgba(255,255,255,0.14)";
    g.fillRect(PAD, midY - 1.5, cssW - 2 * PAD, 3);
    const step = (cssW - 2 * PAD) / (n - 1);
    tl.frames.forEach((f, i) => {
      const x = X(i);
      if (frameImgs.has(f.stem)) {
        g.fillStyle = "rgba(255,255,255,0.28)";
        g.fillRect(x - step / 2, midY - 1.5, step, 3);
      }
      if (f.polygons > 0) {                       // рисочка: на кадрі є полігони
        g.fillStyle = f.tracked ? "rgba(90,170,255,0.9)" : "rgba(170,180,200,0.7)";
        g.fillRect(x - 0.75, midY + 3, 1.5, 5);
      }
      if (f.dirty) { g.fillStyle = "#e0b030"; g.fillRect(x - 0.75, midY - 9, 1.5, 3); }
    });
    // ключові кадри обраного треку
    const tid = this._tlSelectedTrack();
    const tr = tid != null ? tl.tracks.find((t) => t.id === tid) : null;
    if (tr) {
      const col = getLabelColor(tr.label) || "#4488ff";
      tr.cells.forEach((c, i) => {
        if (c !== "k" && c !== "o") return;
        const x = X(i), y = midY - 7;
        if (c === "k") {
          g.fillStyle = col; g.beginPath();
          g.moveTo(x, y - 3.5); g.lineTo(x + 3.5, y); g.lineTo(x, y + 3.5); g.lineTo(x - 3.5, y); g.closePath(); g.fill();
        } else {
          g.strokeStyle = "#e06060"; g.lineWidth = 1.2; g.beginPath();
          g.moveTo(x - 3, y - 3); g.lineTo(x + 3, y + 3); g.moveTo(x + 3, y - 3); g.lineTo(x - 3, y + 3); g.stroke();
        }
      });
    }
    // бігунок з номером кадру
    const cur = this._tlCurIndex();
    if (cur >= 0) {
      const f = tl.frames[cur];
      const label = String(f.num || cur + 1);
      g.font = "bold 10px system-ui, sans-serif";
      const w = Math.max(18, g.measureText(label).width + 8);
      const x = Math.max(w / 2, Math.min(cssW - w / 2, X(cur)));
      g.fillStyle = this._scrubIdx != null ? "#7fc0ff" : "#4da3ff";
      g.beginPath();
      if (g.roundRect) g.roundRect(x - w / 2, midY - 7, w, 14, 4); else g.rect(x - w / 2, midY - 7, w, 14);
      g.fill();
      g.fillStyle = "#05121e"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(label, x, midY + 0.5);
    }
  },

  // ── Перегляд під час протягування (нічого не зберігається і не відкривається) ──────
  _scrubShow(fi) {
    const tl = this._tl;
    if (!tl || fi < 0 || !tl.frames[fi]) return;
    if (this._scrubIdx === fi) return;
    this._scrubIdx = fi;
    const f = tl.frames[fi];
    this._previewFrame(f.stem, f.shapes || [], `кадр ${f.num || fi + 1}`);
    this._timelineDraw();
  },

  // Показати кадр `stem` з пам'яті поверх редактора (фото + контури), не відкриваючи його.
  // Спільне для повзунка й затиснутих Q / W (hold.js). shapes = null → взяти з даних серії.
  _previewFrame(stem, shapes, posText) {
    const isOwn = stem === this.state.stem;
    if (shapes == null) {
      const f = this._tl && this._tl.frames.find((x) => x.stem === stem);
      shapes = f ? f.shapes || [] : [];
    }
    this._svg().classList.toggle("is-scrubbing", !isOwn);
    const pos = $("#editorPhotoPos");
    if (pos && posText) pos.textContent = posText;
    const layer = $("#polygonScrubLayer");
    if (layer) {
      layer.replaceChildren();
      if (!isOwn) {
        const NS = "http://www.w3.org/2000/svg";
        for (const sh of shapes) {
          if (!sh.points || sh.points.length < 3) continue;
          const el = document.createElementNS(NS, "polygon");
          el.setAttribute("points", sh.points.map((p) => `${p[0]},${p[1]}`).join(" "));
          el.setAttribute("class", "polygon-scrub");
          el.style.setProperty("--c", getLabelColor(sh.label) || "#4488ff");
          layer.appendChild(el);
          if (sh.track_id != null) {
            let cx = 0, cy = 0;
            for (const p of sh.points) { cx += p[0]; cy += p[1]; }
            const t = document.createElementNS(NS, "text");
            t.setAttribute("x", cx / sh.points.length); t.setAttribute("y", cy / sh.points.length);
            t.setAttribute("class", "polygon-track-label");
            t.setAttribute("font-size", String(12 * (this._pxPerCss ? this._pxPerCss() : 1)));
            t.textContent = `#${sh.track_id}`;
            layer.appendChild(t);
          }
        }
      }
    }
    const img = frameImgs.get(stem);
    this.state.scrub = isOwn ? null : { stem, img: img || (this.state.scrub && this.state.scrub.img) || null };
    this._previewStem = stem;
    this._drawBase();
    if (!img && !isOwn) {
      loadFrameImage(stem).then((im) => {
        if (this._previewStem === stem && this.state.scrub) { this.state.scrub.img = im; this._drawBase(); }
      }).catch(() => {});
    }
  },

  _scrubEnd() {
    const fi = this._scrubIdx;
    this._scrubIdx = null;
    const tl = this._tl;
    const target = tl && fi != null ? tl.frames[fi] : null;
    if (target && target.stem !== this.state.stem) {
      // Прев'ю лишається на екрані, поки відкривається кадр (open скине state.scrub).
      this._tlGotoIndex(fi);
      return;
    }
    this._scrubClear();
    this._updateTitle();
  },

  _scrubClear() {
    const had = !!this.state.scrub;
    this.state.scrub = null;
    this._scrubIdx = null;
    const layer = $("#polygonScrubLayer");
    if (layer) layer.replaceChildren();
    this._svg().classList.remove("is-scrubbing");
    if (had && this.state.open) this._drawBase();
    this._timelineDraw();
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
    if (to < 0) {
      this._scrubClear();
      showToast(`${stem} прихований фільтром списку — обери «Все»`, "warn", 2500);
      return;
    }
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
    if (idx < 0) return;
    if (this.state.activeTab !== "polygons") this.switchTab("polygons");
    pg.selectedShape = idx;
    pg.selectedVertices = new Set();
    this._polyRedraw();
    this._tracksUpdateButtons();
    this._timelineDraw();
  },

  // Alt+Q / Alt+W — попередній / наступний ключовий кадр обраного треку (як у CVAT).
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
};
