#!/usr/bin/env bash
# Створює ярлик "Mask Picker" (Docker) у меню програм / на робочому столі. Детально: DOCKER.md.
exec bash "$(dirname "$(readlink -f "$0")")/tools/launchers/docker/create_shortcuts.sh"
