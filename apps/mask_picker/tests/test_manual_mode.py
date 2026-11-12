"""
Ручна розмітка (псевдо-модель «manual»): доступна для будь-якого фото, навіть
без виходу сегментації; порожня маска створюється ліниво, а далі полігони
запікаються тим самим bake-пайплайном, що й для звичайних моделей.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from app import create_app  # noqa: E402
from state import (  # noqa: E402
    MANUAL_MODEL, Config, ManualModelSource, StateStore, _discover_models,
)
from baking import POLYGON_ID_BASE  # noqa: E402

STEM = "img_manual"
W, H = 80, 60


def _workspace(tmp_path: Path, with_model: bool = False) -> Config:
    ws = tmp_path / "ws"
    images = ws / "images"
    images.mkdir(parents=True)
    Image.new("RGB", (W, H), (40, 40, 40)).save(images / f"{STEM}.jpg")
    output = ws / "output"
    output.mkdir()
    if with_model:
        ov = output / "cyto2" / "overlay"
        ov.mkdir(parents=True)
        Image.new("RGB", (W, H)).save(ov / f"{STEM}.png")
    cfg = Config(
        images_dir=images,
        output_root=output,
        selected_dir=ws / "selected",
        skipped_dir=ws / "skipped",
        polygons_dir=ws / "polygons",
        groups_dir=ws / "groups",
        workspace_dir=ws,
        labels_file=ws / "labels.json",
        group_classes_file=ws / "group_classes.json",
    )
    for d in (cfg.selected_dir, cfg.skipped_dir, cfg.polygons_dir, cfg.groups_dir):
        d.mkdir(parents=True)
    cfg.models = _discover_models(cfg.output_root, cfg.images_dir)
    return cfg


@pytest.fixture
def client_cfg(tmp_path):
    cfg = _workspace(tmp_path)
    state = StateStore(cfg.selected_dir.parent / "selections.json")
    app = create_app(cfg, state)
    return app.test_client(), cfg


def test_manual_model_always_discovered(tmp_path):
    cfg = _workspace(tmp_path, with_model=True)
    names = [m.name for m in cfg.models]
    assert names == ["cyto2", MANUAL_MODEL]          # manual — завжди останній
    assert isinstance(cfg.models[-1], ManualModelSource)
    # Матеріалізована папка output/manual не дублює модель при повторному discovery.
    cfg.models[-1].ensure_base(STEM)
    assert [m.name for m in _discover_models(cfg.output_root, cfg.images_dir)] == ["cyto2", MANUAL_MODEL]


def test_catalog_offers_manual_for_photo_without_model_output(client_cfg):
    client, cfg = client_cfg
    items = client.get("/api/catalog?fresh=1").get_json()["items"]
    assert [it["available_models"] for it in items] == [[MANUAL_MODEL]]
    # До вибору картка показує оригінал, нічого не створюючи на диску.
    r = client.get(f"/api/overlay/{MANUAL_MODEL}/{STEM}")
    assert r.status_code == 200
    assert not (cfg.output_root / MANUAL_MODEL).exists()


def test_select_manual_creates_empty_base(client_cfg):
    client, cfg = client_cfg
    r = client.post("/api/select", json={"stem": STEM, "model": MANUAL_MODEL})
    assert r.status_code == 200, r.get_json()
    raw = np.load(cfg.output_root / MANUAL_MODEL / "npy" / f"{STEM}.npy")
    assert raw.shape == (H, W) and not raw.any()
    assert (cfg.selected_dir / MANUAL_MODEL / "npy" / f"{STEM}.npy").exists()
    # overlay завжди PNG (інакше у selected/manual/overlay було б 2 файли: .jpg і .png після bake)
    assert (cfg.output_root / MANUAL_MODEL / "overlay" / f"{STEM}.png").exists()
    assert not (cfg.output_root / MANUAL_MODEL / "overlay" / f"{STEM}.jpg").exists()


def test_manual_polygons_bake_into_mask(client_cfg):
    client, cfg = client_cfg
    client.post("/api/select", json={"stem": STEM, "model": MANUAL_MODEL})
    shapes = [{
        "label": "nucleus", "shape_type": "polygon", "group_id": None, "flags": {},
        "points": [[10, 10], [30, 10], [30, 30], [10, 30]],
    }]
    r = client.post(f"/api/polygons-export/{STEM}", json={
        "model": MANUAL_MODEL, "shapes": shapes,
        "imageHeight": H, "imageWidth": W,
    })
    body = r.get_json()
    assert r.status_code == 200, body
    assert body["baked"] is True and body["baked_count"] == 1
    baked = np.load(cfg.selected_dir / MANUAL_MODEL / "npy" / f"{STEM}.npy")
    assert set(np.unique(baked)) == {0, POLYGON_ID_BASE}
    assert baked[20, 20] == POLYGON_ID_BASE and baked[50, 70] == 0


def test_manual_npy_created_lazily_for_imported_stem(client_cfg):
    """Після імпорту чужого workspace selections.json може вже мати model=manual,
    а output/manual ще нема — пошук npy (bake/finalize) створить порожню маску сам."""
    _, cfg = client_cfg
    from cleanup import _find_npy_for
    m = next(mm for mm in cfg.models if mm.name == MANUAL_MODEL)
    p = _find_npy_for(m, STEM)
    assert p is not None and p.exists()


LABELS = [{"id": 1, "name": "nucleus", "color": "#4488ff", "shortcut": "1"},
          {"id": 2, "name": "vesicle", "color": "#ff8844", "shortcut": "2"}]


def _import(client, data: bytes, name: str) -> dict:
    import io
    scan = client.post("/api/workspace/import-scan", data={"files": (io.BytesIO(data), name)},
                       content_type="multipart/form-data").get_json()
    src = scan["sources"][0]
    return client.post("/api/workspace/import-apply", json={
        "scan_id": scan["scan_id"], "picks": [{"idx": src["idx"], "stems": src["stems"]}]}).get_json()


def test_export_carries_classes_and_import_appends_missing(client_cfg, tmp_path):
    """Експорт кладе labels.json + group_classes.json; імпорт у датасет з іншими
    класами ДОПИСУЄ бракуючі в кінець (порядок наявних = семантичний контракт)."""
    import io, json, zipfile
    client, cfg = client_cfg
    client.post("/api/labels", json=LABELS)
    cfg.group_classes_file.write_text('{"version": 1, "classes": []}', encoding="utf-8")
    client.post("/api/select", json={"stem": STEM, "model": MANUAL_MODEL})
    client.post(f"/api/polygons/{STEM}", json={"shapes": [{
        "label": "vesicle", "shape_type": "polygon", "group_id": None, "flags": {},
        "points": [[5, 5], [15, 5], [15, 15], [5, 15]]}], "imageHeight": H, "imageWidth": W})
    data = client.get("/api/workspace/export").data
    names = zipfile.ZipFile(io.BytesIO(data)).namelist()
    assert "labels.json" in names and "group_classes.json" in names

    other = _workspace(tmp_path / "other")
    other.labels_file.write_text(json.dumps([LABELS[0], {"id": 2, "name": "debris"}]), encoding="utf-8")
    c2 = create_app(other, StateStore(other.selected_dir.parent / "selections.json")).test_client()
    resp = _import(c2, data, "export.zip")
    assert resp["ok"] and resp["labels_added"] == ["vesicle"]
    assert [c["name"] for c in json.loads(other.labels_file.read_text())] == ["nucleus", "debris", "vesicle"]
    assert other.group_classes_file.exists()


def test_split_pack_keeps_groups(client_cfg):
    """Пакет Split містить groups/<stem>.json і group_classes.json (раніше губились)."""
    import io, json, zipfile
    from pathlib import Path as _P
    client, cfg = client_cfg
    Image.new("RGB", (W, H)).save(cfg.images_dir / "second.jpg")
    cfg.group_classes_file.write_text('{"version": 1, "classes": []}', encoding="utf-8")
    cfg.groups_dir.joinpath(f"{STEM}.json").write_text(json.dumps(
        {"version": "1.1", "stem": STEM, "model": MANUAL_MODEL, "groups": []}), encoding="utf-8")
    sp = client.post("/api/workspace/split", json={"n": 2}).get_json()
    assert sp.get("ok"), sp
    names = []
    for z in sp["zips"]:
        names += zipfile.ZipFile(_P(sp["out_dir"]) / _P(z).name).namelist()
    assert any(n.endswith(f"groups/{STEM}.json") for n in names), names
    assert any(n.endswith("group_classes.json") for n in names)



def test_export_with_photos_opens_in_empty_dataset(tmp_path):
    """Галочка «📷 Додати фото» (?images=1): архів містить фото + сирий вихід обраної
    моделі; імпорт у ПОРОЖНІЙ датасет (без фото) → фото видно, обидва запікаються."""
    import io, zipfile
    src = _workspace(tmp_path / "src", with_model=True)
    lab = np.zeros((H, W), np.int32); lab[10:30, 10:30] = 1
    (src.output_root / "cyto2" / "npy").mkdir()
    np.save(src.output_root / "cyto2" / "npy" / f"{STEM}.npy", lab)
    Image.new("RGB", (W, H)).save(src.images_dir / "only_manual.jpg")
    src.models = _discover_models(src.output_root, src.images_dir)
    c1 = create_app(src, StateStore(src.selected_dir.parent / "selections.json")).test_client()
    c1.post("/api/select", json={"stem": STEM, "model": "cyto2"})
    c1.post("/api/select", json={"stem": "only_manual", "model": MANUAL_MODEL})
    shape = {"label": "nucleus", "shape_type": "polygon", "group_id": None, "flags": {},
             "points": [[40, 40], [60, 40], [60, 55], [40, 55]]}
    for s in (STEM, "only_manual"):
        c1.post(f"/api/polygons/{s}", json={"shapes": [shape], "imageHeight": H, "imageWidth": W})

    plain = zipfile.ZipFile(io.BytesIO(c1.get("/api/workspace/export").data)).namelist()
    assert not any(n.startswith(("images/", "output/")) for n in plain)
    data = c1.get(f"/api/workspace/export?stems={STEM},only_manual&images=1").data
    names = zipfile.ZipFile(io.BytesIO(data)).namelist()
    assert f"images/{STEM}.jpg" in names and "images/only_manual.jpg" in names
    assert f"output/cyto2/npy/{STEM}.npy" in names and f"output/cyto2/overlay/{STEM}.png" in names
    assert not any(n.startswith("output/manual/") for n in names)   # основу відтворить ensure_base

    dst = _workspace(tmp_path / "dst")
    for p in dst.images_dir.iterdir():
        p.unlink()                                                    # порожній датасет
    dst.models = _discover_models(dst.output_root, dst.images_dir)
    st2 = StateStore(dst.selected_dir.parent / "selections.json")
    c2 = create_app(dst, st2).test_client()
    resp = _import(c2, data, "export.zip")
    assert resp["ok"] and resp["merged_count"] == 2, resp
    items = {i["stem"]: i["available_models"] for i in c2.get("/api/catalog?fresh=1").get_json()["items"]}
    assert items == {STEM: ["cyto2", MANUAL_MODEL], "only_manual": [MANUAL_MODEL]}
    for s, model in ((STEM, "cyto2"), ("only_manual", MANUAL_MODEL)):
        r = c2.post(f"/api/polygons-export/{s}", json={
            "model": model, "shapes": [shape], "imageHeight": H, "imageWidth": W})
        body = r.get_json()
        assert r.status_code == 200 and body["baked"], (s, body)
