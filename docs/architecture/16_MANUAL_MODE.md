# 16. Ручна розмітка («manual») + розрив полігона

> Додано 2026-11-07 (гілка `manual-mode`, злита в `main` того ж дня). Інструкція для людей — `README.md` §«Ручна розмітка». Запит мейнтейнера: режим, де користувач сам розмічає клітини
> на будь-якому фото (з масками моделей або без), може взяти готові маски як основу, з тим самим
> імпортом/експортом; + інструмент «розірвати полігон → видалити ділянку → домалювати → замкнути».
> Принцип: **повторно використати наявний пайплайн**, а не будувати паралельний редактор.

---

## 1. Псевдо-модель `manual` (backend)

**Ідея:** ручна розмітка = ще одна «модель», чий raw output — **порожня маска** (усі пікселі 0) і
overlay = копія оригіналу. Тоді для решти коду це звичайна модель: select → cleanup (порожній) →
Polygons → Groups → bake (полігони стають reserved-ID `50000+`, → `09`) → Finalize/`--pack` → ZIP.
Жодних змін у bake / groups / export / import не знадобилось.

| Що | Де | Як |
|---|---|---|
| Клас | `state.ManualModelSource(ModelSource)` | `has_image` = є оригінал у `images/`; `overlay_path` до матеріалізації → сам оригінал; `ensure_base(stem)` — ліниво створює `output/manual/npy/<stem>.npy` (zeros uint16, H×W оригіналу, atomic) + `output/manual/overlay/<stem>.<ext>` (копія оригіналу; не jpg/png → PNG). Ідемпотентно. |
| Реєстрація | `state._discover_models(output_root, images_dir)` | якщо передано `images_dir` — `manual` **завжди останній** у `cfg.models`; підпапка `output/manual` пропускається у звичайному discovery (без дубля). `load_config`: explicit models + manual. Усі виклики (`app.py`, `workspace.py`, `api_workspace.py` ×2, `bake_all.py`) передають `images_dir`. |
| Константа | `state.MANUAL_MODEL = "manual"` · фронт `state.js` `MANUAL_MODEL`, `MANUAL_MODEL_TITLE` | |
| Матеріалізація | `api_select` (`ensure_base` перед копіюванням у `selected/`), `cleanup._find_npy_for` (його кличуть bake-all, finalize, polygons-export, seed, labels-rgb), `api_groups` raw-fallback ×2 | Тому навіть stem з імпортованого workspace (selections `model=manual`, а `output/manual` ще нема) запікається. |
| `app.py` non-workspace | помилка «нема жодної моделі» → **WARN** (manual працює і без моделей); manual перебудовується після CLI override-ів `images_dir/output_root`. | |

**Правило `output/` read-only:** `output/manual/*` пише Mask Picker (один раз, при першому
використанні stem). Після створення — так само read-only, як вихід сегментації: уся ручна робота
живе у `polygons/<stem>.json` (SoT), як і для інших моделей.

**Обсяг на диску:** 2 файли на фото лише для тих фото, де обрано `manual` (npy uint16: ~8 МБ на 2048×2048).

### Фронт
- Каталог: картка `manual` показується як **«✋ Ручна розмітка»** (`catalog.js`), номер — останній.
- Імпорт готових масок = **Multi-seed** (Shift+S): у ручному режимі джерела — маски інших моделей
  для цього фото; `manual` зі списку джерел виключено (`multiseed.js`).
- **Seed all (S) на `manual` заблоковано** з підказкою про Multi-seed: інакше він «замінив би полігони
  контурами порожньої маски» = стер би роботу (`polygons.js _polySeedFromMask`).
- Pick (P) на `manual` — «Тут немає інстанса» (коректно, маска порожня).
- Бейдж «N model(s)» рахує без `manual` (`app.js`).
- Експорт/імпорт workspace, «Зберегти все», Finalize — без змін (manual — звичайна модель у selections).

## 2. Розрив полігона — сеанс ремонту (`editor/repair.js`, tool `"break"`, клавіша **B**)

**Ключове рішення:** відкриті лінії **ніколи не потрапляють у дані**. Під час сеансу `pg.shapes[si]`
лишається старим замкненим полігоном (autosave/bake/groups/covered бачать лише його); фрагменти живуть
у `pg.repair`. Commit записує новий контур у **той самий індекс `si`** одним глобальним undo-записом →
`polygon_indices` груп не ламаються (клітина лишається у своїй групі; → `07`, `01`§3.3).

