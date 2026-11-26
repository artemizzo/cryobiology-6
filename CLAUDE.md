# CLAUDE.md — путівник для AI-асистента

Cryobiology V / **Mask Picker**: human-in-the-loop пайплайн доразмітки масок сегментації
клітин (мікроскопія). ML-моделі дають чорнові маски → анотатор у браузері чистить,
домальовує й групує («1 ядро + N везикул») → бекенд «запікає» ground-truth датасет.

## Де що читати (не дублюю — тут лише вказівники)
- `TEAM.md` — інструкція встановлення для команди анотаторів (Docker + Git + clone + ярлик, обмін ZIP). `README.md` — огляд, швидкий старт. `INSTALL.md` — встановлення, ваги, чистий ПК.
- `docs/architecture/README.md` — індекс 14 підсистем (front↔back) + `15_DOCKER.md` + `16_MANUAL_MODE.md` + `17_TRACKS.md`. Починати з `01_DATA_MODEL_AND_ID_SPACES.md`.
- `docs/architecture/_AUDIT_FINDINGS.md` — живий лог багів (F-001…F-019), відкриті пункти — там.
- `docs/CODE_AUDIT_PRINCIPLES.md` — **обовʼязково перед правками** (див. нижче).
- **`docs/FEATURES.md` — повний каталог функцій: що, де в коді, які рішення мейнтейнера. Читати першим; оновлювати при кожній новій функції.**
- `docs/HOTKEYS.md` — усі гарячі клавіші й кнопки для користувача (дзеркало — `#helpModal` в `index.html`; міняєш клавіші — онови обидва).
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
cd apps/mask_picker && MPLBACKEND=Agg python -m pytest tests/ -q         # тести (очікувано 259 passed)
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
  Ярлик ЗАВЖДИ робить `compose up -d --build` (навіть коли редактор уже працює — інакше після `git pull` лишалась стара версія). Без `-Hidden`/`--hidden` — ручний режим з консоллю (для розробки). `.ps1` — UTF-8 з BOM (не прибирати).
- Linux: контейнери `mask-picker`/`bake` працюють від `MP_UID:MP_GID` (з `.env`), не root.
- **Відоме обмеження:** у Docker не працюють native-діалоги вибору папки (кнопки «Змінити» workspace і
  «Зберегти у» експорту, `tkinter` у `routes/api_workspace.py`) — `15_DOCKER.md` §6. Фікс потребує зміни коду, не зроблено.

Основна платформа користувача — **Windows** (`.bat`-лаунчери в корені), шляхи мають лишатись переносними.

## Хто веде проєкт і де що лежить
- Автор — попередній розробник (upstream `MykhailoFesenko/cryobiology-mask-picker`, писав разом з Claude).
  Зараз проєкт веде **новий мейнтейнер-початківець** у форку **`artemizzo/cryobiology-6`** (сюди й пушити).
  Пояснювати йому простою мовою, українською, без жаргону; не вважати, що він знає git/Python/Docker.
- Гілки: працюємо в `main`. `docker-setup`, `launchers`, `manual-mode`, `export-import-fixes`, `lasso-move`, `shape-move`, `export-photos`, `ghost-zoom`, `shortcut-icon`, `pick-ghost`, `tracks`, `photo-nav`, `ux-fixes`, `header-fix`, `nav-speed`, `timeline`, `scrubber`, `hold-keys` злиті в `main` (видаляти гілки на GitHub
  сесія не може — 403; користувач видаляє сам через сайт).
- У користувача: Windows 11, Docker Desktop (WSL2) встановлено; проєкт склоновано git-ом у
  `Documents\cryobiology-6` (переведено на `main`); редактор у Docker запускається ✅ (2026-10-30);
  ярлик «Mask Picker» створено й перевірено ✅ (2026-10-31). Docker Desktop встановлено per-user
  (`%LOCALAPPDATA%\Programs\DockerDesktop`, не Program Files).
  Python локально не ставився. 2026-11-07: користувач імпортував власний ZIP із jpg (`seq_1.zip`) і розмічає
  вручну (режим `manual`); ручна розмітка + розрив + запікання на Windows — «працює».
