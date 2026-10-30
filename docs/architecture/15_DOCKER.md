# 15 — Docker: пакування застосунку в контейнери

> Додано 2026-10-30 (гілка `docker-setup`). Мета: користувач ставить на ПК **лише Docker** —
> Python, бібліотеки, системні залежності вже в образі. Код застосунку для цього **не змінювався**:
> Docker-шар лише налаштовує запуск наявних entrypoint-ів (`app.py`, `run_segmentation.py`, `bake_all.py`).
> Інструкція для користувача — [`../../DOCKER.md`](../../DOCKER.md). Тут — як і чому це влаштовано.

---

## 1. Файли

| Файл | Роль |
|---|---|
| `Dockerfile` | Багатоетапний: target `mask-picker` → target `segmentation` (наслідує перший). |
| `docker-compose.yml` | 3 сервіси: `mask-picker` (довгоживучий, `up`), `segmentation` і `bake` (профіль `tools`, лише `run`). |
| `.dockerignore` | Не пускає в build context `data/`, `cryobiology4/weights/`, `.git`, venv, кеші, архіви. |
| `DOCKER.md` | Інструкція для користувача (Windows-first). |
| `apps/mask_picker/requirements.txt` | Спільний із не-Docker встановленням; тут закріплено `Pillow<13` (див. §5). |

## 2. Образ `mask-picker`

```
python:3.12-slim
 + apt: libgl1 libglib2.0-0 libxcb1        ← без них `import cv2` (opencv-python, НЕ headless) падає
 + pip (index pytorch/cpu): torch torchvision   ← CPU-збірка ~200 МБ замість ~2.5 ГБ CUDA
 + pip: apps/mask_picker/requirements.txt + tqdm psutil
 + COPY . /app
 ENV PYTHONPATH=/app/shared/cellsegkit, MPLBACKEND=Agg
 ENTRYPOINT python apps/mask_picker/app.py --host 0.0.0.0 --port 5000 --no-browser
 CMD        --workspace /app/data/vesicles_good
```

Чому саме так (кожен пункт — знахідка при збиранні, не змінювати бездумно):
- **torch потрібен навіть редактору.** `state.py` робить `from cellsegkit.exporter.exporter import ...` →
  це виконує `cellsegkit/__init__.py` → `loader/model_loader.py` → `import torch` **на верхньому рівні**.
  Без torch `EXPORT_AVAILABLE=False` → bake/export повертають 503 (застосунок стартує, але «тихо» неповний).
  Перевірка: у лозі старту має бути `features : cleanup=True export=True seed=True`.
- **cellsegkit через `PYTHONPATH`, не `pip install -e`.** `pyproject.toml` cellsegkit-а тягне `cellpose` +
  повний torch (з CUDA) — це ~5 ГБ, редактору не треба. Так само робить `apps/mask_picker/run.bat`.
- **`tqdm`, `psutil`** — імпортуються cellsegkit-ом (`converter.py`, `utils/system.py`), але відсутні в
  `requirements.txt` Mask Picker-а (у не-Docker встановленні їх приносить `pip install -e cellsegkit`).
- **`--host 0.0.0.0`** — інакше Flask слухає лише loopback контейнера й ззовні недоступний.
  **`--no-browser`** — `webbrowser.open` у контейнері безглуздий.
- Python 3.12 (а не 3.13, на якому розробляли): найширша сумісність колес torch/ML-пакетів. 237/237 тестів на 3.12 ОК.

## 3. Образ `segmentation`

`FROM mask-picker` + `pip install cellpose==4.0.3 instanseg-torch==0.1.2 ultralytics==8.3.27`
(`--extra-index-url pytorch/cpu`, щоб залежності не підтягнули CUDA-torch поверх CPU-torch).
ENTRYPOINT `python apps/segmentation/run_segmentation.py`, CMD `--help`.

- Версії **зафіксовані** (відтворюваність). `cellpose` / `ultralytics` — як у
  `cryobiology4/config/requirements-v3.1.txt`. `instanseg-torch==0.0.9` звідти **не існує для Python ≥3.12**
  на PyPI → взято 0.1.2. ⚠ Сумісність 0.1.2 з кастомною моделлю `instanseg_neuroblastoma` НЕ перевірена.
- Кеші завантажуваних моделей → `/cache` (named volume `model-cache`): `CELLPOSE_LOCAL_MODELS_PATH`,
  `HF_HOME`, `TORCH_HOME`, `YOLO_CONFIG_DIR`. Кеш instanseg (лежить у site-packages пакета) **не**
  персистентний — качається на кожен `run --rm`. Можна виправити, якщо стане проблемою.
- Лише **CPU**. GPU (NVIDIA) не налаштовано: треба CUDA-torch в образі + `deploy.resources.reservations.devices`
  у compose + NVIDIA Container Toolkit / Docker Desktop WSL2 GPU. Відкладено.

## 4. docker-compose.yml

