<#
Mask Picker — запуск через Docker (Windows).

  Ярлик (створює create_shortcuts.bat у корені):
      powershell -WindowStyle Hidden -File MaskPicker.ps1 -Hidden
    → віконце зі статусом замість консолі. Якщо щось падає — відкривається КОНСОЛЬ
      з повним логом і логами контейнера (а не кастомне повідомлення).

  Вручну з PowerShell (для розробки):
      .\tools\launchers\docker\MaskPicker.ps1
    → усе видно в консолі; редактор працює на передньому плані, як `docker compose up`
      (Ctrl+C — зупинити). Браузер відкриється сам, коли сервер відповість.

  Сам запускає Docker Desktop, якщо він не працює. Якщо редактор уже працює — лише відкриває браузер.
  Редактор зупиняється разом із Docker Desktop і сам після старту Docker не запускається.
  Датасет — як у docker compose: змінна DATASET у файлі .env (дефолт vesicles_good).
  Лог останнього запуску: _logs\launcher.log
#>
param([switch]$Hidden)

$ErrorActionPreference = "Continue"   # помилки рахуємо за кодами виходу docker, а не за stderr

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$Url = "http://localhost:5000"
$LogDir = Join-Path $Root "_logs"
$Log = Join-Path $LogDir "launcher.log"

Set-Location $Root
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Content -Path $Log -Encoding UTF8 -Value "==== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  Mask Picker launcher (Hidden=$Hidden)  root=$Root ===="

function Write-Log([string]$Text) { Add-Content -Path $Log -Encoding UTF8 -Value $Text }

# ── Віконце-статус (лише в режимі ярлика) ──────────────────────────────────
$script:Form = $null
$script:Label = $null

function Show-Splash {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $f = New-Object System.Windows.Forms.Form
    $f.Text = "Mask Picker"
    $f.Size = New-Object System.Drawing.Size(440, 140)
    $f.StartPosition = "CenterScreen"
    $f.FormBorderStyle = "FixedDialog"
    $f.ControlBox = $false
    $f.TopMost = $true
    $l = New-Object System.Windows.Forms.Label
    $l.Dock = "Fill"
    $l.TextAlign = "MiddleCenter"
    $l.Font = New-Object System.Drawing.Font("Segoe UI", 11)
    $l.Text = "Запускається Mask Picker..."
    $p = New-Object System.Windows.Forms.ProgressBar
    $p.Style = "Marquee"
    $p.Dock = "Bottom"
    $f.Controls.Add($l)
    $f.Controls.Add($p)
    $f.Show()
    [System.Windows.Forms.Application]::DoEvents()
    $script:Form = $f
    $script:Label = $l
}

function Close-Splash {
    if ($script:Form) { $script:Form.Close(); $script:Form = $null }
}

# Пауза, під час якої віконце лишається «живим» (не «Не відповідає»).
function Wait-Ms([int]$Ms) {
    $until = (Get-Date).AddMilliseconds($Ms)
    while ((Get-Date) -lt $until) {
        if ($script:Form) { [System.Windows.Forms.Application]::DoEvents() }
        Start-Sleep -Milliseconds 100
    }
}

function Set-Status([string]$Text) {
    Write-Log "[status] $Text"
    if ($script:Label) {
        $script:Label.Text = $Text
        [System.Windows.Forms.Application]::DoEvents()
    } else {
        Write-Host ">> $Text" -ForegroundColor Cyan
    }
}

