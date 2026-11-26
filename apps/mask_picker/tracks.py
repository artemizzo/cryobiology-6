"""
tracks.py — треки об'єктів між кадрами серії (як track у CVAT).

== Модель ==
Трек = та сама клітина на послідовних кадрах однієї СЕРІЇ з одним номером.
Серія = фото, чиї імена відрізняються лише числом у кінці
(`seq_1_0001`, `seq_1_0002`, … → серія `seq_1_`, кадри 1, 2, …); порядок
кадрів — за цим числом. Фото без числа в кінці — серія з одного кадру.

SoT треків — `<workspace>/tracks.json`:
    {"version": 1, "next_id": 4, "tracks": {
        "3": {"label": "nucleus", "series": "seq_1_",
              "keyframes": {"seq_1_0002": {"points": [[x,y],...], "outside": false},
                            "seq_1_0009": {"points": [], "outside": true}}}}}

Форма треку на кадрі f (`shape_at`):
  - до першого ключового кадру → нема;
  - останній ключ k0 ≤ f з outside → нема (клітина «зникла»);
  - є наступний ключ k1 > f, і він не outside → ІНТЕРПОЛЯЦІЯ k0→k1
    (контури приводяться до однакової к-сті точок за довжиною дуги,
    вирівнюються за напрямком обходу і стартовою точкою);
  - інакше → копія k0 (трек триває до кінця серії).

МАТЕРІАЛІЗАЦІЯ: на кожному кадрі серії форма треку — звичайний полігон у
`polygons/<stem>.json` з `flags = {track_id, keyframe}` → bake / groups /
export працюють без змін. Оновлення — НА МІСЦІ (той самий індекс shape), щоб
`groups[].polygon_indices` не зрушувались; видалення (outside) → splice +
ремап polygon_indices у `groups/<stem>.json` (як фронтовий
`_polyRemapGroupsAfterShapeDelete`). Кадр без стану в selections.json, що
отримав полігон треку, автоматично стає «manual» (інакше трек не запечеться).

СИНХРОНІЗАЦІЯ: `sync_frame` викликається на КОЖНЕ збереження полігонів кадру
(POST /api/polygons/<stem>): порівнює полігони з track_id із розрахунковими
формами → зміна форми/класу = новий ключовий кадр; новий track_id = новий трек;
зник полігон треку = outside з цього кадру. Далі перематеріалізуються ІНШІ кадри
серії (поточний щойно збережений редактором — його не чіпаємо).
"""
from __future__ import annotations

import json
import math
import re
import threading
from pathlib import Path
from typing import Optional

from state import (
    IMAGE_EXTS, MANUAL_MODEL, Config, StateStore,
    _atomic_write_json, _load_original_image_array, _find_image_filename, _utc_iso,
)
from polygons import _polygons_path, _write_polygons_json, _labelme_envelope
from groups import _read_groups, _write_groups, _groups_path

TRACKS_FILE = "tracks.json"
TRACKS_VERSION = 1
_LOCK = threading.RLock()            # tracks.json + перезапис кадрів — послідовно
_SERIES_RE = re.compile(r"^(.*?)(\d+)$")
EPS = 1e-3                           # допуск «форма не змінилась» (image-px)


# ---------------------------------------------------------------------------
# Серії й кадри
# ---------------------------------------------------------------------------

def series_of(stem: str) -> tuple[str, int]:
    """'seq_1_0012' → ('seq_1_', 12); без числа в кінці → (stem, 0)."""
    m = _SERIES_RE.match(stem)
    if not m:
        return stem, 0
    return m.group(1), int(m.group(2))


def series_frames(cfg: Config, series: str) -> list[str]:
    """Stem-и серії в порядку номера кадру (лише наявні фото, без _excluded)."""
    if not cfg.images_dir or not cfg.images_dir.exists():
        return []
    frames = {}
    for p in cfg.images_dir.iterdir():
        if p.suffix.lower() not in IMAGE_EXTS:
            continue
        s, n = series_of(p.stem)
        if s == series:
            frames[p.stem] = n
    return sorted(frames, key=lambda st: (frames[st], st))