| Сервіс | Запуск | Монтування | Примітки |
|---|---|---|---|
| `mask-picker` | `docker compose up [--build]` | `./data → /app/data` | порт `127.0.0.1:5000:5000` (лише локальний ПК); датасет — env `DATASET` (дефолт `vesicles_good`, також через файл `.env`) |
| `segmentation` | `docker compose run --rm segmentation <args>` | `./data`, `./cryobiology4/weights`, volume `model-cache:/cache` | профіль `tools` → не стартує з `up` |
| `bake` | `docker compose run --rm bake --data-dir data/<ds> --pack` | `./data`, `./_archive → /app/_archive` | образ той самий, що `mask-picker`; entrypoint `tools/launchers/bake_all.py` |

- **`init: true`** у всіх сервісах: без init Python працює як PID 1 і ігнорує SIGTERM → `Ctrl+C` /
  `docker compose down` чекали 10 с до примусового kill (виглядало як «Ctrl+C не працює»). З init — <1 с.
- Робоча директорія в контейнері — `/app` = корінь репо, тому відносні шляхи `data/<ds>` у командах працюють
  так само, як без Docker.
- **`_archive` змонтовано обовʼязково**: `bake_all.py --pack` пише ZIP у `ROOT/_archive/`; без mount ZIP
  зникав би разом із контейнером (`--rm`).
- `bake_all.py` сам піднімає Mask Picker сабпроцесом на `127.0.0.1:<port>` всередині контейнера і ходить у
  нього `urllib` → у контейнері працює без додаткових налаштувань (порт назовні не потрібен).
- Дані на хості: bind-mount → файли, створені контейнером, на Linux належать `root` (на Windows/macOS Docker
  Desktop — без проблем). Атомарний запис (`_atomic_write_json`: tempfile + replace) на bind-mount Windows працює.

## 5. Знайдені під час докеризації проблеми

- **Pillow 13 ламає `bake_all.py --pack`** (`tools/launchers/bake_all.py:271`: `Image.fromarray(uint16, mode="I;16")`
  → `ValueError: Invalid mode for data type`) і 12 тестів у `tests/test_audit_export.py`. Причина — свіже
  встановлення без верхньої межі підтягнуло Pillow 13.0. **Мітигація:** `Pillow>=10.0,<13` у
  `apps/mask_picker/requirements.txt`. **Справжній фікс (не зроблено):** прибрати `mode="I;16"` у
  `bake_all.py` і тестах — Pillow і так виводить `I;16` для 2D uint16 (перевірено), тоді межу можна зняти.
  Варто занести як F-015 у `_AUDIT_FINDINGS.md` при наступній роботі з кодом.
- Загальний урок: `requirements.txt` має лише нижні межі → «чисте» встановлення через рік може зламатись.
  Docker-образ зібраний сьогодні — стабільний; перезбірка (`--build` без кешу) тягне нові версії.

## 6. Стан перевірки (2026-10-30)

| Що | Де | Результат |
|---|---|---|
| Збірка справжнього `Dockerfile`, target `mask-picker` | Windows 11 + Docker Desktop 4.97 (WSL2), ПК користувача | ✅ ~3.5 хв, старт з `export=True seed=True` |
| pytest у контейнері | хмарна сесія Claude (sandbox-варіант Dockerfile, §7) | ✅ 237/237 (з `Pillow<13`) |
| `bake --pack` → ZIP у `./_archive` | хмарна сесія | ✅ (на порожньому датасеті) |
| Імпорти `cellpose / instanseg / ultralytics / cellsegkit.SegmenterFactory` у `segmentation` | хмарна сесія | ✅ |
| Реальний прогін сегментації з завантаженням моделей | — | ❌ не перевірено |
| Редактор на реальному датасеті `vesicles_good` у Docker | — | ❌ не перевірено |

## 7. Як тестувати Docker у хмарній сесії Claude Code (нотатка для AI-асистента)

Хмарний контейнер має обмежену мережу. Що спрацювало:
- Демон не запущений → `dockerd > <scratchpad>/dockerd.log 2>&1 &` (сесія працює від root).
- Docker Hub відповідає **429** → `docker pull mirror.gcr.io/library/python:3.12-slim` і перетегувати як
  `python:3.12-slim` (локальний тег перекриває Hub).
- Контейнери не бачать проксі сесії → `docker build --network host` + власний базовий образ поверх
  `python:3.12-slim` з `ENV HTTPS_PROXY/HTTP_PROXY`, CA з `/root/.ccr/ca-bundle.crt`
  (`PIP_CERT`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`), тегнути як `python:3.12-slim`.
- **Заблоковані хости:** `deb.debian.org` (apt), `download.pytorch.org`, `huggingface.co`. Доступний PyPI.
  Тому тестувати копію Dockerfile у scratchpad: без apt-кроку, torch із PyPI (CUDA-збірка, образ ~9.6 ГБ),
  `opencv-python` → `opencv-python-headless` (не потребує libGL/libxcb). **Сам `Dockerfile` у репо під
  sandbox не підганяти.**
- Для `bake` у такому образі передати `-e NO_PROXY=127.0.0.1 -e no_proxy=127.0.0.1`, інакше `urllib`
  шле запит до власного сервера через проксі й чекає 30 с до таймауту.
- Тести: `docker compose run --rm --no-deps -w /app/apps/mask_picker --entrypoint python mask-picker -m pytest tests/ -q -p no:cacheprovider`.
