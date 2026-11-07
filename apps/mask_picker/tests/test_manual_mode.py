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
    assert (cfg.output_root / MANUAL_MODEL / "overlay" / f"{STEM}.jpg").exists()


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
