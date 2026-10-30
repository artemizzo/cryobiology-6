# Cryobiology V у Docker

Docker-образ містить **Python і всі бібліотеки**: ставити на ПК потрібно лише Docker.
Дані (`data/`) лишаються у звичайній папці проєкту на диску, контейнер лише працює з ними.

## 1. Встановити Docker (один раз)
- **Windows / macOS:** [Docker Desktop](https://www.docker.com/products/docker-desktop/).
  На Windows під час встановлення лиши ввімкненим **WSL 2**; після встановлення перезавантаж ПК.
- **Linux:** Docker Engine + Docker Compose plugin.

Docker Desktop має бути **запущений** (іконка кита в треї), коли виконуєш команди нижче.

## 2. Завантажити проєкт
```bash
git clone https://github.com/artemizzo/cryobiology-6.git
cd cryobiology-6
```
(без git: на GitHub **Code → Download ZIP** і розпакуй; далі відкрий PowerShell/термінал у цій папці).

Датасет поклади у `data/<назва>/` (напр. `data/vesicles_good/` з Google Drive — посилання в `README.md`).

## 3. Mask Picker (редактор)
```bash
docker compose up --build
```
Відкрий у браузері **http://localhost:5000**. Зупинити — `Ctrl+C` у терміналі.

- Перший запуск збирає образ (~5–10 хв, качає ~1 ГБ). Далі — кілька секунд.
- `--build` потрібен лише після оновлення коду (`git pull`); інакше достатньо `docker compose up`.
- **Інший датасет** (за замовч. `vesicles_good`):
  - PowerShell: `$env:DATASET="my_dataset"; docker compose up`
  - macOS/Linux: `DATASET=my_dataset docker compose up`
  - або постійно: створи поруч із `docker-compose.yml` файл `.env` з рядком `DATASET=my_dataset`.
  Якщо папки ще нема — редактор створить порожню структуру `data/my_dataset/`.

## 4. ML-сегментація (опційно)
Окремий, більший образ (~+2 ГБ) з cellpose / instanseg / ultralytics. Фото — у `data/<назва>/images/`.
```bash
docker compose build segmentation
docker compose run --rm segmentation --data-dir data/my_dataset --model instanseg
docker compose run --rm segmentation --data-dir data/my_dataset --all
docker compose run --rm segmentation --help
```
- Моделі, які качаються при першому запуску (Cellpose-SAM ~1.2 ГБ тощо), зберігаються в Docker volume
  `model-cache` → наступні запуски їх не качають.
- Кастомні ваги Cryobiology IV — у `cryobiology4/weights/` проєкту (як і без Docker, див. `INSTALL.md` §3).
- Рахує **лише на CPU** (повільно для `cyto2` / Cellpose-SAM — див. `INSTALL.md` §3). GPU у Docker поки не налаштовано.

## 5. Фінальний датасет (bake + ZIP)
```bash
docker compose run --rm bake --data-dir data/my_dataset --pack
```
ZIP зʼявиться у папці `_archive/` проєкту.

## Корисне

> **Ctrl+C «не працює»?** Спершу клацни мишкою у вікно PowerShell (воно має бути активним). Якщо в
> заголовку вікна написано **«Select»/«Виділити»** — ти випадково виділив текст і вивід призупинено:
> натисни `Esc`, потім знову `Ctrl+C`. Крайній випадок — у **іншому** вікні PowerShell у папці проєкту:
> `docker compose down`.

| Що | Команда |
|---|---|
| Запустити редактор у фоні | `docker compose up -d` |
| Зупинити фоновий | `docker compose down` |
| Подивитись логи | `docker compose logs -f mask-picker` |
| Тести в контейнері | `docker compose run --rm -w /app/apps/mask_picker --entrypoint python mask-picker -m pytest tests/ -q` |
| Звільнити місце (старі образи) | `docker system prune` |

**Linux:** файли, створені контейнером у `data/`, належатимуть `root`. Виправити: `sudo chown -R $USER data _archive`.

## Як влаштовано (для розробника)
Детально (рішення, підводні камені, стан перевірки) — [`docs/architecture/15_DOCKER.md`](docs/architecture/15_DOCKER.md).
- `Dockerfile` — два етапи: `mask-picker` (Python 3.12-slim + CPU-torch + `apps/mask_picker/requirements.txt`,
  `cellsegkit` через `PYTHONPATH`) і `segmentation` (+ ML-пакети з зафіксованими версіями).
- `docker-compose.yml` — сервіси `mask-picker` (порт `127.0.0.1:5000`), `segmentation` і `bake`
  (профіль `tools`, лише через `docker compose run`). `data/`, `_archive/`, `cryobiology4/weights/` —
  bind-mount з диска; `.dockerignore` не пускає їх в образ.
- Сервер у контейнері слухає `0.0.0.0` з `--no-browser`; назовні порт відкритий лише для localhost.
