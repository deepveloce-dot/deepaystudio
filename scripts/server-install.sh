#!/usr/bin/env bash
# scripts/server-install.sh
#
# Modaui Studio – One-shot Ubuntu Server Setup
#
# Usage:
#   sudo ./scripts/server-install.sh
#   sudo ./scripts/server-install.sh --ip 51.38.123.49 --api-key sk-mysecret
#   sudo ./scripts/server-install.sh --ip 51.38.123.49 --api-key sk-mysecret --port 23333 --user modauistudio
#
# What this script does
# ─────────────────────
#   1. Installs system dependencies (Xvfb, Nginx, sqlite3, etc.)
#   2. Creates a dedicated service user
#   3. Downloads & installs the latest Modaui Studio Linux .deb
#   4. Starts the app once to initialise the SQLite database (migrations)
#   5. Configures the CSaaS API server via sqlite3
#      – enabled=true, host=0.0.0.0, port=<PORT>, api_key=<KEY>
#   6. Creates and enables systemd services (xvfb, modaui-studio)
#   7. Generates a self-signed TLS certificate for the server IP
#   8. Configures Nginx as an HTTPS reverse proxy → localhost:<PORT>
#
# Required secrets (GitHub Secrets for CI/CD):
#   DEPLOY_HOST      – server IP / hostname
#   DEPLOY_USER      – SSH username (must have sudo)
#   DEPLOY_SSH_KEY   – private SSH key (PEM)
#
# After install the API is reachable at:
#   https://<IP>/          – API root
#   https://<IP>/health    – health check
#   https://<IP>/v1/chat/completions  – OpenAI-compatible endpoint

set -euo pipefail

# ─── colours ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

log()     { echo -e "${BLUE}[install]${RESET} $*"; }
success() { echo -e "${GREEN}[install]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[install]${RESET} $*"; }
die()     { echo -e "${RED}[install]${RESET} $*" >&2; exit 1; }

# ─── defaults ────────────────────────────────────────────────────────────────
SERVER_IP=""
CSAAS_PORT=23333
SERVICE_USER="modauistudio"
API_KEY=""
GITHUB_REPO="deepveloce-dot/deepaystudio"
DEB_FILE=""   # supply a local .deb path to skip download

# ─── argument parsing ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ip)       SERVER_IP="$2";    shift 2 ;;
    --api-key)  API_KEY="$2";      shift 2 ;;
    --port)     CSAAS_PORT="$2";   shift 2 ;;
    --user)     SERVICE_USER="$2"; shift 2 ;;
    --deb)      DEB_FILE="$2";     shift 2 ;;
    --help|-h)
      sed -n '/^# Usage/,/^[^#]/p' "$0" | head -n -1 | sed 's/^# \?//'
      exit 0 ;;
    *) die "Unknown argument: $1  (use --help for usage)" ;;
  esac
done

# ─── pre-flight ───────────────────────────────────────────────────────────────
echo -e "\n${BOLD}Modaui Studio – Server Install${RESET}\n"

[[ "$EUID" -eq 0 ]] || die "Please run as root:  sudo $0 $*"

. /etc/os-release 2>/dev/null || true
[[ "${ID:-}" == "ubuntu" || "${ID_LIKE:-}" == *"ubuntu"* || "${ID_LIKE:-}" == *"debian"* ]] \
  || warn "This script is designed for Ubuntu/Debian. Continuing anyway..."

# Auto-detect public IP if not supplied
if [[ -z "$SERVER_IP" ]]; then
  SERVER_IP=$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || true)
  [[ -n "$SERVER_IP" ]] || SERVER_IP="127.0.0.1"
  warn "No --ip supplied; detected public IP: ${SERVER_IP}"
fi

if [[ -z "$API_KEY" ]]; then
  warn "No --api-key supplied; generating a random key."
  API_KEY="sk-$(tr -dc 'a-zA-Z0-9' </dev/urandom 2>/dev/null | head -c 32 || openssl rand -hex 16)"
fi

log "Configuration:"
log "  Server IP    : ${SERVER_IP}"
log "  CSaaS port   : ${CSAAS_PORT}"
log "  Service user : ${SERVICE_USER}"
log "  API key      : ${API_KEY:0:8}…  (stored securely)"

# ─── 1. system dependencies ───────────────────────────────────────────────────
log "Installing system dependencies…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl wget sqlite3 \
  xvfb x11-utils \
  nginx openssl \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2 \
  libxfixes3 libxext6 libx11-6 libx11-xcb1 libxcb1 \
  libxtst6 libevdev2
success "System dependencies installed ✓"

