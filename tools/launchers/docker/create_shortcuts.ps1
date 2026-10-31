<#
Створює ярлик «Mask Picker» на робочому столі та в меню «Пуск» (Windows).
Запускати через create_shortcuts.bat у корені проєкту (подвійний клік).
Ярлик тихо (без консолі) запускає MaskPicker.ps1 -Hidden.
Якщо папку проєкту перенесли — просто запусти ще раз.
#>
$ErrorActionPreference = "Stop"

$Launcher = Join-Path $PSScriptRoot "MaskPicker.ps1"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$PowerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

$targets = @(
    [Environment]::GetFolderPath("Desktop"),
    [Environment]::GetFolderPath("Programs")   # меню «Пуск»
)

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in $targets) {
    $path = Join-Path $dir "Mask Picker.lnk"
    $s = $shell.CreateShortcut($path)
    $s.TargetPath = $PowerShellExe
    $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`" -Hidden"
    $s.WorkingDirectory = $Root
    $s.Description = "Mask Picker (Docker)"
    $s.IconLocation = "$env:SystemRoot\System32\shell32.dll,177"
    $s.WindowStyle = 7   # згорнуте вікно — менше блимання консолі
    $s.Save()
    Write-Host "Створено: $path"
}
