"""
Набори класів на фото (label sets) — «які класи можна ставити на цьому фото».

Рішення мейнтейнера (2026-11-25): при кожному імпорті людина вписує класи, і САМЕ ці
класи (і лише вони) доступні в редакторі для фото з цього імпорту. Наступний імпорт —
свій список, старі класи туди не «перетікають».

- SoT: `<workspace>/label_sets.json` = {"version": 1, "stems": {"<stem>": ["nucleus", ...]}}.
- `labels.json` лишається ГЛОБАЛЬНИМ реєстром (колір, порядок = semantic class id у bake,
  контракт F-014). Нові назви з набору дописуються туди В КІНЕЦЬ — bake їх знає.
- Фото без запису в label_sets.json (старі дані) → доступні всі класи labels.json. При першому
  ж призначенні набору такі фото закріплюють класи, що були ДО нього (не бачать нових).
- Перенесення: експорт кладе набори експортованих фото, Split — теж; імпорт бере
  набори з архіву для імпортованих фото і показує їх у вікні класів (людина підтверджує).
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Iterable, Optional

from state import IMAGE_EXTS, Config, _atomic_write_json, _load_label_classes, _save_label_classes

_LOCK = threading.RLock()
FILE_NAME = "label_sets.json"
_COLORS = ["#4488ff", "#ff6644", "#44cc88", "#cc44ff", "#ffcc44",
           "#44ccff", "#ff4488", "#88cc44", "#ff8844"]


def path_for(cfg: Config) -> Path:
    return cfg.selected_dir.parent / FILE_NAME


def _clean_names(names: Iterable) -> list[str]:
    out: list[str] = []
    for n in names or []:
        n = str(n or "").strip()
        if n and n not in out:
            out.append(n)
    return out


def load_file(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return {"version": 1, "stems": {}}
    stems = data.get("stems") if isinstance(data, dict) else None
    if not isinstance(stems, dict):
        stems = {}
    return {"version": 1,
            "stems": {str(k): _clean_names(v) for k, v in stems.items() if isinstance(v, list)}}


def load(cfg: Config) -> dict:
    return load_file(path_for(cfg))


def ensure_in_registry(cfg: Config, names: Iterable[str]) -> list[str]:
    """Дописати в labels.json (у кінець) назви, яких там ще нема. Повертає додані."""
    if not cfg.labels_file:
        return []
    local = _load_label_classes(cfg.labels_file)
    known = {c.get("name") for c in local}
    added = []
    for n in _clean_names(names):
        if n in known:
            continue
        used = {str(c.get("shortcut") or "") for c in local}
        sc = next((d for d in "123456789" if d not in used), "")
        local.append({"id": f"lbl_{len(local) + 1}_{n}", "name": n,
                      "color": _COLORS[len(local) % len(_COLORS)], "shortcut": sc})
        known.add(n)
        added.append(n)
    if added:
        _save_label_classes(cfg.labels_file, local)
    return added


def assign(cfg: Config, stems: Iterable[str], names: Iterable[str]) -> dict:
    """Призначити набір класів фото (перезаписує їхні попередні набори)."""
    names = _clean_names(names)
    stems = [str(s) for s in stems or [] if s]
    if not names:
        raise ValueError("потрібен хоча б один клас")
    with _LOCK:
        data = load(cfg)
        # Фото без набору (імпортовані до цієї функції) закріплюють класи, які були
        # ДО цього імпорту, — інакше нові класи «перетекли» б і на них.
        if cfg.labels_file and cfg.images_dir and cfg.images_dir.exists():
            before = [c.get("name") for c in _load_label_classes(cfg.labels_file) if c.get("name")]
            new_set = set(stems)
            for p in cfg.images_dir.iterdir():
                if (p.is_file() and p.suffix.lower() in IMAGE_EXTS
                        and p.stem not in new_set and p.stem not in data["stems"] and before):
                    data["stems"][p.stem] = list(before)
        added = ensure_in_registry(cfg, names)
        for s in stems:
            data["stems"][s] = list(names)
        _atomic_write_json(path_for(cfg), data)
    return {"stems": len(stems), "labels": names, "labels_added": added}


def rename(cfg: Config, renames: dict) -> int:
    """Перейменування класу (Labels-менеджер) — і в наборах. Повертає к-сть змінених фото."""
    if not renames:
        return 0
    with _LOCK:
        data = load(cfg)
        changed = 0
        for s, names in data["stems"].items():
            new = _clean_names(renames.get(n, n) for n in names)
            if new != names:
                data["stems"][s] = new
                changed += 1
        if changed:
            _atomic_write_json(path_for(cfg), data)
    return changed


def subset(cfg: Config, stems: Optional[Iterable[str]]) -> Optional[dict]:
    """Набори лише для вказаних фото (експорт). None — якщо нічого класти."""
    data = load(cfg)
    if stems is None:
        sub = data["stems"]
    else:
        wanted = set(stems)
        sub = {s: v for s, v in data["stems"].items() if s in wanted}
    return {"version": 1, "stems": sub} if sub else None


def labels_from_source(src_root: Path, stems: Iterable[str]) -> list[str]:
    """
    Класи для вікна імпорту з архіву: набори з його label_sets.json для цих фото;
    для фото без набору — класи, реально вжиті в їхніх polygons/<stem>.json.
    НЕ весь labels.json архіву (там могли бути класи з інших, давніх наборів).
    """
    stems = list(stems or [])
    out: list[str] = []
    src_sets = next(src_root.rglob(FILE_NAME), None)
    sets = load_file(src_sets)["stems"] if src_sets else {}
    for s in stems:
        if s in sets:
            out += sets[s]
            continue
        poly = next(src_root.rglob(f"polygons/{s}.json"), None)
        if poly is None:
            continue
        try:
            shapes = json.loads(poly.read_text(encoding="utf-8-sig")).get("shapes") or []
        except Exception:
            continue
        out += [sh.get("label") for sh in shapes if isinstance(sh, dict)]
    return _clean_names(out)
