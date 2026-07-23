<#
  setup-proxy.ps1 — apunta las sesiones de OpenWA al SOCKS5 de una Raspberry Pi.

  Chromium no puede autenticar proxies SOCKS, y microsocks corre con usuario/contrasena.
  Este script levanta scripts/socks-relay.js (Node, sin dependencias) como puente: expone
  un SOCKS5 SIN credenciales en 127.0.0.1 y lo reenvia a la Pi CON las credenciales.
  Las Raspberrys no se tocan.

  Verificar (no toca nada):
    .\scripts\setup-proxy.ps1 -PiIp 100.104.50.91 -User raspproxy8 -Pass m4xtr3s2025

  Aplicar (configura las sesiones y las reinicia):
    .\scripts\setup-proxy.ps1 -PiIp 100.104.50.91 -User raspproxy8 -Pass m4xtr3s2025 -Apply
#>
param(
  [Parameter(Mandatory = $true)][string]$PiIp,
  [Parameter(Mandatory = $true)][string]$User,
  [Parameter(Mandatory = $true)][string]$Pass,
  [int]$PiPort = 1080,
  [int]$LocalPort = 1080,
  [string]$ApiUrl = 'http://localhost:3000',
  [string]$DbPath = './data/openwa.sqlite',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$relay = Join-Path $PSScriptRoot 'socks-relay.js'
$localProxy = "socks5://127.0.0.1:$LocalPort"

function Step($n, $m) { Write-Host "`n[$n] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Fail($m) { Write-Host "  X   $m" -ForegroundColor Red }

# --- 1. Alcance a la Pi por Tailscale -----------------------------------------
Step 1 "Verificando alcance a la Pi ($PiIp)"
if (-not (Test-Connection -ComputerName $PiIp -Count 1 -Quiet -ErrorAction SilentlyContinue)) {
  Fail "No hay respuesta de $PiIp. Revisa que Tailscale este conectado EN ESTA MAQUINA."
  exit 1
}
Ok "La Pi responde."

# --- 2. Puente Node ------------------------------------------------------------
Step 2 "Levantando el puente SOCKS5 en 127.0.0.1:$LocalPort"
if (Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue) {
  Ok "Ya hay algo escuchando en $LocalPort (asumo que es el puente)."
} else {
  Start-Process node -ArgumentList "`"$relay`"","--listen","127.0.0.1:$LocalPort",
    "--upstream","${User}:${Pass}@${PiIp}:${PiPort}" -WindowStyle Hidden
  Start-Sleep -Seconds 2
  if (Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue) {
    Ok "Puente levantado."
  } else {
    Fail "El puente no llego a escuchar en $LocalPort."; exit 1
  }
}

# --- 3. Prueba de fuego: IP de salida real -------------------------------------
Step 3 "Comprobando la IP de salida a traves del puente"
$ipDirecta = curl.exe -s --max-time 15 https://api.ipify.org
$ipProxy   = curl.exe -s --max-time 25 --socks5-hostname "127.0.0.1:$LocalPort" https://api.ipify.org
if (-not $ipProxy) {
  Fail "Sin respuesta por el proxy. Revisa usuario/contrasena o que microsocks este activo en la Pi."
  exit 1
}
Write-Host "      IP sin proxy : $ipDirecta"
Write-Host "      IP con proxy : $ipProxy"
if ($ipProxy -eq $ipDirecta) { Fail "Son iguales: el trafico NO sale por la Pi."; exit 1 }
Ok "El trafico sale por la IP residencial de la Pi."

if (-not $Apply) {
  Write-Host "`nVerificacion OK. Volve a correr con -Apply para configurar las sesiones." -ForegroundColor Cyan
  exit 0
}

# --- 4. Escribir el proxy en TODAS las sesiones --------------------------------
Step 4 "Asignando $localProxy a las sesiones"
$dbAbs = (Resolve-Path (Join-Path $root ($DbPath -replace '^\./',''))).Path -replace '\\','/'
$js = "const db=require('better-sqlite3')('$dbAbs');" +
      "db.prepare(`"update sessions set proxyUrl=?, proxyType='socks5'`").run('$localProxy');" +
      "console.log(JSON.stringify(db.prepare('select id,name from sessions').all()));"
Push-Location $root
$filas = node -e $js | ConvertFrom-Json
Pop-Location
$filas | ForEach-Object { Write-Host "      $($_.name) -> $localProxy" }
Ok "Base actualizada."

# --- 5. Reiniciar las sesiones (stop + start; sin re-escanear QR) --------------
Step 5 "Reiniciando las sesiones"
$key = (Get-Content (Join-Path $root 'data/.api-key') -Raw).Trim()
$headers = @{ 'x-api-key' = $key }
foreach ($s in $filas) {
  try {
    Invoke-RestMethod -Method Post -Uri "$ApiUrl/sessions/$($s.id)/stop"  -Headers $headers | Out-Null
    Start-Sleep -Seconds 3
    Invoke-RestMethod -Method Post -Uri "$ApiUrl/sessions/$($s.id)/start" -Headers $headers | Out-Null
    Ok "$($s.name) reiniciada."
  } catch { Fail "$($s.name): $($_.Exception.Message)" }
  Start-Sleep -Seconds 20  # escalonado: 10 sesiones sincronizando a la vez saturan una Pi 3A+
}
Write-Host "`nListo. En los logs deberias ver 'Using proxy: $localProxy' por sesion." -ForegroundColor Green
