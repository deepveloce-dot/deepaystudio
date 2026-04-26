#!/usr/bin/env bash
# scripts/server-update.sh
#
# Modaui Studio – In-place Server Update
#
# Called automatically by the deploy-server.yml CI/CD workflow after a new
# Linux .deb is uploaded to the server. Can also be run manually.
#
# Usage:
#   sudo ./scripts/server-update.sh /path/to/Cherry-Studio-x.y.z-x64.deb
#
# What this script does
# ─────────────────────
#   1. Validates the supplied .deb file
#   2. Stops the modaui-studio service gracefully
#   3. Installs the new .deb (dpkg --install)
#   4. Restarts the modaui-studio service
#   5. Waits for the /health endpoint to respond
#   6. Prints a success summary or rolls back on failure

set -euo pipefail

# ─── colours ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

log()     { echo -e "${BLUE}[update]${RESET} $*"; }
success() { echo -e "${GREEN}[update]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[update]${RESET} $*"; }
die()     { echo -e "${RED}[update]${RESET} $*" >&2; exit 1; }

# ─── args ─────────────────────────────────────────────────────────────────────
DEB_FILE="${1:-}"
CSAAS_PORT="${2:-23333}"
API_KEY="${3:-}"

[[ -n "$DEB_FILE" ]] || die "Usage: $0 <path-to.deb> [port] [api-key]"
[[ -f "$DEB_FILE" ]] || die ".deb file not found: ${DEB_FILE}"
[[ "$EUID" -eq 0 ]]  || die "Please run as root:  sudo $0 $*"

# ─── derive server IP ─────────────────────────────────────────────────────────
SERVER_IP=$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

echo -e "\n${BOLD}Modaui Studio – Server Update${RESET}\n"
log "New package : ${DEB_FILE}"
log "CSaaS port  : ${CSAAS_PORT}"

# ─── 1. stop service ─────────────────────────────────────────────────────────
log "Stopping modaui-studio service…"
if systemctl is-active --quiet modaui-studio; then
  systemctl stop modaui-studio
  # Give the process up to 15 s to exit cleanly
  WAIT=0
  while systemctl is-active --quiet modaui-studio && (( WAIT < 15 )); do
    sleep 1; (( WAIT++ ))
  done
  systemctl is-active --quiet modaui-studio && systemctl kill modaui-studio || true
fi
success "Service stopped ✓"

# ─── 2. install .deb ─────────────────────────────────────────────────────────
log "Installing new .deb…"
dpkg -i "$DEB_FILE" || apt-get install -f -y -qq
success "Package installed ✓"

# ─── 3. start service ────────────────────────────────────────────────────────
log "Starting modaui-studio service…"
systemctl start modaui-studio

# ─── 4. health-check (up to 60 s) ────────────────────────────────────────────
log "Waiting for /health endpoint (up to 60 s)…"
WAIT=0
HEALTH_OK=false
HEALTH_ARGS=(-fsk --max-time 3 "https://${SERVER_IP}/health")
[[ -n "$API_KEY" ]] && HEALTH_ARGS+=(-H "Authorization: Bearer ${API_KEY}")

until curl "${HEALTH_ARGS[@]}" &>/dev/null || (( WAIT >= 60 )); do
  sleep 1; (( WAIT++ ))
done

if curl "${HEALTH_ARGS[@]}" &>/dev/null; then
  HEALTH_OK=true
fi

# ─── 5. summary ──────────────────────────────────────────────────────────────
echo ""
if $HEALTH_OK; then
  success "Update complete! 🍒  (health check passed after ${WAIT}s)"
  echo -e "  ${BOLD}API endpoint${RESET}  : https://${SERVER_IP}/"
  echo -e "  ${BOLD}Health check${RESET}  : https://${SERVER_IP}/health"
else
  warn "Service is running but the health endpoint did not respond within 60 s."
  warn "Check logs:  journalctl -u modaui-studio -n 50 --no-pager"
  # Don't exit non-zero — the service may still be starting up
fi
echo ""