# ---------------------------------------------------------------------------
# tracks.json
# ---------------------------------------------------------------------------

def tracks_path(cfg: Config) -> Path:
    return cfg.selected_dir.parent / TRACKS_FILE


def load_tracks(cfg: Config) -> dict:
    p = tracks_path(cfg)
    data = None
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8-sig"))
        except Exception:
            data = None
    if not isinstance(data, dict):
        data = {}
    data.setdefault("version", TRACKS_VERSION)
    data.setdefault("tracks", {})
    ids = [int(t) for t in data["tracks"] if str(t).isdigit()]
    data["next_id"] = max(int(data.get("next_id") or 1), (max(ids) + 1) if ids else 1)
    return data


def save_tracks(cfg: Config, data: dict) -> None:
    _atomic_write_json(tracks_path(cfg), data)


def new_track_id(cfg: Config) -> int:
    """Зарезервувати номер нового треку (сам трек з'явиться при збереженні кадру)."""
    with _LOCK:
        data = load_tracks(cfg)
        tid = data["next_id"]
        data["next_id"] = tid + 1
        save_tracks(cfg, data)
        return tid


# ---------------------------------------------------------------------------
# Геометрія: ресемплінг та інтерполяція контурів
# ---------------------------------------------------------------------------

def _signed_area(pts) -> float:
    a = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i - 1]
        x2, y2 = pts[i]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def _resample(pts, n: int) -> list:
    """Замкнений контур → n точок, рівномірно за довжиною дуги."""
    pts = [(float(x), float(y)) for x, y in pts]
    segs = []
    total = 0.0
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        segs.append((a, b, d))
        total += d
    if total <= 0:
        return [list(pts[0])] * n
    out = []
    step = total / n
    seg_i, acc = 0, 0.0
    for k in range(n):
        target = k * step
        while seg_i < len(segs) - 1 and acc + segs[seg_i][2] < target:
            acc += segs[seg_i][2]
            seg_i += 1
        a, b, d = segs[seg_i]
        t = 0.0 if d == 0 else (target - acc) / d
        out.append([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    return out


def _align(a: list, b: list) -> list:
    """Повернути b (однаковий напрямок обходу з a + найкращий зсув старту)."""
    if (_signed_area(a) > 0) != (_signed_area(b) > 0):
        b = b[::-1]
    n = len(a)
    best, best_k = None, 0
    for k in range(n):
        s = 0.0
        for i in range(n):
            q = b[(i + k) % n]
            s += (a[i][0] - q[0]) ** 2 + (a[i][1] - q[1]) ** 2
        if best is None or s < best:
            best, best_k = s, k
    return [b[(i + best_k) % n] for i in range(n)]


def interpolate(p0: list, p1: list, t: float) -> list:
    """Проміжна форма між двома контурами (t: 0 → p0, 1 → p1)."""
    n = max(len(p0), len(p1), 8)
    a = _resample(p0, n)
    b = _align(a, _resample(p1, n))
    return [[round(a[i][0] + (b[i][0] - a[i][0]) * t, 3),
             round(a[i][1] + (b[i][1] - a[i][1]) * t, 3)] for i in range(n)]


def shape_at(track: dict, frames: list[str], stem: str) -> Optional[list]:
    """Контур треку на кадрі stem (None — трека тут нема)."""
    if stem not in frames:
        return None
    order = {s: i for i, s in enumerate(frames)}
    kfs = sorted((order[s], s, kf) for s, kf in (track.get("keyframes") or {}).items() if s in order)
    f = order[stem]
    prev = next_ = None
    for item in kfs:
        if item[0] <= f:
            prev = item
        elif next_ is None:
            next_ = item
    if prev is None or prev[2].get("outside"):
        return None
    p0 = prev[2]["points"]
    if prev[0] == f or next_ is None or next_[2].get("outside"):
        return [list(p) for p in p0]
    t = (f - prev[0]) / (next_[0] - prev[0])
    return interpolate(p0, next_[2]["points"], t)


def _same_points(a, b) -> bool:
    if a is None or b is None or len(a) != len(b):
        return False
    return all(abs(float(p[0]) - float(q[0])) <= EPS and abs(float(p[1]) - float(q[1])) <= EPS
               for p, q in zip(a, b))


# ---------------------------------------------------------------------------
# Запис кадрів
# ---------------------------------------------------------------------------

def _read_frame(cfg: Config, stem: str) -> dict:
    p = _polygons_path(cfg.polygons_dir, stem)
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("shapes"), list):
                return data
        except Exception:
            pass
    H = W = 0
    arr = _load_original_image_array(cfg.images_dir, stem)
    if arr is not None:
        H, W = int(arr.shape[0]), int(arr.shape[1])
    return _labelme_envelope(stem, _find_image_filename(cfg.images_dir, stem), H, W, [])


def _remap_groups_after_delete(cfg: Config, stem: str, removed: int) -> None:
    if not cfg.groups_dir or not _groups_path(cfg.groups_dir, stem).exists():
        return
    env = _read_groups(cfg.groups_dir, stem)
    changed = False
    for g in env.get("groups") or []:
        pis = [int(i) for i in (g.get("polygon_indices") or [])]
        new = sorted({(i - 1 if i > removed else i) for i in pis if i != removed})
        if new != pis:
            g["polygon_indices"] = new
            changed = True
    if changed:
        _write_groups(cfg.groups_dir, stem, env)


def _ensure_stem_state(state: StateStore, stem: str) -> None:
    """Кадр отримав полігони треку: без стану → «manual», інакше лише dirty."""
    if state.get(stem) is None:
        state.set(stem, {"status": "selected", "model": MANUAL_MODEL, "ts": _utc_iso(),
                         "user": "tracks", "dirty": True})
    else:
        state.mark_dirty(stem)


def materialize(cfg: Config, state: StateStore, tid: str, track: Optional[dict],
                skip_stem: Optional[str] = None, frames: Optional[list] = None) -> list[str]:
    """
    Привести полігон треку tid на кожному кадрі серії до розрахункової форми
    (track=None — прибрати трек звідусіль). Повертає змінені stem-и.
    """
    if frames is None:
        series = (track or {}).get("series")
        frames = series_frames(cfg, series) if series is not None else []
    changed = []
    for stem in frames:
        if stem == skip_stem:
            continue
        want = shape_at(track, frames, stem) if track else None
        env = _read_frame(cfg, stem)
        shapes = env["shapes"]
        idx = next((i for i, sh in enumerate(shapes)
                    if str((sh.get("flags") or {}).get("track_id")) == str(tid)), None)
        is_kf = bool(track) and stem in (track.get("keyframes") or {})
        if want is None:
            if idx is None:
                continue
            shapes.pop(idx)
            _remap_groups_after_delete(cfg, stem, idx)
        else:
            flags = {**((shapes[idx].get("flags") or {}) if idx is not None else {}),
                     "track_id": int(tid), "keyframe": is_kf}
            new_sh = {"label": track.get("label") or "nucleus", "points": want,
                      "shape_type": "polygon",
                      "group_id": shapes[idx].get("group_id") if idx is not None else None,
                      "flags": flags}
            if idx is not None:
                old = shapes[idx]
                if (_same_points(old.get("points"), want) and old.get("label") == new_sh["label"]
                        and (old.get("flags") or {}) == flags):
                    continue
                shapes[idx] = new_sh
            else:
                shapes.append(new_sh)
        _write_polygons_json(cfg.polygons_dir, stem, env)
        _ensure_stem_state(state, stem)
        changed.append(stem)
    return changed


# ---------------------------------------------------------------------------
# Синхронізація зі збереженим кадром
# ---------------------------------------------------------------------------

def sync_frame(cfg: Config, state: StateStore, stem: str, shapes: list) -> dict:
    """Див. докстрінг модуля. Повертає {tracks: [tid…], frames: [stem…]}."""
    with _LOCK:
        data = load_tracks(cfg)
        tracks = data["tracks"]
        series, _ = series_of(stem)
        frames = series_frames(cfg, series)
        present = {}
        for sh in shapes or []:
            tid = (sh.get("flags") or {}).get("track_id")
            if tid is None or str(tid) in present:
                continue
            present[str(tid)] = sh
        touched = set()
        for tid, sh in present.items():
            pts = [[float(p[0]), float(p[1])] for p in sh.get("points") or []]
            if len(pts) < 3:
                continue
            tr = tracks.get(tid)
            if tr is None:                                   # новий трек
                tracks[tid] = {"label": sh.get("label") or "nucleus", "series": series,
                               "keyframes": {stem: {"points": pts, "outside": False}}}
                data["next_id"] = max(data["next_id"], int(tid) + 1)
                touched.add(tid)
                continue
            if tr.get("series") != series:
                continue                                     # чужа серія — ігнор
            expected = shape_at(tr, frames, stem)
            label_changed = (sh.get("label") or tr.get("label")) != tr.get("label")
            if label_changed:
                tr["label"] = sh.get("label")
                touched.add(tid)
            if not _same_points(expected, pts):
                tr["keyframes"][stem] = {"points": pts, "outside": False}
                touched.add(tid)
        # Полігон треку зник з кадру → трек «вийшов» (outside) з цього кадру.
        for tid, tr in tracks.items():
            if tid in present or tr.get("series") != series:
                continue
            if shape_at(tr, frames, stem) is not None:
                tr["keyframes"][stem] = {"points": [], "outside": True}
                touched.add(tid)
        if touched:
            save_tracks(cfg, data)
        # Кадр з полігонами треку без стану (розмічали з картки «Оригінал») → «manual»,
        # як і решта кадрів треку, інакше він випаде з запікання / фінального датасету.
        if present and state.get(stem) is None:
            _ensure_stem_state(state, stem)
        rewritten = set()
        for tid in touched:
            rewritten.update(materialize(cfg, state, tid, tracks[tid], skip_stem=stem, frames=frames))
        return {"tracks": sorted(touched, key=int), "frames": sorted(rewritten)}


# ---------------------------------------------------------------------------
# Undo серверних операцій (split / merge / delete): знімок файлів до операції
# ---------------------------------------------------------------------------
# Зберігається в пам'яті сервера (як і undo-історія редактора — до перезапуску).
# Фронт кладе undo_id у глобальну історію: Ctrl+Z → restore, Ctrl+Shift+Z →
# повтор операції (новий undo_id).

_UNDO: dict = {}
_UNDO_ORDER: list = []
_UNDO_CAP = 30


def _snapshot(cfg: Config, state: StateStore, frames: list) -> str:
    def _read(p: Path):
        return p.read_text(encoding="utf-8") if p.exists() else None
    snap = {
        "tracks": _read(tracks_path(cfg)),
        "frames": {s: {"polygons": _read(_polygons_path(cfg.polygons_dir, s)),
                       "groups": _read(_groups_path(cfg.groups_dir, s)) if cfg.groups_dir else None,
                       "state": state.get(s)} for s in frames},
    }
    uid = f"u{len(_UNDO_ORDER)}_{id(snap)}"
    _UNDO[uid] = snap
    _UNDO_ORDER.append(uid)
    while len(_UNDO_ORDER) > _UNDO_CAP:
        _UNDO.pop(_UNDO_ORDER.pop(0), None)
    return uid


def undo_op(cfg: Config, state: StateStore, uid: str) -> dict:
    """Повернути файли/стан, зняті перед операцією uid."""
    with _LOCK:
        snap = _UNDO.pop(uid, None)
        if snap is None:
            raise KeyError("цю операцію вже не можна скасувати (сервер перезапускався?)")

        def _write(p: Path, text):
            if text is None:
                if p.exists():
                    p.unlink()
            else:
                p.parent.mkdir(parents=True, exist_ok=True)
                _atomic_write_json(p, json.loads(text))
        _write(tracks_path(cfg), snap["tracks"])
        for s, f in snap["frames"].items():
            _write(_polygons_path(cfg.polygons_dir, s), f["polygons"])
            if cfg.groups_dir:
                _write(_groups_path(cfg.groups_dir, s), f["groups"])
            if f["state"] is None:
                if state.get(s) is not None:
                    state.remove(s)
            else:
                state.set(s, f["state"])
        return {"frames": sorted(snap["frames"])}


# ---------------------------------------------------------------------------
# Операції над треками (перезаписують і поточний кадр — фронт перезавантажує його)
# ---------------------------------------------------------------------------

def split_track(cfg: Config, state: StateStore, tid: str, stem: str) -> dict:
    """Від кадру stem (включно) — новий трек; старий закінчується перед stem."""
    with _LOCK:
        data = load_tracks(cfg)
        tr = data["tracks"].get(str(tid))
        if tr is None:
            raise KeyError(f"трек {tid} не знайдено")
        frames = series_frames(cfg, tr["series"])
        if stem not in frames:
            raise ValueError("кадр не належить серії треку")
        cur = shape_at(tr, frames, stem)
        if cur is None:
            raise ValueError("на цьому кадрі трека немає")
        uid = _snapshot(cfg, state, frames)
        order = {s: i for i, s in enumerate(frames)}
        f = order[stem]
        new_id = str(data["next_id"])
        data["next_id"] += 1
        tail = {s: kf for s, kf in tr["keyframes"].items() if order.get(s, -1) >= f}
        tail.setdefault(stem, {"points": cur, "outside": False})
        tr["keyframes"] = {s: kf for s, kf in tr["keyframes"].items() if order.get(s, -1) < f}
        tr["keyframes"][stem] = {"points": [], "outside": True}
        data["tracks"][new_id] = {"label": tr["label"], "series": tr["series"], "keyframes": tail}
        save_tracks(cfg, data)
        rewritten = set(materialize(cfg, state, str(tid), tr, frames=frames))
        rewritten.update(materialize(cfg, state, new_id, data["tracks"][new_id], frames=frames))
        return {"new_track_id": int(new_id), "frames": sorted(rewritten), "undo_id": uid}


def merge_tracks(cfg: Config, state: StateStore, into: str, src: str) -> dict:
    """Трек src вливається в into: ключові кадри src додаються, де into їх нема."""
    with _LOCK:
        data = load_tracks(cfg)
        a, b = data["tracks"].get(str(into)), data["tracks"].get(str(src))
        if a is None or b is None:
            raise KeyError("трек не знайдено")
        if str(into) == str(src):
            raise ValueError("це той самий трек")
        if a["series"] != b["series"]:
            raise ValueError("треки з різних серій не можна злити")
        frames = series_frames(cfg, a["series"])
        uid = _snapshot(cfg, state, frames)
        order = {s: i for i, s in enumerate(frames)}
        # Кадри, де видно src, стають ключовими для into (крім уже ключових into).
        for s in frames:
            pts = shape_at(b, frames, s)
            if pts is not None and s not in a["keyframes"] and shape_at(a, frames, s) is None:
                a["keyframes"][s] = {"points": pts, "outside": False}
        # outside-ключі into, після яких іде видимий src — прибрати, щоб не обривали трек.
        for s, kf in list(a["keyframes"].items()):
            if kf.get("outside") and s in order and shape_at(b, frames, s) is not None:
                a["keyframes"][s] = {"points": shape_at(b, frames, s), "outside": False}
        del data["tracks"][str(src)]
        save_tracks(cfg, data)
        rewritten = set(materialize(cfg, state, str(src), None, frames=frames))
        rewritten.update(materialize(cfg, state, str(into), a, frames=frames))
        return {"frames": sorted(rewritten), "undo_id": uid}


def delete_track(cfg: Config, state: StateStore, tid: str) -> dict:
    with _LOCK:
        data = load_tracks(cfg)
        tr = data["tracks"].get(str(tid))
        if tr is None:
            raise KeyError(f"трек {tid} не знайдено")
        frames = series_frames(cfg, tr["series"])
        uid = _snapshot(cfg, state, frames)
        del data["tracks"][str(tid)]
        save_tracks(cfg, data)
        return {"frames": sorted(materialize(cfg, state, str(tid), None, frames=frames)), "undo_id": uid}


# ---------------------------------------------------------------------------
# Експорт: MOT (одна таблиця на серію)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Таймлайн (як у CVAT): кадри серії + смуги треків
# ---------------------------------------------------------------------------

def _cell(track: dict, order: dict, stem: str) -> str:
    """Клітинка таймлайна: 'k' ключовий кадр, 'o' outside-ключ, 'v' видно (копія /
    інтерполяція), '' — трека на кадрі нема. Без обчислення контурів (дешево)."""
    kfs = track.get("keyframes") or {}
    if stem in kfs:
        return "o" if kfs[stem].get("outside") else "k"
    f = order[stem]
    prev = None
    for s, kf in kfs.items():
        if s in order and order[s] < f and (prev is None or order[s] > order[prev[0]]):
            prev = (s, kf)
    return "v" if prev is not None and not prev[1].get("outside") else ""


def timeline(cfg: Config, state: StateStore, stem: str, with_shapes: bool = False) -> dict:
    """Дані таймлайна для серії фото `stem`: кадри (к-сть полігонів, стан) і рядки треків.
    with_shapes — ще й контури полігонів кожного кадру (для миттєвого перегляду при протягуванні
    повзунка кадрів: фронт показує їх із пам'яті, не відкриваючи кожен кадр)."""
    series, _ = series_of(stem)
    frames = series_frames(cfg, series) or [stem]
    if stem not in frames:
        frames = [stem]
    order = {s: i for i, s in enumerate(frames)}
    out_frames = []
    for s in frames:
        n = nt = 0
        shapes = []
        p = _polygons_path(cfg.polygons_dir, s) if cfg.polygons_dir else None
        if p is not None and p.exists():
            try:
                shapes = json.loads(p.read_text(encoding="utf-8")).get("shapes") or []
                n = len(shapes)
                nt = sum(1 for sh in shapes if (sh.get("flags") or {}).get("track_id") is not None)
            except Exception:
                shapes = []
        st = state.get(s) or {}
        fr = {"stem": s, "num": series_of(s)[1], "polygons": n, "tracked": nt,
              "status": st.get("status") or "", "dirty": bool(st.get("dirty"))}
        if with_shapes:
            fr["shapes"] = [{"label": sh.get("label"), "points": sh.get("points") or [],
                             "track_id": (sh.get("flags") or {}).get("track_id")}
                            for sh in shapes if isinstance(sh, dict)]
        out_frames.append(fr)
    rows = []
    with _LOCK:
        data = load_tracks(cfg)
    for tid, tr in sorted(data["tracks"].items(), key=lambda kv: int(kv[0])):
        if tr.get("series") != series:
            continue
        cells = [_cell(tr, order, s) for s in frames]
        if any(cells):
            rows.append({"id": int(tid), "label": tr.get("label"), "cells": cells})
    return {"series": series, "frames": out_frames, "tracks": rows}


def mot_lines(cfg: Config, stems: Optional[set] = None) -> dict[str, list[str]]:
    """
    MOT-формат з матеріалізованих полігонів: `кадр,трек,x,y,w,h,1,-1,-1,-1`
    (bbox полігона). Повертає {серія: [рядки]}; кадр = номер у назві фото.
    """
    out: dict[str, list[str]] = {}
    if not cfg.polygons_dir or not cfg.polygons_dir.exists():
        return out
    for p in sorted(cfg.polygons_dir.glob("*.json")):
        stem = p.stem
        if stems is not None and stem not in stems:
            continue
        try:
            env = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        series, n = series_of(stem)
        for sh in env.get("shapes") or []:
            tid = (sh.get("flags") or {}).get("track_id")
            pts = sh.get("points") or []
            if tid is None or len(pts) < 3:
                continue
            xs = [float(q[0]) for q in pts]
            ys = [float(q[1]) for q in pts]
            out.setdefault(series, []).append(
                f"{n},{int(tid)},{min(xs):.2f},{min(ys):.2f},"
                f"{max(xs) - min(xs):.2f},{max(ys) - min(ys):.2f},1,-1,-1,-1")
    for k in out:
        out[k].sort(key=lambda ln: (int(ln.split(",")[0]), int(ln.split(",")[1])))
    return out
