#!/usr/bin/env bash
# Forced-command deployment entry point for the production VPS.
#
# The GitHub Actions workflow calls:
#   ssh deploy-key@host "deploy <40-hex-commit-sha>"
#
# The SSH key is restricted in authorized_keys to this script. The script only
# accepts "deploy" or "check" followed by a commit SHA that is the current
# refs/heads/main of the public repository. It never accepts arbitrary shell
# commands, paths or environment overrides from the caller.

set -euo pipefail
umask 077

REPO="nashassany-gif/clean-skincare-brand-landing-page"
REPO_URL="https://github.com/${REPO}.git"
TARBALL_URL="https://codeload.github.com/${REPO}/tar.gz"
BASE="/srv/loam-releases"
CURRENT="/srv/loam-current"
DATA="/srv/loam-shared/data"
BACKUPS="/srv/loam-backups"
SERVICE="loam-shop"
LOCK="/tmp/loam-deploy.lock"
HEALTH_URL="http://127.0.0.1:8787/api/health"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

cmd="${SSH_ORIGINAL_COMMAND:-}"
mode=""
sha=""

if [[ "$cmd" =~ ^(deploy|check)[[:space:]]+([0-9a-f]{40})$ ]]; then
  mode="${BASH_REMATCH[1]}"
  sha="${BASH_REMATCH[2]}"
else
  die "invalid command; expected 'deploy <sha>' or 'check <sha>'"
fi

# Only the current public main commit may be deployed. This prevents the
# automation key from being used to deploy an arbitrary older or foreign commit.
main_sha="$(GIT_TERMINAL_PROMPT=0 git ls-remote "$REPO_URL" refs/heads/main | awk '{print $1}')"
[[ "$main_sha" == "$sha" ]] || die "commit is not the current main branch"

exec 9>"$LOCK"
flock -n 9 || die "another deployment is already running"

tmp="$(mktemp -d /tmp/loam-deploy.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

log "fetching $sha"
curl -fsSL --retry 3 --retry-delay 2 "$TARBALL_URL/$sha" -o "$tmp/src.tar.gz"
mkdir "$tmp/src"
tar -xzf "$tmp/src.tar.gz" -C "$tmp/src" --strip-components=1

[[ -f "$tmp/src/package.json" && -f "$tmp/src/server/index.js" ]] || die "invalid source archive"

forbidden="$(find "$tmp/src" -mindepth 1 \( \
  -name data -o -name review -o -name node_modules -o \
  -name '.env' -o -name '.env.*' -o -name '*.sqlite' -o \
  -name '*.sqlite-shm' -o -name '*.sqlite-wal' -o -name '.token-key' \
  \) -print -quit)"
[[ -z "$forbidden" ]] || die "source archive contains a forbidden path"

rel="$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:7}"
release="$BASE/$rel"
install -d -m 755 "$BASE" "$release"
cp -a "$tmp/src/." "$release/"
printf '%s\n' "$sha" > "$release/RELEASE_COMMIT"

log "installing dependencies for $rel"
cd "$release"
npm ci --omit=dev --no-audit --no-fund

log "running tests for $rel"
npm test

prev="$(readlink -f "$CURRENT" 2>/dev/null || true)"
if [[ -n "$prev" && -f "$prev/server/database.js" ]]; then
  if ! cmp -s "$prev/server/database.js" "$release/server/database.js"; then
    marker="/srv/loam-shared/allow-migration-$sha"
    [[ -f "$marker" ]] || die "server/database.js changed; manual migration approval required"
  fi
fi

if [[ -n "$prev" && -d "$DATA" ]]; then
  backup_dir="$BACKUPS/predeploy-$rel"
  log "taking pre-deployment backup"
  sudo install -d -m 700 -o ubuntu -g ubuntu "$backup_dir"
  ( cd "$prev" && LOAM_DATA_DIR="$DATA" npm run backup -- "$backup_dir" )
  [[ -f "$backup_dir/manifest.json" ]] || die "backup manifest missing"
fi

if [[ "$mode" == "check" ]]; then
  log "check passed for $sha"
  rm -rf "$release"
  exit 0
fi

old_target="$(readlink -f "$CURRENT" 2>/dev/null || true)"
[[ -n "$old_target" ]] || die "current release symlink is missing; run setup-vps.sh first"

log "switching current release to $rel"
sudo ln -sfn "$release" "$CURRENT.next"
sudo mv -Tf "$CURRENT.next" "$CURRENT"
sudo systemctl restart "$SERVICE"

ok=0
current_real="$(readlink -f "$CURRENT")"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "$HEALTH_URL" -o "$tmp/health.json" 2>/dev/null; then
    health="$(tr -d '[:space:]' < "$tmp/health.json")"
    pid="$(systemctl show -p MainPID --value "$SERVICE")"
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    release_commit="$(cat "$CURRENT/RELEASE_COMMIT" 2>/dev/null || true)"
    if [[ "$health" == *'"ok":true'* && "$health" == *'"paymentEnabled":false'* && "$cwd" == "$current_real" && "$release_commit" == "$sha" ]]; then
      ok=1
      break
    fi
  fi
  sleep 1
done

if [[ "$ok" != 1 ]]; then
  log "health check failed; rolling back"
  sudo ln -sfn "$old_target" "$CURRENT.next"
  sudo mv -Tf "$CURRENT.next" "$CURRENT"
  sudo systemctl restart "$SERVICE"
  die "deployment failed and was rolled back"
fi

printf '%s\n' "$sha" | sudo tee /srv/loam-shared/deployed-commit >/dev/null
log "deployed $sha to $rel"