```
pg.repair = { si, pieces: [[[x,y],…],…], selPiece, extend: null|{piece,end:"start"|"end"}, undo: [] }
```

| Жест | Дія | Метод |
|---|---|---|
| клік по ребру полігона | старт сеансу; на місці кліку 2 нові точки-кінці | `_repairStart` (`hit.edge`,`hit.q`) |
| клік по точці полігона | старт; ця точка стає обома кінцями | `_repairStart` (`hit.vi`) |
| клік по ребру/внутр. точці фрагмента | розрив фрагмента на два; **коротший — обраний** | `_repairSplit` |
| Shift+клік по фрагменту | обрати/зняти | `_repairMouseDown` |
| Delete / «🗑 Фрагмент» | видалити обраний (не останній) | `_repairDeleteSelected` |
| клік по кінцю (біле коло) | домальовувати від нього (жовте коло) | `extend` |
| клік / Shift+рух під час домальовування | додати точку / freehand (15 px) | `_repairMouseDown/Move` |
| клік по кінцю іншого фрагмента | злиття фрагментів («об'єднати») | `_repairJoin` |
| клік по іншому кінцю свого фрагмента / Enter / «✔ Замкнути» | замкнути → commit (лише коли фрагмент 1) | `_repairCommit` |
| Backspace | прибрати останню домальовану точку | `_repairPopExtendPoint` |
| Ctrl+Z / ↶ | крок назад у сеансі; порожній стек → скасувати | `_repairUndo` (guard у `history._historyUndo`) |
| Esc | вийти з домальовування; ще раз — скасувати сеанс | `_repairOnKey` |
| зміна інструмента / табу, закриття редактора | скасувати сеанс (полігон без змін, toast) | `_setPolyTool`, `tabs.switchTab`, `index.close` |

- **Space НЕ замикає** (лишається pan): випадкове утримання не повинно завершувати ремонт.
- Інтеграція в `polygons.js`: mouse down/move/up і dblclick делегують у repair, коли `tool==="break"` або
  йде сеанс; shape `si` не малюється у shapes/vertices-шарах; draft-шар малює `_repairRedraw`
  (фрагменти — polyline, обраний — червоний пунктир, кінці — великі кола, прев'ю лінії до курсора).
- Commit: дедуп сусідніх однакових точок і замикаючого дубля; <3 точок → відмова.
- Глобальний redo під час сеансу ігнорується (стек сеансу окремий).

## 3. Перевірка (2026-11-07)
- pytest **247/247** (`tests/test_manual_mode.py`: discovery без дубля, каталог для фото без моделей,
  select створює порожню базу, bake полігона → `50000`, лінива матеріалізація для імпортованого stem).
- Браузер (Playwright, хмарна сесія; сценарій у scratchpad не комітиться): 19/19 — картка «✋ Ручна
  розмітка» для фото без масок; draw → розрив по ребру (6 точок, 2 кінці) → 2-й розрив (обрано коротший
  фрагмент) → видалення → домальовування → з'єднання з кінцем = замкнений полігон; глобальні Ctrl+Z /
  Ctrl+Shift+Z; Esc скасовує; Seed all на manual заблоковано; Multi-seed з `cyto2` → 2 контури;
  «Зберегти все» → `selected/manual/npy` з id 50000(+1); `bake_all.py --pack` → ZIP з
  masks/masks_npy/polygons/semantic/yolo. 0 JS-помилок.
- ❌ Не перевірено: на Windows у користувача; великі реальні датасети; розрив полігона, що входить у групу
  (логіка індексу не змінюється, але живого прогону не було).

## 4. Імпорт фото для ручної розмітки
«📥 Імпорт» приймає і архіви «просто з фото» (у корені чи підпапках), і окремі jpg/png — фото додаються у
`images/` поточного датасету, далі для кожного доступна «✋ Ручна розмітка». До 2026-11-07 такий імпорт
нічого не робив → F-015 у `_AUDIT_FINDINGS.md`.

## 5. Де лежать дані (stem `X`, модель `manual`)
| Файл | Хто пише | Примітка |
|---|---|---|
| `images/X.*` | імпорт / користувач | read-only для MP |
| `output/manual/npy/X.npy` | `ManualModelSource.ensure_base` | zeros uint16 H×W — «raw» основа |
| `output/manual/overlay/X.<ext>` | `ensure_base` | копія оригіналу (не jpg/png → PNG) |
| `selected/manual/{npy,overlay}/X` | `api_select` (копія raw), потім bake | після bake: npy з id 50000+k (k = індекс shape) |
| `selected/manual/{png,yolo,overlay}/X` | bake (cellsegkit) | derived |
| `polygons/X.json` | autosave / Save Polygons | **SoT** ручної розмітки (LabelMe) |
| `groups/X.json` · `selections.json` | як для будь-якої моделі | `selections[X].model == "manual"` |
| deliverable ZIP | `bake_all.py --pack` / Finalize | `images/ masks/ masks_npy/` (dense 1..N) `semantic/ overlays/ polygons/ yolo/` |

## 6. Відомі обмеження / відкрите
- Імпорт: «плоский» ZIP, де поруч лежать фото і маски-картинки, — маски теж стануть «фото». Зовнішні формати
  розмітки (COCO / CVAT / LabelMe з інших програм, PNG-маски без структури workspace) **не підтримуються** —
  мейнтейнер може попросити; тоді конвертувати у `polygons/X.json` (LabelMe) при імпорті.
- Розрив перевірено в браузері на намальованому полігоні; на полігонах із Multi-seed/Pick і на полігоні, що
  входить у групу, — лише за кодом (той самий шлях, індекс shape не змінюється).
- Кнопка «📥 Імпорт» у діалозі файлів показує лише `.jpg .jpeg .png .zip` (`index.html` `accept=`), бекенд
  приймає й `.tif/.tiff/.bmp` (усередині ZIP).
- Мейнтейнер перевірив на Windows (2026-11-07): ручна розмітка, імпорт ZIP з jpg, запікання — «працює».

## 7. Експорт / імпорт і повторна обробка (перевірено 2026-11-10)
Сценарій (scratchpad-скрипт, API як кнопки UI): ручна розмітка nucleus+vesicle + група → кожен вид експорту →
імпорт у новий датасет → відкрити в редакторі (маска-основа, Groups), дописати полігон, «Зберегти все».
**33/33 ✅** (після фіксів F-016/F-017/F-018).

| Експорт | Що в ZIP | Імпорт у новий датасет | Продовжити роботу |
|---|---|---|---|
| **📤 Експорт** (звичайний, `/api/workspace/export`) | `selected/ polygons/ groups/ selections.json labels.json group_classes.json overlays/<stem>__<клас>.png`; **без фото** | ✅ якщо фото вже є в датасеті; **у порожньому датасеті фото не з'являються** (розмітка є, а `images/` нема) | ✅ |
| + галочка **«📷 Додати фото»** (`?images=1`, 2026-11-12) | + `images/<фото>` + сирий вихід обраної моделі `output/<model>/{overlay,npy,png,yolo}/` (для `manual` — ні: `ensure_base` відтворює з фото) | ✅ **і в порожній датасет** | ✅ (тест `test_export_with_photos_opens_in_empty_dataset`, браузер) |
| + галочка «Маски» (`?masks=1`) | + `selected/<model>/semantic/`, `mask_groups/` | ✅ | ✅ |
| + галочка «Фіналізувати» | спершу запікання незапечених, далі як звичайний | ✅ | ✅ |
| + «Розбити на N» (Split) | N пакетів: `images/ output/<model>/ selected/ polygons/ groups/ labels.json group_classes.json selections.json` + `START_MASK_PICKER.bat`, README | ✅ навіть у порожній датасет | ✅ |
| `finalize/<stem>` (1 фото) | фото + розмітка одного stem + `labels.json` | ✅ | ✅ |
| Фінальний датасет `bake_all.py --pack` | `images/ masks/ masks_npy/ semantic/ overlays/ polygons/ yolo/ selections.json labels.json README` | ✅ (фото + полігони + стан) — **групи не входять** | ✅ |

Ручний режим після імпорту: `output/manual/` не експортується звичайним експортом — `ensure_base` відтворює
порожню основу з фото при першому зверненні (тому потрібні фото).

