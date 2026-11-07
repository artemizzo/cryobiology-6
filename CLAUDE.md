# CLAUDE.md — путівник для AI-асистента

Cryobiology V / **Mask Picker**: human-in-the-loop пайплайн доразмітки масок сегментації
клітин (мікроскопія). ML-моделі дають чорнові маски → анотатор у браузері чистить,
домальовує й групує («1 ядро + N везикул») → бекенд «запікає» ground-truth датасет.

## Де що читати (не дублюю — тут лише вказівники)
- `README.md` — огляд, швидкий старт. `INSTALL.md` — встановлення, ваги, чистий ПК.
- `docs/architecture/README.md` — індекс 14 підсистем (front↔back) + `15_DOCKER.md` + `16_MANUAL_MODE.md`. Починати з `01_DATA_MODEL_AND_ID_SPACES.md`.
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
cd apps/mask_picker && MPLBACKEND=Agg python -m pytest tests/ -q         # тести (очікувано 242 passed)
```

### Docker (основний спосіб запуску для користувача)
```bash
docker compose up --build                                            # редактор → http://localhost:5000 (DATASET=<ds>, дефолт vesicles_good)
docker compose run --rm segmentation --data-dir data/<ds> --model instanseg
docker compose run --rm bake --data-dir data/<ds> --pack             # ZIP → ./_archive/
```
- Повний опис і всі «чому» — `docs/architecture/15_DOCKER.md`; інструкція для користувача — `DOCKER.md`.
- Код застосунку під Docker НЕ змінювався. Образ `mask-picker`: Python 3.12-slim + CPU-torch (без torch
  cellsegkit не імпортується → bake/export 503) + cellsegkit через `PYTHONPATH`. Образ `segmentation` = + cellpose/instanseg/ultralytics, лише CPU.
- Змінюєш залежності (`requirements.txt`, нові імпорти) — онови й `Dockerfile`, перевір у лозі старту
  `features : cleanup=True export=True seed=True`.
- `requirements.txt` має лише нижні межі → нові версії бібліотек ламають код. Вже був випадок: Pillow 13 →
  `bake_all.py --pack` падає; закріплено `Pillow<13` (справжній фікс — `15_DOCKER.md` §7).
- Тестування Docker у хмарній сесії має обходи мережі (Docker Hub 429, apt/pytorch/HF заблоковані) — `15_DOCKER.md` §9.
- **Ярлики** (`15_DOCKER.md` §5): `create_shortcuts.bat|sh` → ярлик «Mask Picker» → `tools/launchers/docker/MaskPicker.ps1 -Hidden`
  (Windows) / `mask-picker.sh --hidden` (Linux): сам стартує Docker, віконце-статус, браузер. Рішення користувача:
  **при помилці — консоль із сирим логом** (`_logs/launcher.log` + `docker compose logs`), НЕ кастомне повідомлення.
  Без `-Hidden`/`--hidden` — ручний режим з консоллю (для розробки). `.ps1` — UTF-8 з BOM (не прибирати).
- Linux: контейнери `mask-picker`/`bake` працюють від `MP_UID:MP_GID` (з `.env`), не root.
- **Відоме обмеження:** у Docker не працюють native-діалоги вибору папки (кнопки «Змінити» workspace і
  «Зберегти у» експорту, `tkinter` у `routes/api_workspace.py`) — `15_DOCKER.md` §6. Фікс потребує зміни коду, не зроблено.

Основна платформа користувача — **Windows** (`.bat`-лаунчери в корені), шляхи мають лишатись переносними.

## Хто веде проєкт і де що лежить
- Автор — попередній розробник (upstream `MykhailoFesenko/cryobiology-mask-picker`, писав разом з Claude).
  Зараз проєкт веде **новий мейнтейнер-початківець** у форку **`artemizzo/cryobiology-6`** (сюди й пушити).
  Пояснювати йому простою мовою, українською, без жаргону; не вважати, що він знає git/Python/Docker.
- Гілки: працюємо в `main`. `docker-setup` злита в `main` (2026-10-30), більше не потрібна.
- У користувача: Windows 11, Docker Desktop (WSL2) встановлено; проєкт склоновано git-ом у
  `Documents\cryobiology-6` (переведено на `main`); редактор у Docker запускається ✅ (2026-10-30);
  ярлик «Mask Picker» створено й перевірено ✅ (2026-10-31). Docker Desktop встановлено per-user
  (`%LOCALAPPDATA%\Programs\DockerDesktop`, не Program Files).
  Даних `data/vesicles_good` (Google Drive) на ПК ще нема. Python локально не ставився.
- Хмарна сесія Claude Code не запускає код з репо без дозволу (класифікатор безпеки) — попросити дозвіл, якщо треба.

## Ключові правила (з історії багів — порушення = регресії десинку)
- **Перед будь-якою правкою** пройти чекліст `docs/CODE_AUDIT_PRINCIPLES.md`: назвати концепт, знайти
  ВСІ його представлення і консюмерів (front + back + bake + export), оновити їх разом.
- `output/<model>/` (raw вихід сегментації) — **read-only**, ніколи не змінювати. Виняток: `output/manual/`
  (псевдо-модель ручної розмітки) MP створює сам, один раз на stem (порожня маска + копія оригіналу) — далі теж read-only.
- **Ручна розмітка = псевдо-модель `manual`** (`state.ManualModelSource`, завжди останній у `cfg.models`):
  для решти коду — звичайна модель. Нові місця, що читають `m.npy_dir` напряму, мають викликати
  `m.ensure_base(stem)` (або йти через `cleanup._find_npy_for`). → `16_MANUAL_MODE.md`.
- **Розрив полігона** (`editor/repair.js`, tool `"break"`): відкриті лінії живуть лише в `pg.repair`,
  commit пише у той самий індекс shape (групи не ламаються). Не зберігати відкриті лінії в `pg.shapes`.
- Три ID-простори: `raw_iid` (модель), reserved-ID полігонів `50000+`, dense `1..N` лише у deliverable.
  Не змішувати (див. `01_…`, `09_BAKING_AND_RESERVED_IDS.md`).
- Bake — тільки на «Зберегти все» / Finalize, не в інтерактиві; групування в UI рахується на фронті.
- Порядок класів у `labels.json` = семантичний контракт (1=nucleus, 2=vesicle) — не переставляти.
- Запис файлів — тільки атомарно (`_atomic_write_json` у `state.py`).
- Після змін: прогнати pytest, оновити відповідний `docs/architecture/*.md` і, якщо знайдено баг, —
  `_AUDIT_FINDINGS.md`. Версія — `APP_VERSION` у `apps/mask_picker/state.py` (зараз 2.0.0).

## Чого нема в репо (лишилось у попереднього розробника локально)
`CHANGELOG`, `docs/_internal/` (handoff-доки), `.claude/`, `data/`, ваги моделей — див. `.gitignore`.
