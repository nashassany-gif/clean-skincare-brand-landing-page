# Production deployment

The `main` branch is deployed to the existing VPS by GitHub Actions. The
workflow runs the full test suite, then connects with a dedicated SSH key that
is restricted by `authorized_keys` to one forced command:
`/usr/local/bin/loam-deploy`.

The deploy script:

1. accepts only `deploy <40-hex-sha>` or `check <40-hex-sha>`;
2. requires the SHA to be the current public `main` commit;
3. downloads the commit tarball from GitHub;
4. installs production dependencies and runs the test suite;
5. blocks if `server/database.js` changed and no server-side approval marker exists;
6. takes a fresh online SQLite backup before switching;
7. atomically switches `/srv/loam-current` and restarts `loam-shop`;
8. health-checks the local service and rolls back the symlink on failure.

It never reads application data, customer records, `.env` files or keys.

## Required GitHub secrets

| Secret | Purpose |
|---|---|
| `LOAM_DEPLOY_SSH_KEY` | Private key for the dedicated deployment key pair |
| `LOAM_DEPLOY_HOST` | VPS address |
| `LOAM_DEPLOY_USER` | SSH user (`ubuntu`) |
| `LOAM_DEPLOY_PORT` | SSH port |
| `LOAM_DEPLOY_KNOWN_HOSTS` | Pinned `known_hosts` line for the VPS |

The public key is installed in `~ubuntu/.ssh/authorized_keys` with:

```
command="/usr/local/bin/loam-deploy",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding
```

## First-time setup

On the VPS, as root, from a directory containing `setup-vps.sh`,
`loam-deploy.sh` and the **public** deploy key:

```sh
sudo bash setup-vps.sh /path/to/loam-deploy-key.pub
```

The setup script backs up the systemd unit, points it at `/srv/loam-current`,
installs the root-owned deploy script, adds the restricted key and verifies the
service health. It rolls back the unit and symlink if the health check fails.

## Database migration gate

A change to `server/database.js` is treated as a possible migration and is
blocked twice:

- the GitHub workflow fails on a normal push;
- the server script requires `/srv/loam-shared/allow-migration-<sha>`.

For a reviewed migration:

1. take and verify a fresh backup;
2. review the migration and rollback plan;
3. create the marker on the VPS with the exact commit SHA;
4. run the workflow manually with `allow_migration=true`;
5. remove the marker after the deployment.

Never restore an old backup over a database that has accepted new writes
without a separate reconciliation plan.

## Manual checks and rollback

Check a commit without switching production:

```sh
ssh -i deploy-key -p <port> ubuntu@<host> "check <sha>"
```

The script creates a release directory and tests it, but does not stop or
restart the service. The temporary release is removed after a successful check.

To roll back, point `/srv/loam-current` at the previous release and restart:

```sh
sudo ln -sfn /srv/loam-releases/<previous> /srv/loam-current.next
sudo mv -Tf /srv/loam-current.next /srv/loam-current
sudo systemctl restart loam-shop
```

Rolling back code does not reverse database migrations. If a migration has
already run, stop writes, preserve the current database and use a tested
forward-fix or compatibility plan instead of blindly restoring an old backup.