# ─── 2. service user ─────────────────────────────────────────────────────────
if ! id "$SERVICE_USER" &>/dev/null; then
  log "Creating service user '${SERVICE_USER}'…"
  useradd --system --create-home --shell /bin/bash "$SERVICE_USER"
  success "User '${SERVICE_USER}' created ✓"
else
  log "Service user '${SERVICE_USER}' already exists, skipping."
fi

SERVICE_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
USERDATA_DIR="${SERVICE_HOME}/.config/Modaui Studio"
DB_PATH="${USERDATA_DIR}/modauistudio.sqlite"

# ─── 3. download / install .deb ───────────────────────────────────────────────
if [[ -z "$DEB_FILE" ]]; then
  log "Fetching latest Linux .deb from GitHub Releases…"

  RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest")
  DEB_URL=$(echo "$RELEASE_JSON" \
    | grep -o '"browser_download_url": "[^"]*\.deb"' \
    | grep -i "x64\|amd64" \
    | head -1 \
    | cut -d'"' -f4)

  if [[ -z "$DEB_URL" ]]; then
    die "Could not find a Linux x64 .deb in the latest GitHub release.
         Build one first with:  pnpm build:linux  or trigger the auto-deploy workflow."
  fi

  DEB_FILE="/tmp/modaui-studio-latest.deb"
  log "Downloading: ${DEB_URL}"
  wget -q -O "$DEB_FILE" "$DEB_URL"
  success "Downloaded .deb ✓"
else
  log "Using local .deb: ${DEB_FILE}"
  [[ -f "$DEB_FILE" ]] || die "Local .deb not found: ${DEB_FILE}"
fi

log "Installing .deb package…"
dpkg -i "$DEB_FILE" || apt-get install -f -y -qq
success "Modaui Studio installed ✓"

# Resolve the binary (electron-builder puts a symlink in /usr/bin)
CS_BIN=$(command -v ModauiStudio 2>/dev/null || command -v modaui-studio 2>/dev/null \
         || dpkg -L modaui-studio 2>/dev/null | grep '/usr/bin/' | head -1 \
         || find /usr/lib -name 'ModauiStudio' -type f 2>/dev/null | head -1 \
         || true)
[[ -n "$CS_BIN" ]] || die "Cannot locate the ModauiStudio binary. Check the .deb installation."
log "Binary: ${CS_BIN}"

# ─── 4. initialise SQLite DB (first-run) ─────────────────────────────────────
if [[ ! -f "$DB_PATH" ]]; then
  log "First run: starting Modaui Studio to initialise the database…"

  # Start a temporary Xvfb
  Xvfb :98 -screen 0 1280x720x24 -ac &
  XVFB_PID=$!
  sleep 2

  # Start Modaui Studio as the service user; give it up to 20 s to init
  sudo -u "$SERVICE_USER" DISPLAY=:98 HOME="$SERVICE_HOME" \
    "$CS_BIN" --no-sandbox &>/tmp/cs-init.log &
  CS_PID=$!

  WAIT=0
  until [[ -f "$DB_PATH" ]] || (( WAIT >= 20 )); do
    sleep 1; (( WAIT++ ))
  done

  kill "$CS_PID" 2>/dev/null || true
  kill "$XVFB_PID" 2>/dev/null || true
  wait "$CS_PID" 2>/dev/null || true
  wait "$XVFB_PID" 2>/dev/null || true

  [[ -f "$DB_PATH" ]] || die "DB was not created after ${WAIT}s. See /tmp/cs-init.log"
  success "Database initialised ✓"
else
  log "Database already exists, skipping first-run."
fi

# ─── 5. configure CSaaS preferences ──────────────────────────────────────────
log "Configuring CSaaS preferences in SQLite…"
NOW_MS=$(date +%s%3N 2>/dev/null || python3 -c "import time; print(int(time.time()*1000))")

sqlite3 "$DB_PATH" <<SQL
INSERT OR REPLACE INTO preference (scope, key, value, created_at, updated_at)
VALUES
  ('default', 'feature.csaas.enabled', 'true',                 ${NOW_MS}, ${NOW_MS}),
  ('default', 'feature.csaas.host',    '"0.0.0.0"',            ${NOW_MS}, ${NOW_MS}),
  ('default', 'feature.csaas.port',    '${CSAAS_PORT}',        ${NOW_MS}, ${NOW_MS}),
  ('default', 'feature.csaas.api_key', '"${API_KEY}"',         ${NOW_MS}, ${NOW_MS});
SQL
success "CSaaS preferences written ✓"

# ─── 6. Xvfb systemd service ─────────────────────────────────────────────────
log "Installing xvfb systemd service…"
cat > /etc/systemd/system/xvfb-modauistudio.service <<UNIT
[Unit]
Description=X Virtual Frame Buffer (Modaui Studio)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
success "Xvfb service installed ✓"