# ── Помилка: консоль з причиною ────────────────────────────────────────────
function Fail([string]$Reason) {
    Write-Log ""
    Write-Log "[ПОМИЛКА] $Reason"
    Close-Splash
    if ($Hidden) {
        $show = Join-Path $LogDir "show_error.ps1"
        $lines = @(
            "Set-Location '$Root'",
            "Write-Host '=== Mask Picker не запустився. Лог запуску ($Log): ===' -ForegroundColor Red",
            "Get-Content -Encoding UTF8 '$Log'",
            "Write-Host ''",
            "Write-Host '=== docker compose logs mask-picker (останні 200 рядків) ===' -ForegroundColor Yellow",
            "docker compose logs --no-color --tail 200 mask-picker"
        )
        # UTF-8 з BOM — інакше Windows PowerShell 5.1 ламає кирилицю.
        [System.IO.File]::WriteAllLines($show, $lines, (New-Object System.Text.UTF8Encoding($true)))
        Start-Process powershell.exe -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$show`"")
    } else {
        Write-Host "[ПОМИЛКА] $Reason" -ForegroundColor Red
        Write-Host "Повний лог: $Log"
    }
    exit 1
}

# Запуск docker-команди з логом. У режимі ярлика — фоновим процесом, щоб віконце не зависало.
function Invoke-Docker([string[]]$DockerArgs) {
    Write-Log ""
    Write-Log "> docker $($DockerArgs -join ' ')"
    if (-not $Hidden) {
        & docker @DockerArgs 2>&1 | ForEach-Object { $s = "$_"; Write-Host $s; Write-Log $s }
        return $LASTEXITCODE
    }
    $out = Join-Path $LogDir "docker.out"
    $err = Join-Path $LogDir "docker.err"
    $p = Start-Process -FilePath "docker" -ArgumentList $DockerArgs -NoNewWindow -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err -WorkingDirectory $Root
    $null = $p.Handle   # без цього ExitCode після завершення буває порожнім
    while (-not $p.HasExited) { Wait-Ms 300 }
    $p.WaitForExit()
    foreach ($f in @($out, $err)) {
        if (Test-Path $f) { Get-Content $f | ForEach-Object { Write-Log "$_" } }
    }
    return $p.ExitCode
}

# Docker Desktop може стояти не в Program Files (встановлення «лише для поточного користувача»).
# Шукаємо: поруч із docker.exe (<install>\resources\bin\docker.exe), у реєстрі, у типових папках.
function Find-DockerDesktop {
    $candidates = @()
    $cmd = Get-Command docker -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        $candidates += Join-Path (Split-Path (Split-Path (Split-Path $cmd.Source))) "Docker Desktop.exe"
    }
    foreach ($key in @(
            "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop",
            "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop")) {
        $loc = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).InstallLocation
        if ($loc) { $candidates += Join-Path $loc "Docker Desktop.exe" }
    }
    $candidates += Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    $candidates += Join-Path $env:LOCALAPPDATA "Programs\Docker\Docker\Docker Desktop.exe"
    $candidates += Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe"
    foreach ($c in $candidates) {
        Write-Log "  шукаю Docker Desktop: $c"
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return $null
}

function Test-DockerReady {
    & docker info *> $null
    return ($LASTEXITCODE -eq 0)
}

function Test-EditorRunning {
    $id = & docker compose ps --status running --quiet mask-picker 2>$null
    return [bool]$id
}

function Test-EditorResponds {
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

# ── Основний сценарій ──────────────────────────────────────────────────────
if ($Hidden) { Show-Splash }

Set-Status "Перевіряю Docker..."
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail "Команду docker не знайдено. Встанови Docker Desktop: https://www.docker.com/products/docker-desktop/"
}

if (-not (Test-DockerReady)) {
    $DockerDesktopExe = Find-DockerDesktop
    if (-not $DockerDesktopExe) {
        Fail "Docker не запущений, і Docker Desktop не знайдено (перелік перевірених шляхів — вище). Запусти Docker Desktop вручну."
    }
    Write-Log "Docker Desktop: $DockerDesktopExe"
    Set-Status "Запускаю Docker Desktop... (до 2-3 хв)"
    Start-Process -FilePath $DockerDesktopExe
    $deadline = (Get-Date).AddMinutes(3)
    while (-not (Test-DockerReady)) {
        if ((Get-Date) -gt $deadline) {
            Fail "Docker Desktop не став готовим за 3 хвилини. Відкрий Docker Desktop і подивись, що він пише (внизу має бути 'Engine running')."
        }
        Wait-Ms 2000
    }
}
Write-Log "docker ready"

if ((Test-EditorRunning) -and (Test-EditorResponds)) {
    Set-Status "Mask Picker уже працює — відкриваю браузер."
    Close-Splash
    Start-Process $Url
    if (-not $Hidden) { Write-Host "Логи: docker compose logs -f mask-picker   Зупинити: docker compose down" }
    exit 0
}

if (-not $Hidden) {
    # Режим розробника: як `docker compose up --build`, але з авто-відкриттям браузера.
    Start-Job -ArgumentList $Url -ScriptBlock {
        param($u)
        for ($i = 0; $i -lt 900; $i++) {
            try {
                $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 2
                if ($r.StatusCode -eq 200) { Start-Process $u; return }
            } catch { }
            Start-Sleep -Seconds 1
        }
    } | Out-Null
    Set-Status "Запускаю редактор (Ctrl+C — зупинити)..."
    & docker compose up --build mask-picker
    exit $LASTEXITCODE
}

Set-Status "Запускаю редактор...`n(перший раз або після оновлення — до 10 хв)"
$code = Invoke-Docker @("compose", "up", "-d", "--build", "mask-picker")
if ($code -ne 0) { Fail "docker compose up завершився з кодом $code (див. вивід вище)." }

Set-Status "Чекаю, поки редактор відповість..."
$deadline = (Get-Date).AddSeconds(90)
while (-not (Test-EditorResponds)) {
    if (-not (Test-EditorRunning)) { Fail "Контейнер редактора зупинився одразу після старту (впав)." }
    if ((Get-Date) -gt $deadline) { Fail "Редактор не відповів на $Url за 90 секунд." }
    Wait-Ms 1000
}

Write-Log "editor ready -> $Url"
Close-Splash
Start-Process $Url
exit 0
