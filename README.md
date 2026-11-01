# loam shop

A concept skincare storefront with transactional SQLite orders, authenticated administration and a **fail-closed** WeChat Pay API v3 integration.

The current implementation is suitable for local acceptance testing and demonstration. It is **not approved for real commerce**. Prices, stock, ingredients, shipping and the 8% test tax are illustrative. Payment stays disabled unless an operator deliberately completes the release gate described below.

A deployed instance is available at <https://shop.getgozai.com/>. This repository is a source snapshot: production data, credentials, backups and operational records are **not** included.

## Run and test

Validated with Node.js **24.14.1**. The application uses the experimental built-in `node:sqlite` module. The declared Node floor is 22; other Node versions have not been acceptance-tested.

```sh
npm ci
npm start          # http://127.0.0.1:8787/
npm test           # core + reliability checks, isolated temporary databases
```

Opening `index.html` directly with `file://` is unsupported. Use the same-origin HTTP server. Dependencies are pinned to `argon2@0.44.0` and `qr@0.7.2`.

## Configuration and local data

- `LOAM_DATA_DIR` defaults to `data/` and contains `loam.sqlite` plus `.token-key`. **Back them up together.**
- An optional `LOAM_TOKEN_KEY` must be a base64-encoded 32-byte key and must match on restore.
- The server binds `127.0.0.1` by default. Keep the origin inaccessible from the public Internet.
- Static serving is allowlisted to `index.html`, `assets/` and `policies/`; admin assets use separate explicit routes. Custom data directories cannot accidentally become public.
- Only set `LOAM_TRUST_CF_TUNNEL=true` when the loopback origin is exclusively behind a trusted Cloudflare Tunnel that overwrites `CF-Connecting-IP`. Generic forwarded headers are ignored.

Administrator setup is interactive; never pass a password in shell arguments:

```sh
LOAM_DATA_DIR=/path/to/data npm run init-admin
# Additional account or deliberate role change, in a real interactive terminal:
LOAM_DATA_DIR=/path/to/data LOAM_ADMIN_ROLE=ops npm run init-admin
```

Roles:

- `owner` can refund and reconcile.
- `ops` can manage fulfilment and payments but cannot refund or reconcile.
- `viewer` is read-only and can revoke its own sessions.

All roles can read customer data. This is **not** field-level PII isolation. Existing accounts migrate to `owner`; review assignments after upgrading. Resetting a password revokes that account's sessions. When no role is specified, an existing role is preserved; a new account defaults to owner.

## Architecture and invariants

- `server/database.js`: six versioned migrations, WAL, foreign keys, `synchronous=FULL`; synchronous `BEGIN IMMEDIATE` transactions with nested SAVEPOINTs. Never await inside a transaction callback.
- `server/orders.js`: authoritative prices and tax, idempotent order creation, 30-minute stock reservations, cancellation and expiry, separate payment and fulfilment states, refund ledger and audit.
- `server/payments.js`: signed requests, timestamp/key-ID/RSA response verification and AES-GCM callback decryption. Native is the **only** implemented product. Provider currency codes are uppercase; internal currency is lowercase; conversion never changes monetary units.
- `server/webhook.js`: verified callback application and event deduplication are atomic. Failures produce redacted structured logs and a persisted one-hour admin counter.
- `server/admin.js`: Argon2id, server-side HttpOnly/Secure/SameSite=Strict sessions, 8-hour absolute and 30-minute idle expiry, CSRF, persistent source/pair login limits, all-session revocation, role checks and password reconfirmation for refunds and reconciliation (five-minute validity).
- `server/rate-limit.js`: SQLite-backed hashed buckets, expiry pruning, a 50,000 active-key ceiling and fail-closed behaviour. New order attempts: 4/IP/30 minutes; login: 30/IP/15 minutes and 5/IP+username/15 minutes. This reduces, but does not eliminate, inventory exhaustion; distributed or bot defence requires an edge policy.
- `server/backup.js`: online SQLite backup, integrity check, matching token key and SHA-256 manifest. Never copy a running WAL database file directly.
- `server/retention.js`: dry-run by default; only old failed or cancelled idempotency records and technical callback-failure rows are eligible after 30 days. It never deletes orders, refunds or successful payment audit events. `--apply` requires `LOAM_RETENTION_APPROVED=true`.
- `server/migrate-json.js`: one-way legacy import; old `demo_paid` is imported as unpaid, never verified paid.

No admin field can manually set `paid`. A payment can be applied only from a verified callback or a signature-verified, order-bound server-side provider query. Local status polling alone cannot prove payment.

```
unpaid / failed -> processing -> paid
                               -> paid_unallocated (cancelled/released/expired)
processing -> failed (verified provider CLOSED/PAYERROR, not a network timeout)
paid / partially_refunded / paid_unallocated -> refund_pending
refund_pending -> partially_refunded / refunded
refund_pending -> prior paid/unallocated/partial state (verified terminal failure/closed)
```

