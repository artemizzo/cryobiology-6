#!/usr/bin/env bash
# Створює ярлик «Mask Picker» у меню програм (і на робочому столі, якщо він є) — Linux.
# Запускати через ./create_shortcuts.sh у корені проєкту. Якщо папку перенесли — запусти ще раз.
# Також записує MP_UID/MP_GID у .env, щоб і ручний `docker compose up` створював файли від твого імені.
set -eu

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/../../.." && pwd)"
LAUNCHER="$ROOT/tools/launchers/docker/mask-picker.sh"
chmod +x "$LAUNCHER"

# .env: дописати MP_UID/MP_GID, не чіпаючи інших рядків (напр. DATASET).
ENV_FILE="$ROOT/.env"
touch "$ENV_FILE"
sed -i '/^MP_UID=/d; /^MP_GID=/d' "$ENV_FILE"
printf 'MP_UID=%s\nMP_GID=%s\n' "$(id -u)" "$(id -g)" >> "$ENV_FILE"
mkdir -p "$ROOT/data" "$ROOT/_archive"   # щоб їх не створив Docker від root
echo "Оновлено: $ENV_FILE (MP_UID=$(id -u), MP_GID=$(id -g))"

APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPS_DIR"
DESKTOP_FILE="$APPS_DIR/mask-picker.desktop"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Mask Picker
Comment=Mask Picker (Docker)
Exec="$LAUNCHER" --hidden
Path=$ROOT
Icon=applications-science
Terminal=false
Categories=Science;Graphics;
EOF
chmod +x "$DESKTOP_FILE"
echo "Створено: $DESKTOP_FILE"

DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
if [ -d "$DESKTOP_DIR" ] && [ "$DESKTOP_DIR" != "$HOME" ]; then
    cp "$DESKTOP_FILE" "$DESKTOP_DIR/mask-picker.desktop"
    chmod +x "$DESKTOP_DIR/mask-picker.desktop"
    # GNOME: позначити як довірений, інакше ярлик не запускається подвійним кліком.
    gio set "$DESKTOP_DIR/mask-picker.desktop" metadata::trusted true 2>/dev/null || true
    echo "Створено: $DESKTOP_DIR/mask-picker.desktop"
fi
