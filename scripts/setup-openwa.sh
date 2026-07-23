#!/usr/bin/env bash
# Instala Git y Docker si faltan, clona OpenWA, configura .env y levanta el stack dev.
# Para distribuciones basadas en Debian/Ubuntu (apt).
set -euo pipefail

# data/.api-key queda con permisos 0600 dentro del bind mount; se necesita root para leerlo.
if [ "$EUID" -ne 0 ]; then
  echo "Se requieren permisos sudo (para leer data/.api-key, entre otras cosas). Solicitando..."
  exec sudo --preserve-env=HOME "$0" "$@"
fi

if ! command -v git &>/dev/null; then
  echo "Instalando Git..."
  apt-get update
  apt-get install -y git
fi

if ! command -v docker &>/dev/null; then
  echo "Instalando Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

echo "Esperando a que Docker esté listo..."
deadline=$(( $(date +%s) + 180 ))
until docker info &>/dev/null; do
  if [ "$(date +%s)" -gt "$deadline" ]; then
    echo "Docker no respondió a tiempo. Ábrelo manualmente y vuelve a correr el script." >&2
    exit 1
  fi
  sleep 5
done

# Añade whatsapp.local a hosts para abrir la app en el navegador (puerto 80, sin sufijo en la URL)
if ! grep -q 'whatsapp\.local' /etc/hosts; then
  echo "127.0.0.1 whatsapp.local" >> /etc/hosts
fi

# Clona el repo (o actualiza si ya existe, para recoger cambios como el mapeo de puerto)
openwa_path="$HOME/openwa"
if [ ! -d "$openwa_path" ]; then
  git clone https://github.com/z0m0dan/OpenWA "$openwa_path"
fi
cd "$openwa_path"
# reset --hard (not pull --ff-only) so a dirty tracked file — e.g. from a previous root-owned
# run — can never block picking up upstream changes; this must stay deterministic/replicable.
git fetch origin
git reset --hard origin/main

# El script corre como root (sudo), así que git deja .git con dueño root; sin esto, el usuario
# de la sesión no puede volver a hacer git fetch/pull a mano después ("Permiso denegado").
if [ -n "${SUDO_USER:-}" ]; then
  chown -R "$SUDO_USER:$SUDO_USER" "$openwa_path/.git"
fi

# Configura .env
cp -f .env.minimal .env

# Levanta el proyecto (sin API_MASTER_KEY: OpenWA genera una admin key sola en el primer arranque)
docker compose -f docker-compose.dev.yml up -d --build --remove-orphans

echo "Esperando a que la aplicación termine de iniciar..."
deadline=$(( $(date +%s) + 120 ))
until docker compose -f docker-compose.dev.yml logs openwa 2>/dev/null | grep -q 'Nest application successfully started'; do
  if [ "$(date +%s)" -gt "$deadline" ]; then
    echo "La app no terminó de iniciar a tiempo. Revisa: docker compose -f docker-compose.dev.yml logs openwa" >&2
    exit 1
  fi
  sleep 3
done

api_key="$(cat data/.api-key 2>/dev/null || true)"
if [ -n "$api_key" ]; then
  echo ""
  echo "🔑 API Key generada por OpenWA: $api_key"
  echo "🌐 Abre http://whatsapp.local en el navegador"
  echo ""
else
  echo "No se encontró data/.api-key. Revisa manualmente con: docker compose -f docker-compose.dev.yml logs openwa"
fi