- Історія запитів мейнтейнера (що вже зроблено): Docker (`15`) → ярлики (`15`§5) → ручна розмітка + ✂ розрив
  полігона + імпорт «просто фото» (`16`, F-015) → перевірка експорт/імпорт/повторна обробка (`16`§7;
  фікси F-016 класи губились, F-017 Split губив групи, F-018 дубль overlay) → ласо: тягнути вибрані точки /
  стрілки; тягнути весь полігон за тіло (`06`) → експорт «📷 Додати фото» (`16`§7) → тінь сусідніх фото
  (onion skin, `ghost.js`, `06`§11; копіювання з тіні — у 🎯 Pick) + чіткість ліній/точок при зумі (`06`§12)
  → треки між кадрами серії як у CVAT (`17_TRACKS.md`) → ◀/▶ між фото в шапці редактора (`editor.gotoPhoto`,
  PageUp/PageDown) + фікс F-019 (× закривав без збереження, Esc не закривав — з оригінальної версії) → фіксоване місце ◀/▶,
  «📎 До треку…», Ctrl+Z для split/merge/delete треку (серверні знімки), `docs/HOTKEYS.md` (+ довідка «?» в програмі) → ярлик завжди перезбирає, статика без кешу (`SEND_FILE_MAX_AGE_DEFAULT=0`), назва в шапці редактора стискається. → Q/W між фото, стрибок на кілька фото, зум/камера зберігаються, без затемнення, 🎥 F камера за курсором (`06`§13), обов'язкове вікно класів після імпорту (`16`§4) → камера біля краю як у Dota (F; стара «за курсором» — 🌀 пасхалка Alt+Shift+F, не документувати для юзера), Shift+Q/W фон сусіднього кадру (`06`§13), класи НА ІМПОРТ (`label_sets.py`, `label_sets.json`, `16`§4), таймлайн → переробено на тонкий повзунок кадрів у шапці з попереднім завантаженням кадрів серії і миттєвим прев'ю при протягуванні (`editor/timeline.js`, `/api/timeline?shapes=1`, `17`§7; велику панель, кнопки й автовідтворення мейнтейнер відхилив), Alt+Q/W — ключові кадри → затиснуті Q/W і Shift+Q/W — перемотка з прискоренням (`editor/hold.js`). exe-лаунчер — НЕ робити (рішення: лишається Docker + ярлик). Інструкція для людей по ручному режиму й карта збереження
  даних — `README.md` §«Ручна розмітка». Відкриті ідеї: імпорт зовнішніх форматів розмітки (COCO/CVAT),
  native-діалоги вибору папки в Docker (`15`§6), попередження при bake про клас поза labels.json (F-016).
- **Встановлення в команди (5 студентів, Docker лишається — рішення 2026-11-22):** інструкція `TEAM.md` + PDF
  `docs/Mask_Picker_Instrukciya.pdf` (джерело `docs/team_guide/guide.html`, `node docs/team_guide/build_pdf.js`).
  Зустрічались проблеми: per-user Docker без «Virtual Machine Platform» → All-users / `wsl --install`; «WSL not installed» →
  крок 2.0 `wsl --install`; `wsl-bootstrap … /dev/sdd is not usable` (зіпсований data-диск, ймовірно через брак місця
  на C:) → `wsl --shutdown`, `wsl --unregister docker-desktop`, видалити `%LOCALAPPDATA%\Docker\wsl`, ребут — допомогло;
  `git clone` у PowerShell дає червоний `NativeCommandError` — нешкідливо. **Відкрите (2026-11-25):** юзер з малим C: —
  Docker уже запускається; далі йому: дані Docker → `D:\DockerData` (Settings → Resources → Advanced → Disk image
  location), Git → `D:\Git`, `git clone` у `D:\`, `create_shortcuts`, оновлення `cd D:\cryobiology-6`. Мейнтейнер
  повернеться з результатом. Можливо, варто додати в PDF розділ «мало місця на C:» і російські назви пунктів Windows.
- Хмарна сесія Claude Code не запускає код з репо без дозволу (класифікатор безпеки) — попросити дозвіл, якщо треба.

## Ключові правила (з історії багів — порушення = регресії десинку)
- **Перед будь-якою правкою** пройти чекліст `docs/CODE_AUDIT_PRINCIPLES.md`: назвати концепт, знайти
  ВСІ його представлення і консюмерів (front + back + bake + export), оновити їх разом.
- `output/<model>/` (raw вихід сегментації) — **read-only**, ніколи не змінювати. Виняток: `output/manual/`
  (псевдо-модель ручної розмітки) MP створює сам, один раз на stem (порожня маска + копія оригіналу) — далі теж read-only.
- **Ручна розмітка = псевдо-модель `manual`** (`state.ManualModelSource`, завжди останній у `cfg.models`):
  для решти коду — звичайна модель. Нові місця, що читають `m.npy_dir` напряму, мають викликати
  `m.ensure_base(stem)` (або йти через `cleanup._find_npy_for`). → `16_MANUAL_MODE.md`.
- **Перенесення розмітки:** звичайний експорт БЕЗ фото; галочка «📷 Додати фото» (`?images=1`) додає `images/` +
  `output/<model>/` обраної моделі (не `manual`) → архів самодостатній; `labels.json`/`group_classes.json` їдуть в
  архіві й мерджаться при імпорті (`_merge_workspace_meta`: бракуючі класи — в кінець). Нові файли метаданих
  workspace додавати і в експорт, і в Split (`make_annotation_task.py`), і в імпорт.
- **SVG редактора і зум:** товщина ліній — `calc(Npx * var(--zinv, 1))`, радіус точок — `_polyVertexR()`;
  `will-change` лише під час зуму (`06`§12). Нові SVG-елементи робити так само, інакше пікселі при наближенні.
- **Класи на фото** (`label_sets.py`, `16`§4): у редакторі класи брати через `state.usableLabels(stem)`, НЕ `appLabels`
  напряму (інакше покажуться класи інших імпортів). `labels.json` — глобальний реєстр для bake; новий файл метаданих
  `label_sets.json` уже в експорті / Split / імпорті.
- **Треки** (`tracks.py`, `17`): SoT — `tracks.json`; на кадрах — звичайні полігони з `flags.track_id/keyframe`.
  Синхронізація в КОЖНОМУ `POST /api/polygons/<stem>` (`sync_frame`). Полігон треку на кадрі оновлювати НА
  МІСЦІ (індекс), видалення — з ремапом `groups polygon_indices`. Новий код, що пише polygons.json кадру в
  обхід цього endpoint, — або кличе `sync_frame`, або свідомо ні (як `materialize`).
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
