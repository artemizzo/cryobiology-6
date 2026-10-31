@echo off
chcp 65001 > nul
REM Створює ярлик "Mask Picker" (Docker) на робочому столі та в меню Пуск.
REM Подвійний клік по цьому файлу. Детально: DOCKER.md.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\launchers\docker\create_shortcuts.ps1"
echo.
pause
