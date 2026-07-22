# Instala Git y Docker si faltan, clona OpenWA, configura .env y levanta el stack dev.
# Requiere winget (incluido en Windows 10 1809+/11).

$ErrorActionPreference = "Stop"

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Instalando Git..."
    winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
    Refresh-Path
}

function Test-WslReady {
    # wsl.exe existe como stub aunque la feature no esté habilitada; "wsl --status" sí falla si no lo está.
    wsl --status *> $null
    return $LASTEXITCODE -eq 0
}

if (-not (Test-WslReady)) {
    Write-Host "Instalando/habilitando WSL (requerido por Docker Desktop)..."
    wsl --install --no-distribution

    $wslDeadline = (Get-Date).AddSeconds(30)
    while (-not (Test-WslReady) -and (Get-Date) -lt $wslDeadline) {
        Start-Sleep -Seconds 3
    }

    if (-not (Test-WslReady)) {
        Write-Host "WSL requiere reiniciar el equipo. Reinicia y vuelve a correr este script para continuar."
        exit
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "Instalando Docker Desktop..."
    winget install --id Docker.DockerDesktop -e --source winget --accept-package-agreements --accept-source-agreements
    Refresh-Path
}

# Docker Desktop corre como app/servicio; arráncalo y espera a que el daemon responda.
$dockerDesktop = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
if (-not (Get-Process "Docker Desktop" -ErrorAction SilentlyContinue) -and (Test-Path $dockerDesktop)) {
    Start-Process $dockerDesktop
}
Write-Host "Esperando a que Docker esté listo..."
$deadline = (Get-Date).AddMinutes(3)
while ($true) {
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { break }
    if ((Get-Date) -gt $deadline) {
        throw "Docker no respondió a tiempo. Ábrelo manualmente (primer arranque puede requerir habilitar WSL2/reiniciar) y vuelve a correr el script."
    }
    Start-Sleep -Seconds 5
}

# Clona el repo
$openwaPath = Join-Path $HOME "openwa"
if (-not (Test-Path $openwaPath)) {
    git clone https://github.com/rmyndharis/OpenWA $openwaPath
}
Set-Location $openwaPath

# Configura .env
Copy-Item .env.minimal .env -Force

# Levanta el proyecto (sin API_MASTER_KEY: OpenWA genera una admin key sola en el primer arranque)
docker compose -f docker-compose.dev.yml up -d --build --remove-orphans

# La key generada se imprime una sola vez en el banner de arranque, con prefijo owa_k1_
Write-Host "Esperando a que OpenWA genere su API key..."
$deadline = (Get-Date).AddMinutes(2)
$apiKey = $null
while (-not $apiKey -and (Get-Date) -lt $deadline) {
    $found = docker compose -f docker-compose.dev.yml logs openwa 2>$null |
        Select-String -Pattern 'owa_k1_[0-9a-f]{64}' | Select-Object -First 1
    if ($found) { $apiKey = $found.Matches[0].Value }
    if (-not $apiKey) { Start-Sleep -Seconds 3 }
}

if ($apiKey) {
    Write-Host ""
    Write-Host "🔑 API Key generada por OpenWA: $apiKey"
    Write-Host ""
} else {
    Write-Host "No se encontró la API key en los logs a tiempo. Revísala con: docker compose -f docker-compose.dev.yml logs openwa"
}
