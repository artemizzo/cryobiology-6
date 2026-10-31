#!/usr/bin/env bash
# Mask Picker — запуск через Docker (Linux). Аналог MaskPicker.ps1 для Windows.
#
#   З терміналу (для розробки):   ./tools/launchers/docker/mask-picker.sh
#     → усе видно в консолі; редактор на передньому плані, як `docker compose up` (Ctrl+C — зупинити).
#   З ярлика (create_shortcuts.sh):  mask-picker.sh --hidden
#     → віконце-статус (zenity, якщо є; інакше сповіщення). Якщо щось падає — відкривається
#       ТЕРМІНАЛ з повним логом і логами контейнера.
#
# Сам запускає Docker, якщо він не працює. Якщо редактор уже працює — лише відкриває браузер.
# Файли в data/ створюються від імені поточного користувача (MP_UID/MP_GID → docker-compose.yml).
# Датасет — DATASET у файлі .env (дефолт vesicles_good). Лог останнього запуску: _logs/launcher.log

set -u

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/../../.." && pwd)"
URL="http://localhost:5000"
LOG_DIR="$ROOT/_logs"
LOG="$LOG_DIR/launcher.log"

HIDDEN=0
[ "${1:-}" = "--hidden" ] && HIDDEN=1

cd "$ROOT" || exit 1
mkdir -p "$LOG_DIR"
echo "==== $(date '+%Y-%m-%d %H:%M:%S')  Mask Picker launcher (hidden=$HIDDEN)  root=$ROOT ====" > "$LOG"

export MP_UID="${MP_UID:-$(id -u)}" MP_GID="${MP_GID:-$(id -g)}"
# Інакше Docker створить їх сам — від root, і редактор (не root) не зможе туди писати.
mkdir -p "$ROOT/data" "$ROOT/_archive"

log() { echo "$*" >> "$LOG"; }
has() { command -v "$1" >/dev/null 2>&1; }
have_gui() { [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; }

# ── Віконце-статус ─────────────────────────────────────────────────────────
SPLASH_PID=""
start_splash() {
    if has zenity && have_gui; then
        local fifo
        fifo="$(mktemp -u)"
        mkfifo "$fifo"
        zenity --progress --pulsate --no-cancel --width=420 --title="Mask Picker" \
            --text="Запускається Mask Picker..." < "$fifo" 2>/dev/null &
        SPLASH_PID=$!
        exec 3>"$fifo"
        rm -f "$fifo"
    elif has notify-send && have_gui; then
        notify-send "Mask Picker" "Запускається... (перший раз — до 10 хв)" 2>/dev/null
    fi
}
stop_splash() {
    if [ -n "$SPLASH_PID" ]; then
        exec 3>&- 2>/dev/null
        kill "$SPLASH_PID" 2>/dev/null
        SPLASH_PID=""
    fi
}
status() {
    log "[status] $*"
    if [ -n "$SPLASH_PID" ]; then
        echo "# $*" >&3 2>/dev/null
    elif [ "$HIDDEN" = 0 ]; then
        printf '\033[36m>> %s\033[0m\n' "$*"
    fi
}

# ── Помилка: термінал з причиною ───────────────────────────────────────────
open_in_terminal() {   # $1 — скрипт, який треба показати
    local t
    for t in x-terminal-emulator gnome-terminal konsole xfce4-terminal mate-terminal tilix kitty alacritty xterm; do
        has "$t" || continue
        case "$t" in
            gnome-terminal|mate-terminal|tilix) "$t" -- bash "$1" & ;;
            *) "$t" -e bash "$1" & ;;
        esac
        return 0
    done
    return 1
}
fail() {
    log ""
    log "[ПОМИЛКА] $*"
    stop_splash
    if [ "$HIDDEN" = 1 ]; then
        local show="$LOG_DIR/show_error.sh"
        cat > "$show" <<EOF
cd "$ROOT"
printf '\033[31m=== Mask Picker не запустився. Лог запуску ($LOG): ===\033[0m\n'
cat "$LOG"
printf '\n\033[33m=== docker compose logs mask-picker (останні 200 рядків) ===\033[0m\n'
docker compose logs --no-color --tail 200 mask-picker
exec bash
EOF
        if ! { have_gui && open_in_terminal "$show"; }; then
            { have_gui && has zenity && zenity --text-info --width=900 --height=600 \
                --title="Mask Picker: помилка" --filename="$LOG" 2>/dev/null; } \
              || { have_gui && has notify-send && notify-send -u critical "Mask Picker не запустився" "Лог: $LOG"; }
        fi
    else
        printf '\033[31m[ПОМИЛКА] %s\033[0m\nПовний лог: %s\n' "$*" "$LOG"
    fi
    exit 1
}

docker_ready() { docker info >/dev/null 2>&1; }
editor_running() { [ -n "$(docker compose ps --status running --quiet mask-picker 2>/dev/null)" ]; }
editor_responds() {
    if has curl; then curl -fs -o /dev/null -m 2 "$URL"
    else python3 -c "import urllib.request,sys; urllib.request.urlopen(sys.argv[1], timeout=2)" "$URL" 2>/dev/null
    fi
}
open_browser() { has xdg-open && xdg-open "$URL" >/dev/null 2>&1 & }

# ── Основний сценарій ──────────────────────────────────────────────────────
[ "$HIDDEN" = 1 ] && start_splash

status "Перевіряю Docker..."
has docker || fail "Команду docker не знайдено. Встанови Docker Engine або Docker Desktop: https://docs.docker.com/engine/install/"

if ! docker_ready; then
    status "Запускаю Docker... (до 2-3 хв)"
    if systemctl --user cat docker-desktop.service >/dev/null 2>&1; then
        systemctl --user start docker-desktop >> "$LOG" 2>&1
    elif systemctl is-active --quiet docker 2>/dev/null; then
        fail "Docker працює, але в тебе немає до нього доступу. Виконай: sudo usermod -aG docker \$USER — і перелогінься."
    elif has systemctl; then
        systemctl start docker >> "$LOG" 2>&1 || { has pkexec && pkexec systemctl start docker >> "$LOG" 2>&1; }
    fi
    for _ in $(seq 90); do docker_ready && break; sleep 2; done
    docker_ready || fail "Docker не став готовим за 3 хвилини. Перевір: docker info"
fi
log "docker ready"

if editor_running && editor_responds; then
    status "Mask Picker уже працює — відкриваю браузер."
    stop_splash
    open_browser
    [ "$HIDDEN" = 0 ] && echo "Логи: docker compose logs -f mask-picker   Зупинити: docker compose down"
    exit 0
fi

if [ "$HIDDEN" = 0 ]; then
    # Режим розробника: як `docker compose up --build`, але з авто-відкриттям браузера.
    ( for _ in $(seq 900); do editor_responds && { open_browser; exit 0; }; sleep 1; done ) &
    status "Запускаю редактор (Ctrl+C — зупинити)..."
    docker compose up --build mask-picker
    exit $?
fi

status "Запускаю редактор... (перший раз або після оновлення — до 10 хв)"
log ""
log "> docker compose up -d --build mask-picker"
docker compose up -d --build mask-picker >> "$LOG" 2>&1 || fail "docker compose up завершився з помилкою (див. вивід вище)."

status "Чекаю, поки редактор відповість..."
for _ in $(seq 90); do
    editor_responds && break
    editor_running || fail "Контейнер редактора зупинився одразу після старту (впав)."
    sleep 1
done
editor_responds || fail "Редактор не відповів на $URL за 90 секунд."

log "editor ready -> $URL"
stop_splash
open_browser
exit 0