- Payment timeout: keep `processing`; query before another attempt. A persisted QR is reused without extending the original reservation expiry.
- Refund timeout or `ABNORMAL`: keep the refund pending and reserve its amount. Query or investigate; do not issue another refund ID as a retry.
- Pending plus successful refunds cannot exceed captured money. The same refund ID is replayed without another provider request; terminal outcomes are not reset by stale events.
- A late success is recorded as `paid_unallocated`, never discarded and never made shippable. Adoption is rejected once inventory was released. An unshipped, fully refunded order releases inventory exactly once.

## API surface

Public:

- `GET /api/health`, `GET /api/products`
- `POST /api/orders` (`Idempotency-Key`)
- `GET /api/orders/:number`, `POST /api/orders/:number/cancel`
- `POST /api/orders/:number/payment`, `POST /api/orders/:number/payment/query`
- Order routes above require `x-order-token`; unauthorized orders return 404.
- `POST /api/webhooks/wechatpay`, `POST /api/webhooks/wechatpay/refund`
- `POST /api/newsletter`: disabled by default; does not save an email while disabled.

Admin (`/admin/login`, `/admin`; session required, mutating requests require CSRF):

- session, login and logout
- `POST /api/admin/sessions/revoke`
- `POST /api/admin/reauth`
- stats
- searchable, filterable, paginated orders
- order detail, fulfilment and cancellation
- payment creation and query
- unallocated list
- reconciliation and refund creation/query

Refund and reconciliation writes require owner plus recent password confirmation. Refund queries require owner but do not require a new password confirmation.

The storefront loads server prices, shipping, tax and availability before permitting order submission. It saves only `{number, orderToken, savedAt}` for the latest order; saved access expires when the page next opens after seven days. It supports refresh, cancel and forget. Forgetting a device does not delete a server record.

The policy page is an explicit **demo disclosure**, not invented legal terms. Newsletter collection is disabled by default. Setting `LOAM_NEWSLETTER_COLLECTION_ENABLED=true` is only a server capability switch, not consent or approval for real marketing.

## Payment release gate: keep disabled

Keep `WECHAT_PAY_ENABLED=false` and leave `LOAM_LIVE_APPROVED` unset or false. Readiness requires all of:

- merchant `WECHAT_PAY_APP_ID`, `WECHAT_PAY_MCH_ID`, `WECHAT_PAY_SERIAL_NUMBER`, `WECHAT_PAY_PRIVATE_KEY`
- `WECHAT_PAY_APIV3_KEY`, `WECHAT_PAY_PUBLIC_KEY`, `WECHAT_PAY_PUBLIC_KEY_ID`
- distinct configured `WECHAT_PAY_NOTIFY_URL` and `WECHAT_PAY_REFUND_NOTIFY_URL`
- `WECHAT_PAY_PRODUCT_TYPE=native`, `WECHAT_PAY_CURRENCY=usd`, `WECHAT_PAY_CURRENCY_REVIEWED=true` only after an actual channel review
- explicit `LOAM_LIVE_APPROVED=true` only after the entire business and operations acceptance checklist is signed off

These flags are deliberate operator attestations, not automatic compliance verification. The domestic WeChat endpoints used here have **not** been validated for this USD storefront. A supported international product may require another adapter or endpoints. Never merely flip the currency flag, reinterpret USD cents as CNY fen, or assume that enabling configuration makes the site production-ready. Key rotation, real signatures and callbacks must be tested with the contracted provider.

## Backup, restore and maintenance

```sh
LOAM_DATA_DIR=/path/to/data npm run backup -- /path/to/new-private-backup-dir
LOAM_DATA_DIR=/path/to/data node server/retention.js  # dry-run
```

Backup output must be outside the application and project directory (enforced). A backup contains customer PII, admin password hashes and the decryption key: encrypt it before off-host transfer and restrict ACLs. On Windows, POSIX mode bits are not sufficient. A valid backup must report integrity `ok` and contain `manifest.json`, `loam.sqlite` and `.token-key`. Verify hashes before restoring.

Restore into a **new** private directory with the service stopped, set `LOAM_DATA_DIR` to that directory, ensure any environment token key matches, restart in an isolated environment and verify an old token's `GET` returns 200. Do not restore over a live WAL database. Take a fresh backup before applying migrations; rolling back code alone does not reverse schema or data changes.

`npm test` exercises online backup and a fresh-process restore, including an HTTP `GET` using the old token. It does **not** install a production scheduler, upload an encrypted off-host copy, or test disaster recovery on the actual server.

## Security and repository scope

- Never commit `data/`, `*.sqlite*`, `.token-key`, `.env*`, backups, private keys or production credentials.
- The public snapshot intentionally excludes review screenshots, QA logs, design source files and server-specific deployment records.
- Deployment automation is maintained separately from this snapshot. This repository does not contain production secrets or customer data.
- If you find a security issue, do not open a public issue containing secrets or customer data. Contact the repository owner privately.

## Licensing

No license file is included in this snapshot. Public visibility does not by itself grant permission to reuse the code, brand assets or images. Third-party runtime dependencies retain their own licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
