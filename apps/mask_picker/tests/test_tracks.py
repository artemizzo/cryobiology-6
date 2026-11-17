"""
Треки (tracks.py): серії за назвою, інтерполяція між ключовими кадрами,
синхронізація при збереженні кадру, outside, розділення / злиття / видалення,
ремап груп, MOT-експорт.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from app import create_app  # noqa: E402
from state import MANUAL_MODEL, Config, StateStore, _discover_models  # noqa: E402
import tracks as T  # noqa: E402

W = H = 200
FR = [f"seq_1_{i:04d}" for i in range(1, 11)]          # 10 кадрів серії seq_1_


def SQ(x, y, s=20):
    return [[x, y], [x + s, y], [x + s, y + s], [x, y + s]]


def centroid(pts):
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


@pytest.fixture
def ws(tmp_path):
    images = tmp_path / "images"
    images.mkdir()
    for s in FR + ["seq_2_0001", "other"]:
        Image.new("RGB", (W, H)).save(images / f"{s}.jpg")
    cfg = Config(images_dir=images, output_root=tmp_path / "output",
                 selected_dir=tmp_path / "selected", skipped_dir=tmp_path / "skipped",
                 polygons_dir=tmp_path / "polygons", groups_dir=tmp_path / "groups",
                 workspace_dir=tmp_path, labels_file=tmp_path / "labels.json",
                 group_classes_file=tmp_path / "group_classes.json")
    for d in (cfg.output_root, cfg.selected_dir, cfg.skipped_dir, cfg.polygons_dir, cfg.groups_dir):
        d.mkdir()
    cfg.models = _discover_models(cfg.output_root, cfg.images_dir)
    st = StateStore(tmp_path / "selections.json")
    return create_app(cfg, st).test_client(), cfg, st


def shapes_of(cfg, stem):
    p = cfg.polygons_dir / f"{stem}.json"
    return json.loads(p.read_text())["shapes"] if p.exists() else []


def track_shape(cfg, stem, tid):
    return next((s for s in shapes_of(cfg, stem) if (s.get("flags") or {}).get("track_id") == tid), None)


def save(client, stem, shapes):
    r = client.post(f"/api/polygons/{stem}", json={"shapes": shapes, "imageHeight": H, "imageWidth": W})
    assert r.status_code == 200, r.get_json()
    return r.get_json()["tracks"]


def tshape(points, tid, label="nucleus"):
    return {"label": label, "points": points, "shape_type": "polygon", "group_id": None,
            "flags": {"track_id": tid}}


def test_series_and_order(ws):
    _, cfg, _ = ws
    assert T.series_of("seq_1_0012") == ("seq_1_", 12)
    assert T.series_of("other") == ("other", 0)
    assert T.series_frames(cfg, "seq_1_") == FR
    assert T.series_frames(cfg, "seq_2_") == ["seq_2_0001"]


def test_interpolation_between_contours():
    a, b = SQ(0, 0), SQ(100, 0, 20)
    mid = T.interpolate(a, b, 0.5)
    cx, cy = centroid(mid)
    assert abs(cx - 60) < 1 and abs(cy - 10) < 1
    # різна кількість точок / протилежний напрямок обходу — без «перекручування»
    c = [[0, 0], [0, 20], [20, 20], [20, 10], [20, 0]]
    m2 = T.interpolate(a, c, 0.5)
    assert abs(T._signed_area(m2)) > 300


def test_track_lifecycle(ws):
    client, cfg, st = ws
    tid = client.post("/api/tracks/new").get_json()["track_id"]
    assert tid == 1
    # 1) новий трек на кадрі 1 → копії на кадрах 2..10, кадр 1 не перезаписувався сервером
    res = save(client, FR[0], [tshape(SQ(10, 10), tid)])
    assert res["tracks"] == ["1"] and res["frames"] == FR[1:]
    for s in FR[1:]:
        sh = track_shape(cfg, s, tid)
        assert sh and sh["flags"]["keyframe"] is False and centroid(sh["points"]) == (20, 20)
        assert st.get(s)["model"] == MANUAL_MODEL and st.get(s)["dirty"]   # авто-«manual»
    assert track_shape(cfg, "seq_2_0001", tid) is None                      # інша серія — ні

    # 2) правка на кадрі 5 (+40 по x) → ключовий; 2..4 інтерпольовані; 6..10 = копія кадру 5
    pts5 = SQ(50, 10)
    res = save(client, FR[4], [tshape(pts5, tid)])
    assert "seq_1_0005" not in res["frames"]
    assert abs(centroid(track_shape(cfg, FR[2], tid)["points"])[0] - 40) < 0.5   # кадр 3: половина шляху
    assert centroid(track_shape(cfg, FR[7], tid)["points"]) == (60, 20)
    data = T.load_tracks(cfg)
    assert sorted(data["tracks"]["1"]["keyframes"]) == [FR[0], FR[4]]

    # 3) збереження без змін (матеріалізований кадр) — ключовий кадр НЕ з'являється
    save(client, FR[2], shapes_of(cfg, FR[2]))
    assert sorted(T.load_tracks(cfg)["tracks"]["1"]["keyframes"]) == [FR[0], FR[4]]

    # 4) зміна класу на будь-якому кадрі → клас усього треку
    sh = shapes_of(cfg, FR[7]); sh[0]["label"] = "vesicle"
    save(client, FR[7], sh)
    assert track_shape(cfg, FR[1], tid)["label"] == "vesicle"


def test_outside_and_group_remap(ws):
    client, cfg, _ = ws
    save(client, FR[0], [tshape(SQ(10, 10), 7)])
    # кадр 9: полігон треку (idx 0) + свій полігон (idx 1), у групі — idx 1
    other = {"label": "nucleus", "points": SQ(150, 150), "shape_type": "polygon", "group_id": None, "flags": {}}
    save(client, FR[8], shapes_of(cfg, FR[8]) + [other])
    (cfg.groups_dir / f"{FR[8]}.json").write_text(json.dumps(
        {"version": "1.1", "stem": FR[8], "model": "manual",
         "groups": [{"id": "g1", "instance_ids": [], "polygon_indices": [1]}]}))
    # видалити полігон треку на кадрі 7 → outside з кадру 7
    save(client, FR[6], [])
    assert track_shape(cfg, FR[5], 7) is not None
    for s in FR[6:]:
        assert track_shape(cfg, s, 7) is None
    assert shapes_of(cfg, FR[8]) and shapes_of(cfg, FR[8])[0]["points"] == SQ(150, 150)
    g = json.loads((cfg.groups_dir / f"{FR[8]}.json").read_text())["groups"][0]
    assert g["polygon_indices"] == [0]                        # ремап після splice
    # повернення: намалювати трек знову на кадрі 9 (той самий track_id) → видно з 9
    save(client, FR[8], [tshape(SQ(30, 30), 7)] + [other])
    assert track_shape(cfg, FR[9], 7) is not None and track_shape(cfg, FR[7], 7) is None


def test_split_merge_delete_and_mot(ws):
    client, cfg, _ = ws
    save(client, FR[0], [tshape(SQ(10, 10), 3)])
    r = client.post("/api/tracks/3/split", json={"stem": FR[3]}).get_json()
    new = r["new_track_id"]
    assert r["ok"] and FR[3] in r["frames"] and r["states"][FR[3]]["model"] == MANUAL_MODEL
    assert track_shape(cfg, FR[2], 3) and track_shape(cfg, FR[2], new) is None
    assert track_shape(cfg, FR[3], 3) is None and track_shape(cfg, FR[3], new)

    lines = T.mot_lines(cfg)["seq_1_"]
    assert lines[0] == "1,3,10.00,10.00,20.00,20.00,1,-1,-1,-1"
    assert {ln.split(",")[1] for ln in lines} == {"3", str(new)} and len(lines) == 10

    r = client.post(f"/api/tracks/3/merge", json={"from": new}).get_json()
    assert r["ok"]
    for s in FR:
        assert track_shape(cfg, s, 3) is not None and track_shape(cfg, s, new) is None
    assert str(new) not in T.load_tracks(cfg)["tracks"]
    listing = client.get("/api/tracks").get_json()["tracks"]
    assert listing == [{"id": 3, "label": "nucleus", "series": "seq_1_", "keyframes": listing[0]["keyframes"],
                        "first": FR[0], "last": FR[-1], "frames": 10}]

    r = client.delete("/api/tracks/3").get_json()
    assert r["ok"] and all(track_shape(cfg, s, 3) is None for s in FR)
    assert client.delete("/api/tracks/3").status_code == 404
    assert client.post("/api/tracks/99/split", json={"stem": FR[0]}).status_code == 404


def test_tracks_travel_with_export_import_and_pack(ws, tmp_path):
    import io, zipfile
    client, cfg, st = ws
    save(client, FR[0], [tshape(SQ(10, 10), 5)])
    data = client.get("/api/workspace/export?images=1").data
    names = zipfile.ZipFile(io.BytesIO(data)).namelist()
    assert "tracks.json" in names

    # імпорт у порожній датасет → tracks.json скопійовано, полігони з track_id на місці
    dst = tmp_path / "dst"
    (dst / "images").mkdir(parents=True)
    cfg2 = Config(images_dir=dst / "images", output_root=dst / "output", selected_dir=dst / "selected",
                  skipped_dir=dst / "skipped", polygons_dir=dst / "polygons", groups_dir=dst / "groups",
                  workspace_dir=dst, labels_file=dst / "labels.json", group_classes_file=dst / "group_classes.json")
    for d in (cfg2.output_root, cfg2.selected_dir, cfg2.skipped_dir, cfg2.polygons_dir, cfg2.groups_dir):
        d.mkdir()
    cfg2.models = _discover_models(cfg2.output_root, cfg2.images_dir)
    c2 = create_app(cfg2, StateStore(dst / "selections.json")).test_client()
    scan = c2.post("/api/workspace/import-scan", data={"files": (io.BytesIO(data), "e.zip")},
                   content_type="multipart/form-data").get_json()
    src = scan["sources"][0]
    r = c2.post("/api/workspace/import-apply", json={"scan_id": scan["scan_id"],
                "picks": [{"idx": src["idx"], "stems": src["stems"]}]}).get_json()
    assert r["ok"] and r.get("tracks_copied") and "5" in T.load_tracks(cfg2)["tracks"]
    assert track_shape(cfg2, FR[4], 5) is not None
    # повторний імпорт, коли свої треки вже є й відрізняються → свої лишаються, попередження
    T.save_tracks(cfg2, {"version": 1, "next_id": 9, "tracks": {}})
    scan = c2.post("/api/workspace/import-scan", data={"files": (io.BytesIO(data), "e.zip")},
                   content_type="multipart/form-data").get_json()
    r = c2.post("/api/workspace/import-apply", json={"scan_id": scan["scan_id"],
                "picks": [{"idx": scan["sources"][0]["idx"], "stems": [FR[0]]}]}).get_json()
    assert r.get("tracks_kept_local") and T.load_tracks(cfg2)["tracks"] == {}

    # фінальний датасет: tracks.json + MOT-таблиця серії
    sys.path.insert(0, str(HERE.parent.parent.parent / "tools" / "launchers"))
    from bake_all import pack_zip
    z = pack_zip(cfg.workspace_dir, tmp_path / "arch")
    zn = zipfile.ZipFile(z).namelist()
    root = zn[0].split("/")[0]
    assert f"{root}/tracks.json" in zn and f"{root}/tracks/seq_1_mot.txt" in zn
    mot = zipfile.ZipFile(z).read(f"{root}/tracks/seq_1_mot.txt").decode().splitlines()
    assert len(mot) == 10 and mot[0].startswith("1,5,10.00,10.00,20.00,20.00")
