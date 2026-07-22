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

# La key generada se imprime una sola vez en el banner de arranque, con prefijo owa_k1_
echo "Esperando a que OpenWA genere su API key..."
deadline=$(( $(date +%s) + 120 ))
api_key=""
while [ -z "$api_key" ] && [ "$(date +%s)" -le "$deadline" ]; do
  api_key="$($COMPOSE -f docker-compose.dev.yml logs openwa 2>/dev/null | grep -oE 'owa_k1_[0-9a-f]{64}' | head -n1 || true)"
  [ -z "$api_key" ] && sleep 3
done

if [ -n "$api_key" ]; then
  echo ""
  echo "🔑 API Key generada por OpenWA: $api_key"
  echo ""
else
  echo "No se encontró la API key en los logs a tiempo. Revísala con: $COMPOSE -f docker-compose.dev.yml logs openwa"
fi
