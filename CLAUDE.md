# CLAUDE.md — путівник для AI-асистента

Cryobiology V / **Mask Picker**: human-in-the-loop пайплайн доразмітки масок сегментації
клітин (мікроскопія). ML-моделі дають чорнові маски → анотатор у браузері чистить,
домальовує й групує («1 ядро + N везикул») → бекенд «запікає» ground-truth датасет.

## Де що читати (не дублюю — тут лише вказівники)
- `README.md` — огляд, швидкий старт. `INSTALL.md` — встановлення, ваги, чистий ПК.
- `docs/architecture/README.md` — індекс 14 підсистем (front↔back). Починати з `01_DATA_MODEL_AND_ID_SPACES.md`.
- `docs/architecture/_AUDIT_FINDINGS.md` — живий лог багів (F-001…F-014), відкриті пункти — там.
- `docs/CODE_AUDIT_PRINCIPLES.md` — **обовʼязково перед правками** (див. нижче).
- `docs/TECHNICAL_REPORT.md`, `docs/PROJECT_JOURNEY.md` — історія й рішення.

## Структура
- `apps/mask_picker/` — Flask-застосунок. `app.py` (wiring + CLI), `state.py` (Config/StateStore/atomic write),
  доменна логіка `cleanup.py` / `polygons.py` / `groups.py` / `group_classes.py`,
  `baking.py` + `data_sync.py` (запікання й синхронізація), `routes/` (HTTP API blueprints),
  `static/` (vanilla ES-модулі, без збірки; редактор — `static/modules/editor/`), `tests/` (pytest).
- `apps/segmentation/run_segmentation.py` — запуск ML-моделей → `data/<dataset>/output/<model>/`.
- `shared/cellsegkit/` — запозичений тулкіт (MIT, Cryobiology III), рендер/експорт.
- `cryobiology4/` — reference-код моделей + конфіги; ваги в `cryobiology4/weights/` (не в git).
- `tools/` — `launchers/bake_all.py` (фінальний deliverable `--pack`), верифікатори інваріантів, `make_sandbox.py`.
- `data/<dataset>/` — дані, **не в git** (Google Drive): `images/ output/ selected/ polygons/ groups/`.

## Команди
```bash
pip install -r apps/mask_picker/requirements.txt
pip install -e ./shared/cellsegkit
python apps/segmentation/run_segmentation.py --data-dir data/<dataset>   # крок 1
python apps/mask_picker/app.py --workspace data/<dataset>                # крок 2 → http://127.0.0.1:5000
python tools/launchers/bake_all.py --data-dir data/<dataset> --pack      # deliverable
python tools/make_sandbox.py                                             # безпечна копія датасету для експериментів
cd apps/mask_picker && MPLBACKEND=Agg python -m pytest tests/ -q         # тести (очікувано 237 passed)
```
Основна платформа користувача — **Windows** (`.bat`-лаунчери в корені), шляхи мають лишатись переносними.

## Ключові правила (з історії багів — порушення = регресії десинку)
- **Перед будь-якою правкою** пройти чекліст `docs/CODE_AUDIT_PRINCIPLES.md`: назвати концепт, знайти
  ВСІ його представлення і консюмерів (front + back + bake + export), оновити їх разом.
- `output/<model>/` (raw вихід сегментації) — **read-only**, ніколи не змінювати.
- Три ID-простори: `raw_iid` (модель), reserved-ID полігонів `50000+`, dense `1..N` лише у deliverable.
  Не змішувати (див. `01_…`, `09_BAKING_AND_RESERVED_IDS.md`).
- Bake — тільки на «Зберегти все» / Finalize, не в інтерактиві; групування в UI рахується на фронті.
- Порядок класів у `labels.json` = семантичний контракт (1=nucleus, 2=vesicle) — не переставляти.
- Запис файлів — тільки атомарно (`_atomic_write_json` у `state.py`).
- Після змін: прогнати pytest, оновити відповідний `docs/architecture/*.md` і, якщо знайдено баг, —
  `_AUDIT_FINDINGS.md`. Версія — `APP_VERSION` у `apps/mask_picker/state.py` (зараз 2.0.0).

## Чого нема в репо (лишилось у попереднього розробника локально)
`CHANGELOG`, `docs/_internal/` (handoff-доки), `.claude/`, `data/`, ваги моделей — див. `.gitignore`.
