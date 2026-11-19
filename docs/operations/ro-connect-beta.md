# ro connect private source beta

ro connect is T3PO's connection system, built on the upstream T3 Code protocols. This beta is a source installation for macOS and Linux, not a signed desktop distribution. Existing T3 protocol identifiers, URI schemes and upstream license notices remain intact.

## Install and operate

Use a dedicated checkout of the reviewed T3PO fork commit, Node matching the repository's engine requirement, and the repository's Vite+ toolchain. Install dependencies with `vp i` before running the installer. Never use an upstream `curl` installer, `npx t3`, `t3 update`, or upstream desktop auto-update to maintain this installation.

```sh
node scripts/ro-connect.mjs install /absolute/path/to/t3po FULL_40_CHARACTER_COMMIT_SHA
# Add ~/.local/bin to PATH if needed.
ro-connect start
ro-connect status
ro-connect pair
ro-connect stop
```

The installer builds the web client, pins the source commit and Node executable, and registers `computer.ro.t3po.beta` with launchd or the user systemd manager. Installation alone does not start the server. Start is idempotent. Linux requires a working user systemd session; persistent operation after logout requires operator-managed lingering. macOS requires a logged-in GUI session. Windows is not supported by this source installer.

The server listens on loopback port 13774 and uses `~/.local/share/t3po-beta/data`, independently of `~/.t3`. It runs the existing source CLI and serves the built web client. Keep the checkout and its dependencies available; changing its tracked files or HEAD causes start/pair to refuse. The wrapper exposes no upstream install/update commands. It does not fetch a release or change a Git checkout. Do not configure an upstream updater against this source directory.

`pair` uses the existing CLI's one-time, standard-scope pairing flow. It prints a credential: share it privately with the intended browser and do not place it in logs or issue reports. The default loopback URL is local-only. Remote HTTPS, CORS for the hosted app, and a secure hosted pairing handoff remain operator setup; this installer does not change Tailscale Serve or production 1421. Confirm human pairing at the hosted origin before relying on remote access. Start/status is a service-manager check, not an authenticated end-to-end connection test.

For an update, prepare a **separate**, clean checkout at the reviewed fork SHA and install its dependencies first. Back up the data directory while stopped before a schema-changing update. Then run:

```sh
ro-connect update /absolute/path/to/new-t3po FULL_40_CHARACTER_COMMIT_SHA
```

The new web build completes before the service stops; the manifest switches and the service starts with the same data directory. It never deletes data. Keep the old checkout and backup: an older binary is not a safe automatic rollback after database migrations. Service failures remain visible through `status`; on macOS inspect `~/.local/share/t3po-beta/service.log`, on Linux `journalctl --user -u computer.ro.t3po.beta.service`. Installation and update are single-operator operations; do not run them concurrently.

## Shared Brhyt sign-in

The private beta uses the existing **Brhyt Clerk application** and shared sign-in, with canonical hosts `roc.brhyt.com` and `t3po.roc.brhyt.com`. Preserve existing Payload/Convex templates, callbacks, and account-wide sign-up rules. Add a separate ro relay JWT template and CLI OAuth application. Keep the hosted pages restricted to `gilberto@brhyt.com`; shared sign-in alone does not restrict the relay to that owner.

Follow [connect setup](./connect-setup.md) for the actual claim and redirect requirements. Supply the Brhyt publishable key, JWT template name, public CLI OAuth client ID, and own relay URL through `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`, `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`, and `T3CODE_RELAY_URL` before building the web client. The JWT audience must match the relay's `CLERK_JWT_AUDIENCE`. CLI OAuth needs PKCE, `http://127.0.0.1:34338/callback`, the documented scopes, and device authorization enabled if using headless login. Allow the actual hosted application origin. Desktop/mobile callbacks are needed only for separately prepared native clients; do not rename their protocol schemes here.

The relay alone receives the Brhyt `CLERK_SECRET_KEY`; never put it into frontend build configuration. The currently deployed static client has no Clerk/relay configuration. Naming the UI ro connect does not enable account-based connectivity.

## Private relay preparation

The existing Alchemy stack now accepts `RELAY_DATABASE_PROVIDER=external-postgres`. This skips all PlanetScale database, branch and role provisioning and uses the existing Cloudflare Hyperdrive binding with caching disabled. Provide:

```dotenv
RELAY_DATABASE_PROVIDER=external-postgres
RELAY_POSTGRES_HOST=db.example.com
RELAY_POSTGRES_PORT=5432
RELAY_POSTGRES_DATABASE=ro_connect
RELAY_POSTGRES_USER=ro_connect_runtime
# Secret, supplied through the operator's secret mechanism:
# RELAY_POSTGRES_PASSWORD=...
APNS_ENABLED=false
```

The external PostgreSQL database must already exist and be reachable by Hyperdrive. Apply the checked-in `infra/relay/migrations/postgres` migrations with a separate migration role before deploying; external mode deliberately does not migrate an operator-owned database or grant roles. Give the runtime role only the schema access needed by the relay. The upstream default remains PlanetScale with its original sizing and replicas when the provider is omitted; do not deploy with an omitted provider by accident.

Supply separate relay API and managed tunnel zone settings (`RELAY_API_ZONE_NAME`, `RELAY_TUNNEL_ZONE_NAME`, optional `RELAY_DOMAIN`), Cloudflare account/state access, and permissions for Worker deployment, Hyperdrive, zones/DNS and tunnel creation/cleanup. Use an isolated Cloudflare account or isolated Alchemy state for this fork: the stack's upstream logical name and prod-owned zone relationships are unchanged. Start with the `prod` stage in that isolated state; personal stages reference its zones. Do not point this stack at upstream production state.

**Deployment blocker:** Axiom observability is currently mandatory in the stack and Worker bindings, including telemetry forwarding, monitors and source-map resources. Disabling it safely requires a separate implementation; no pretend `AXIOM_ENABLED=false` switch is provided. Either approve and provide a dedicated Axiom setup or complete that work before deployment. APNs can be disabled as above; omit FCM credentials for a web-only beta, though queue resources remain in the stack. Leave optional T3 Chat linking unconfigured.

Required credentials/configuration still owned by the parent: Brhyt Clerk secret/public keys, JWT and OAuth settings, PostgreSQL endpoint/runtime secret/migration access, Cloudflare deployment/state and tunnel/DNS permissions, and an explicit observability decision. No cloud resources, credentials, live database writes, production service changes, or deployments are performed by this preparation.