# ─── 7. Modaui Studio systemd service ────────────────────────────────────────
log "Installing modaui-studio systemd service…"
cat > /etc/systemd/system/modaui-studio.service <<UNIT
[Unit]
Description=Modaui Studio AI Service
After=network.target xvfb-modauistudio.service
Requires=xvfb-modauistudio.service

[Service]
Type=simple
User=${SERVICE_USER}
Environment=DISPLAY=:99
Environment=HOME=${SERVICE_HOME}
Environment=CHERRY_STUDIO_DATA_DIR=${SERVICE_HOME}/.config/Modaui Studio
ExecStart=${CS_BIN} --no-sandbox
Restart=on-failure
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
UNIT
success "Modaui Studio service installed ✓"

# ─── 8. self-signed TLS certificate ──────────────────────────────────────────
SSL_DIR="/etc/nginx/ssl"
mkdir -p "$SSL_DIR"

if [[ ! -f "${SSL_DIR}/modauistudio.crt" ]]; then
  log "Generating self-signed TLS certificate for ${SERVER_IP}…"
  openssl req -x509 -newkey rsa:4096 \
    -keyout "${SSL_DIR}/modauistudio.key" \
    -out    "${SSL_DIR}/modauistudio.crt" \
    -days 3650 -nodes \
    -subj "/C=US/O=Modaui Studio/CN=${SERVER_IP}" \
    -addext "subjectAltName=IP:${SERVER_IP}" 2>/dev/null
  chmod 600 "${SSL_DIR}/modauistudio.key"
  success "TLS certificate generated ✓"
else
  log "TLS certificate already exists, skipping."
fi

# ─── 9. Nginx configuration ───────────────────────────────────────────────────
log "Configuring Nginx reverse proxy…"

cat > /etc/nginx/sites-available/modauistudio <<NGINX
# Modaui Studio – HTTPS reverse proxy
# Generated by server-install.sh

# Redirect plain HTTP to HTTPS
server {
    listen 80 default_server;
    server_name _;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name ${SERVER_IP} _;

    ssl_certificate     ${SSL_DIR}/modauistudio.crt;
    ssl_certificate_key ${SSL_DIR}/modauistudio.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;

    # Increase timeouts for long-running AI completions
    proxy_read_timeout  300s;
    proxy_send_timeout  300s;
    proxy_connect_timeout 10s;

    location / {
        proxy_pass         http://127.0.0.1:${CSAAS_PORT};
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";

        # Server-Sent Events / streaming support
        proxy_buffering    off;
        proxy_cache        off;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/modauistudio /etc/nginx/sites-enabled/modauistudio
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

nginx -t 2>/dev/null || die "Nginx config test failed. Check /etc/nginx/sites-available/modauistudio"
success "Nginx configured ✓"

# ─── 10. enable & start services ─────────────────────────────────────────────
log "Enabling and starting services…"
systemctl daemon-reload
systemctl enable --now xvfb-modauistudio.service
systemctl enable --now modaui-studio.service
systemctl enable --now nginx
systemctl reload nginx

# Wait up to 30 s for the health endpoint
log "Waiting for API server to become healthy…"
WAIT=0
until curl -fsk --max-time 3 "https://${SERVER_IP}/health" -H "Authorization: Bearer ${API_KEY}" &>/dev/null \
      || (( WAIT >= 30 )); do
  sleep 1; (( WAIT++ ))
done

# ─── done ─────────────────────────────────────────────────────────────────────
echo ""
success "Installation complete! 🍒"
echo ""
echo -e "  ${BOLD}API endpoint${RESET}  :  https://${SERVER_IP}/"
echo -e "  ${BOLD}Health check${RESET}  :  https://${SERVER_IP}/health"
echo -e "  ${BOLD}API docs${RESET}      :  https://${SERVER_IP}/api-docs"
echo -e "  ${BOLD}OpenAI base URL${RESET}:  https://${SERVER_IP}/v1/"
echo -e "  ${BOLD}API key${RESET}       :  ${API_KEY}"
echo ""
echo -e "  ${YELLOW}Note:${RESET} The certificate is self-signed. Clients must set"
echo -e "        SSL verification to off, or add the cert to their trust store:"
echo -e "        ${SSL_DIR}/modauistudio.crt"
echo ""
echo -e "  ${BLUE}Service status${RESET}:"
echo -e "    systemctl status modaui-studio"
echo -e "    systemctl status xvfb-modauistudio"
echo -e "    journalctl -u modaui-studio -f"
echo ""
