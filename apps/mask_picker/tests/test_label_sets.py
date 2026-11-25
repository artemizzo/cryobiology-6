"""
Набори класів на фото (label_sets.py): класи вписуються на кожен імпорт і діють лише для
його фото; labels.json лишається глобальним реєстром (порядок не змінюється, нові — в кінець);
набори їдуть в експорті, при імпорті архіву пропонуються саме його класи (не весь labels.json).
"""
from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path

import pytest
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from app import create_app  # noqa: E402
from state import Config, StateStore, _discover_models  # noqa: E402
import label_sets as LS  # noqa: E402


def make_ws(root: Path, stems):
    (root / "images").mkdir(parents=True)
    for s in stems:
        Image.new("RGB", (64, 64)).save(root / "images" / f"{s}.jpg")
    cfg = Config(images_dir=root / "images", output_root=root / "output",
                 selected_dir=root / "selected", skipped_dir=root / "skipped",
                 polygons_dir=root / "polygons", groups_dir=root / "groups",
                 workspace_dir=root, labels_file=root / "labels.json",
                 group_classes_file=root / "group_classes.json")
    for d in (cfg.output_root, cfg.selected_dir, cfg.skipped_dir, cfg.polygons_dir, cfg.groups_dir):
        d.mkdir()
    cfg.models = _discover_models(cfg.output_root, cfg.images_dir)
    (root / "labels.json").write_text(json.dumps([
        {"id": 1, "name": "nucleus", "color": "#4488ff", "shortcut": "1"},
        {"id": 2, "name": "vesicle", "color": "#ff8844", "shortcut": "2"}]))
    return create_app(cfg, StateStore(root / "selections.json")).test_client(), cfg


def zip_of(files: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


def jpg() -> bytes:
    b = io.BytesIO()
    Image.new("RGB", (64, 64)).save(b, "JPEG")
    return b.getvalue()


def do_import(client, data):
    scan = client.post("/api/workspace/import-scan", data={"files": (io.BytesIO(data), "x.zip")},
                       content_type="multipart/form-data").get_json()
    assert scan.get("ok"), scan
    src = scan["sources"][0]
    return client.post("/api/workspace/import-apply", json={
        "scan_id": scan["scan_id"], "picks": [{"idx": src["idx"], "stems": src["stems"]}]}).get_json()


def names(cfg):
    return [c["name"] for c in json.loads(cfg.labels_file.read_text())]


def test_assign_per_import_and_registry_order(tmp_path):
    client, cfg = make_ws(tmp_path / "ws", ["a_1"])
    # імпорт «просто фото» → вікно класів стартує порожнім
    r = do_import(client, zip_of({"p/b_1.jpg": jpg(), "p/b_2.jpg": jpg()}))
    assert r["ok"] and sorted(r["merged_stems"]) == ["b_1", "b_2"]
    assert r["archive_labels"] == []
    # людина вписала класи на цей імпорт
    a = client.post("/api/label-sets", json={"stems": r["merged_stems"], "labels": ["mito", "nucleus"]}).get_json()
    assert a["ok"] and a["labels_added"] == ["mito"]
    assert names(cfg) == ["nucleus", "vesicle", "mito"]      # порядок наявних не змінився, нове — в кінець
    sets = client.get("/api/label-sets").get_json()["stems"]
    assert sets["b_1"] == ["mito", "nucleus"] and sets["b_2"] == ["mito", "nucleus"]
    # старе фото a_1 закріпило класи, що були ДО імпорту (без «mito»)
    assert sets["a_1"] == ["nucleus", "vesicle"]
    # наступний імпорт — свій набір, попередній не «перетікає»
    r2 = do_import(client, zip_of({"c_1.jpg": jpg()}))
    assert r2["archive_labels"] == []
    client.post("/api/label-sets", json={"stems": r2["merged_stems"], "labels": ["junk"]})
    sets = client.get("/api/label-sets").get_json()["stems"]
    assert sets["c_1"] == ["junk"] and sets["b_1"] == ["mito", "nucleus"]
    # порожній список — помилка
    assert client.post("/api/label-sets", json={"stems": ["c_1"], "labels": []}).status_code == 400


def test_rename_updates_sets(tmp_path):
    client, cfg = make_ws(tmp_path / "ws", ["a_1"])
    LS.assign(cfg, ["a_1"], ["mito"])
    r = client.post("/api/labels/rename", json={"renames": [{"from": "mito", "to": "mitochondria"}]}).get_json()
    assert r["ok"] and r["label_sets_changed"] == 1
    assert LS.load(cfg)["stems"]["a_1"] == ["mitochondria"]


def test_sets_travel_with_export_and_archive_prefill(tmp_path):
    client, cfg = make_ws(tmp_path / "src", ["s_1", "s_2", "old_1"])
    LS.assign(cfg, ["s_1", "s_2"], ["mito"])
    LS.assign(cfg, ["old_1"], ["ancient"])                    # клас іншого, давнього набору
    (cfg.polygons_dir / "s_2.json").write_text(json.dumps({"shapes": [
        {"label": "mito", "points": [[1, 1], [9, 1], [9, 9]], "shape_type": "polygon"}]}))
    data = client.get("/api/workspace/export?stems=s_1,s_2&images=1").data
    z = zipfile.ZipFile(io.BytesIO(data))
    assert json.loads(z.read("label_sets.json"))["stems"] == {"s_1": ["mito"], "s_2": ["mito"]}

    c2, cfg2 = make_ws(tmp_path / "dst", [])
    r = do_import(c2, data)
    assert sorted(r["merged_stems"]) == ["s_1", "s_2"]
    # вікно класів пропонує класи САМЕ цих фото, не весь labels.json архіву (без «ancient»)
    assert r["archive_labels"] == ["mito"]


def test_archive_without_sets_uses_polygon_labels(tmp_path):
    """Архів старого формату (без label_sets.json) → класи, реально вжиті в його полігонах."""
    c2, cfg2 = make_ws(tmp_path / "dst", [])
    poly = {"shapes": [{"label": "vesicle", "points": [[1, 1], [9, 1], [9, 9]], "shape_type": "polygon"}]}
    data = zip_of({"images/q_1.jpg": jpg(), "polygons/q_1.json": json.dumps(poly),
                   "labels.json": json.dumps([{"name": "nucleus"}, {"name": "vesicle"}, {"name": "ancient"}]),
                   "selections.json": json.dumps({"q_1": {"status": "selected", "model": "manual", "ts": 1}})})
    r = do_import(c2, data)
    assert r["merged_stems"] == ["q_1"] and r["archive_labels"] == ["vesicle"]
