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
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "$HEALTH_URL" -o /tmp/loam-setup-health.json 2>/dev/null; then
    health="$(tr -d '[:space:]' < /tmp/loam-setup-health.json)"
    if [[ "$health" == *'"ok":true'* && "$health" == *'"paymentEnabled":false'* ]]; then
      ok=1
      break
    fi
  fi
  sleep 1
done
rm -f /tmp/loam-setup-health.json

if [[ "$ok" != 1 ]]; then
  log "health check failed; restoring previous unit and symlink"
  cp -a "$BACKUP_DIR/${SERVICE}.service" "$UNIT"
  ln -sfn "$current_wd" "$CURRENT"
  systemctl daemon-reload
  systemctl restart "$SERVICE"
  die "setup failed and was rolled back"
fi

log "setup complete; current release: $current_wd"
