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

## 3. Ярлик «Mask Picker» (найпростіше)
Один раз створи ярлик:
- **Windows:** подвійний клік по `create_shortcuts.bat` у корені проєкту → ярлик на робочому столі й у меню «Пуск».
- **Linux:** `./create_shortcuts.sh` → ярлик у меню програм (і на робочому столі, якщо він є).

Далі — подвійний клік по ярлику:
1. сам запускає Docker (Desktop), якщо він не працює;
2. показує віконце зі статусом (без консолі) і тихо запускає редактор;
3. відкриває браузер на http://localhost:5000. Якщо редактор уже працює — просто відкриває браузер.

- **Вимкнути:** закрий Docker Desktop (редактор зупиниться разом із ним) або `docker compose down`.
  Після старту Docker редактор сам НЕ запускається — лише по ярлику.
- **Якщо щось падає** — відкривається консоль із повним логом запуску й логами контейнера (причина там).
  Лог останнього запуску завжди лежить у `_logs/launcher.log`.
- Перший запуск (або після `git pull` зі зміненим кодом) — до 10 хв: збирається образ.
- Перенесли папку проєкту — запусти `create_shortcuts` ще раз.
- Порада (Windows): у Docker Desktop → Settings → General можна ввімкнути «Start Docker Desktop when you
  sign in» — тоді ярлик стартуватиме швидше.

**Для розробки (консоль з усіма процесами):** той самий запуск, але видно все, як у `docker compose up`:
- Windows: `.\tools\launchers\docker\MaskPicker.ps1` (у PowerShell у корені проєкту)
- Linux: `./tools/launchers/docker/mask-picker.sh`

Сам запускає Docker, якщо треба, відкриває браузер, коли сервер готовий; `Ctrl+C` — зупинити.
Звичайний `docker compose up --build` (нижче) теж працює як раніше.

## 4. Mask Picker вручну (docker compose)
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

## 5. ML-сегментація (опційно)
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

## 6. Фінальний датасет (bake + ZIP)
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

**Linux — права на файли.** Редактор і `bake` працюють від імені користувача з `MP_UID`/`MP_GID`
(їх записує в `.env` скрипт `create_shortcuts.sh`; лаунчер `mask-picker.sh` ставить їх сам). Без них —
від `root`, і файли в `data/` належатимуть root. Виправити: `sudo chown -R $USER data _archive`.
Сегментація (`segmentation`) завжди працює від root.

## Відомі обмеження Docker-версії
- Кнопки, що відкривають **системне вікно вибору папки**, у Docker не працюють (помилка «folder picker
  unavailable»): **«Змінити»** (перемкнути датасет) і **«Зберегти у»** в експорті. Вікно відкривається там,
  де працює сервер, а в контейнері немає екрана.
  - Датасет міняй через `DATASET` (у `.env`) і перезапуск.
  - Експорт без «Зберегти у» працює: ZIP скачується браузером.

## Як влаштовано (для розробника)
Детально (рішення, підводні камені, стан перевірки) — [`docs/architecture/15_DOCKER.md`](docs/architecture/15_DOCKER.md).
- `Dockerfile` — два етапи: `mask-picker` (Python 3.12-slim + CPU-torch + `apps/mask_picker/requirements.txt`,
  `cellsegkit` через `PYTHONPATH`) і `segmentation` (+ ML-пакети з зафіксованими версіями).
- `docker-compose.yml` — сервіси `mask-picker` (порт `127.0.0.1:5000`), `segmentation` і `bake`
  (профіль `tools`, лише через `docker compose run`). `data/`, `_archive/`, `cryobiology4/weights/` —
  bind-mount з диска; `.dockerignore` не пускає їх в образ.
- Сервер у контейнері слухає `0.0.0.0` з `--no-browser`; назовні порт відкритий лише для localhost.
