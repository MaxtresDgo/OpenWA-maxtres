#!/usr/bin/env bash
# Instala Git y Docker si faltan, clona OpenWA, configura .env y levanta el stack dev.
# Para distribuciones basadas en Debian/Ubuntu (apt).
set -euo pipefail

if ! command -v git &>/dev/null; then
  echo "Instalando Git..."
  sudo apt-get update
  sudo apt-get install -y git
fi

if ! command -v docker &>/dev/null; then
  echo "Instalando Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  sudo systemctl enable --now docker
fi

# Recién instalado, el grupo docker no aplica hasta re-loguear: usa sudo mientras tanto.
DOCKER="docker"
COMPOSE="docker compose"
if ! docker info &>/dev/null 2>&1; then
  DOCKER="sudo docker"
  COMPOSE="sudo docker compose"
fi

echo "Esperando a que Docker esté listo..."
deadline=$(( $(date +%s) + 180 ))
until $DOCKER info &>/dev/null; do
  if [ "$(date +%s)" -gt "$deadline" ]; then
    echo "Docker no respondió a tiempo. Ábrelo manualmente y vuelve a correr el script." >&2
    exit 1
  fi
  sleep 5
done

# Añade whatsapp.local a hosts para abrir la app en el navegador (puerto 80, sin sufijo en la URL)
if ! grep -q 'whatsapp\.local' /etc/hosts; then
  echo "127.0.0.1 whatsapp.local" | sudo tee -a /etc/hosts > /dev/null
fi

# Clona el repo
openwa_path="$HOME/openwa"
if [ ! -d "$openwa_path" ]; then
  git clone https://github.com/rmyndharis/OpenWA "$openwa_path"
fi
cd "$openwa_path"

# Configura .env
cp -f .env.minimal .env

# Levanta el proyecto (sin API_MASTER_KEY: OpenWA genera una admin key sola en el primer arranque)
$COMPOSE -f docker-compose.dev.yml up -d --build --remove-orphans

# La key completa solo se imprime en el primer arranque; en arranques posteriores el log la trunca
# y remite a data/.api-key, así que la leemos de ahí (bind-mounted al host en ./data).
echo "Esperando a que OpenWA genere su API key..."
deadline=$(( $(date +%s) + 120 ))
api_key=""
while [ -z "$api_key" ] && [ "$(date +%s)" -le "$deadline" ]; do
  logs="$($COMPOSE -f docker-compose.dev.yml logs openwa 2>/dev/null)"
  api_key="$(grep -oE 'owa_k1_[0-9a-f]{64}' <<< "$logs" | head -n1 || true)"
  if [ -z "$api_key" ] && grep -q 'full key in data/.api-key' <<< "$logs"; then
    api_key="$(cat data/.api-key 2>/dev/null || true)"
  fi
  [ -z "$api_key" ] && sleep 3
done

if [ -n "$api_key" ]; then
  echo ""
  echo "🔑 API Key generada por OpenWA: $api_key"
  echo "🌐 Abre http://whatsapp.local en el navegador"
  echo ""
else
  echo "No se encontró la API key en los logs a tiempo. Revísala con: $COMPOSE -f docker-compose.dev.yml logs openwa"
fi

echo "Mostrando logs (Ctrl+C para salir)..."
$COMPOSE -f docker-compose.dev.yml logs -f
