"""
Треки об'єктів між кадрами серії (tracks.py) — HTTP API.

  POST   /api/tracks/new                — зарезервувати номер нового треку
  GET    /api/tracks                    — список треків (номер, клас, серія, кадри)
  POST   /api/tracks/<tid>/split        — {stem}: від цього кадру — новий трек
  POST   /api/tracks/<tid>/merge        — {from}: влити трек `from` у <tid>
  DELETE /api/tracks/<tid>              — видалити трек з усіх кадрів
  POST   /api/tracks/undo               — {undo_id}: скасувати split/merge/delete (Ctrl+Z)

Синхронізація ключових кадрів — автоматично в POST /api/polygons/<stem>.
Відповіді операцій містять `frames` (перезаписані кадри) і `states` (їх стан
у selections.json) — фронт оновлює каталог і перечитує відкритий кадр.
"""
from __future__ import annotations

from flask import Blueprint, jsonify, request

from state import Config, StateStore
from catalog import CatalogService
import tracks as T


def make_blueprint(cfg: Config, state: StateStore, catalog: CatalogService) -> Blueprint:
    bp = Blueprint("api_tracks", __name__)

    def _with_states(res: dict) -> dict:
        res["states"] = {s: state.get(s) for s in res.get("frames") or []}
        catalog.invalidate()
        return res

    @bp.route("/api/tracks/new", methods=["POST"])
    def api_tracks_new():
        return jsonify({"ok": True, "track_id": T.new_track_id(cfg)})

    @bp.route("/api/tracks", methods=["GET"])
    def api_tracks_list():
        data = T.load_tracks(cfg)
        out = []
        for tid, tr in sorted(data["tracks"].items(), key=lambda kv: int(kv[0])):
            frames = T.series_frames(cfg, tr.get("series"))
            visible = [s for s in frames if T.shape_at(tr, frames, s) is not None]
            out.append({"id": int(tid), "label": tr.get("label"), "series": tr.get("series"),
                        "keyframes": sorted(tr.get("keyframes") or {}, key=lambda s: T.series_of(s)[1]),
                        "first": visible[0] if visible else None,
                        "last": visible[-1] if visible else None, "frames": len(visible)})
        return jsonify({"ok": True, "tracks": out})

    def _run(fn, *args):
        try:
            return jsonify({"ok": True, **_with_states(fn(*args))})
        except KeyError as e:
            return jsonify({"error": str(e).strip("'")}), 404
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

    @bp.route("/api/timeline/<stem>", methods=["GET"])
    def api_timeline(stem: str):
        with_shapes = (request.args.get("shapes") or "") in ("1", "true")
        return jsonify({"ok": True, **T.timeline(cfg, state, stem, with_shapes)})

    @bp.route("/api/tracks/<tid>/split", methods=["POST"])
    def api_tracks_split(tid: str):
        stem = str((request.get_json(silent=True) or {}).get("stem") or "")
        return _run(T.split_track, cfg, state, tid, stem)

    @bp.route("/api/tracks/<tid>/merge", methods=["POST"])
    def api_tracks_merge(tid: str):
        src = str((request.get_json(silent=True) or {}).get("from") or "")
        return _run(T.merge_tracks, cfg, state, tid, src)

    @bp.route("/api/tracks/undo", methods=["POST"])
    def api_tracks_undo():
        uid = str((request.get_json(silent=True) or {}).get("undo_id") or "")
        return _run(T.undo_op, cfg, state, uid)

    @bp.route("/api/tracks/<tid>", methods=["DELETE"])
    def api_tracks_delete(tid: str):
        return _run(T.delete_track, cfg, state, tid)

    return bp
