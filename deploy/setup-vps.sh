#!/usr/bin/env bash
# One-time VPS setup for the GitHub Actions deployment path.
#
# Run as root from a directory containing both this script and loam-deploy.sh:
#   sudo bash setup-vps.sh /path/to/deploy-key.pub
#
# It:
#   1. backs up the current systemd unit;
#   2. creates /srv/loam-current -> the current release;
#   3. points WorkingDirectory and ExecStart at /srv/loam-current;
#   4. installs /usr/local/bin/loam-deploy (root-owned, mode 755);
#   5. adds a forced-command authorized_keys entry for the deploy key;
#   6. restarts and health-checks, restoring the old unit on failure.
#
# It never prints or copies application data or secrets.

set -euo pipefail
umask 077

SERVICE="loam-shop"
DEPLOY_USER="ubuntu"
UNIT="/etc/systemd/system/${SERVICE}.service"
DROPIN_DIR="/etc/systemd/system/${SERVICE}.service.d"
DROPIN="$DROPIN_DIR/90-loam-release.conf"
CURRENT="/srv/loam-current"
DEPLOY_SCRIPT="/usr/local/bin/loam-deploy"
HEALTH_URL="http://127.0.0.1:8787/api/health"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/srv/loam-backups/systemd/$STAMP"
PUBKEY_FILE="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
AUTH_KEYS="$DEPLOY_HOME/.ssh/authorized_keys"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

[[ "$EUID" -eq 0 ]] || die "run as root"
[[ -f "$UNIT" ]] || die "systemd unit not found"
[[ -f "$SCRIPT_DIR/loam-deploy.sh" ]] || die "loam-deploy.sh not found next to setup script"
[[ -n "$PUBKEY_FILE" && -f "$PUBKEY_FILE" ]] || die "usage: sudo bash setup-vps.sh /path/to/deploy-key.pub"

current_wd="$(systemctl show -p WorkingDirectory --value "$SERVICE")"
[[ -n "$current_wd" && -d "$current_wd" ]] || die "cannot determine current WorkingDirectory"
node_bin="$(command -v node)"
[[ -n "$node_bin" ]] || die "node not found"

install -d -m 700 "$BACKUP_DIR"
cp -a "$UNIT" "$BACKUP_DIR/${SERVICE}.service"
if [[ -f "$DROPIN" ]]; then
  cp -a "$DROPIN" "$BACKUP_DIR/90-loam-release.conf"
fi
log "unit backed up to $BACKUP_DIR"

if [[ -e "$CURRENT" && ! -L "$CURRENT" ]]; then
  die "$CURRENT exists and is not a symlink"
fi
ln -sfn "$current_wd" "$CURRENT"

# Replace only the two deployment-path lines; keep all Environment and
# hardening directives exactly as they are.
if ! grep -qx "WorkingDirectory=$CURRENT" "$UNIT" || \
   ! grep -qx "ExecStart=$node_bin $CURRENT/server/index.js" "$UNIT"; then
  sed -i \
    -e "s#^WorkingDirectory=.*#WorkingDirectory=$CURRENT#" \
    -e "s#^ExecStart=.*#ExecStart=$node_bin $CURRENT/server/index.js#" \
    "$UNIT"
  systemctl daemon-reload
  log "systemd unit updated"
fi

# The old release workflow created a drop-in that overrides the unit. Rewrite
# only its deployment-path lines and preserve Environment/hardening settings.
if [[ -f "$DROPIN" ]]; then
  section_count="$(grep -c '^\[' "$DROPIN" || true)"
  [[ "$section_count" -eq 1 ]] || die "unexpected sections in $DROPIN"
  dropin_tmp="$(mktemp)"
  awk '
    /^\[/ {print; next}
    /^WorkingDirectory=/ {next}
    /^ExecStart=/ {next}
    {print}
  ' "$DROPIN" > "$dropin_tmp"
  printf '%s\n' \
    'WorkingDirectory=/srv/loam-current' \
    'ExecStart=' \
    'ExecStart=/usr/bin/node /srv/loam-current/server/index.js' >> "$dropin_tmp"
  install -m 644 -o root -g root "$dropin_tmp" "$DROPIN"
  rm -f "$dropin_tmp"
  systemctl daemon-reload
  log "systemd drop-in updated"
fi

# Refuse to proceed if another drop-in still overrides the deployment paths.
for f in "$DROPIN_DIR"/*.conf; do
  [[ -e "$f" ]] || continue
  [[ "$f" == "$DROPIN" ]] && continue
  if grep -qE '^(WorkingDirectory|ExecStart)=' "$f"; then
    die "unexpected deployment override in $f"
  fi
done

install -o root -g root -m 755 "$SCRIPT_DIR/loam-deploy.sh" "$DEPLOY_SCRIPT"
log "installed $DEPLOY_SCRIPT"

key="$(tr -d '\r\n' < "$PUBKEY_FILE")"
[[ "$key" =~ ^ssh-ed25519[[:space:]]+[A-Za-z0-9+/=]+ ]] || die "expected an ssh-ed25519 public key"
[[ -n "$DEPLOY_HOME" && -d "$DEPLOY_HOME" ]] || die "cannot resolve home for $DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_HOME/.ssh"
touch "$AUTH_KEYS"
chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"
line="command=\"$DEPLOY_SCRIPT\",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding $key loam-deploy-github-actions"
if ! grep -Fq "loam-deploy-github-actions" "$AUTH_KEYS"; then
  printf '%s\n' "$line" >> "$AUTH_KEYS"
  log "deploy key added to authorized_keys"
else
  log "deploy key entry already present"
fi

systemctl restart "$SERVICE"
ok=0
current_real="$(readlink -f "$CURRENT")"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "$HEALTH_URL" -o /tmp/loam-setup-health.json 2>/dev/null; then
    health="$(tr -d '[:space:]' < /tmp/loam-setup-health.json)"
    pid="$(systemctl show -p MainPID --value "$SERVICE")"
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    if [[ "$health" == *'"ok":true'* && "$health" == *'"paymentEnabled":false'* && "$cwd" == "$current_real" ]]; then
      ok=1
      break
    fi
  fi
  sleep 1
done
rm -f /tmp/loam-setup-health.json

if [[ "$ok" != 1 ]]; then
  log "health or process-directory check failed; restoring previous unit, drop-in and symlink"
  cp -a "$BACKUP_DIR/${SERVICE}.service" "$UNIT"
  if [[ -f "$BACKUP_DIR/90-loam-release.conf" ]]; then
    cp -a "$BACKUP_DIR/90-loam-release.conf" "$DROPIN"
  fi
  ln -sfn "$current_wd" "$CURRENT"
  systemctl daemon-reload
  systemctl restart "$SERVICE"
  die "setup failed and was rolled back"
fi

log "setup complete; current release: $current_wd"
