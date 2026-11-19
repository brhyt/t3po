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

The private beta uses the existing **Brhyt Clerk application** and shared sign-in, with canonical hosts `roc.brhyt.com` and `t3po.roc.brhyt.com`. Preserve existing Payload/Convex templates, callbacks, and account-wide sign-up rules. Add a separate ro relay JWT template and CLI OAuth application. Keep the hosted pages restricted to `gilberto@brhyt.com`. The relay has its own owner restriction: set `RELAY_ACCESS_MODE=allowlist` and `RELAY_ALLOWED_CLERK_USER_IDS` to a JSON array containing that account's verified Clerk user ID. Do not use the email address as an ID. In allowlist mode, missing, empty, or malformed ID configuration fails deployment; `[]` deliberately denies everyone. Omitting the mode preserves upstream all-accounts behavior and is unsuitable for this private beta.

The restriction is checked for session and CLI OAuth authentication, token exchange, each DPoP request, environment credentials, and managed-tunnel recovery. It applies regardless of which browser or API client makes the request; it does not change Brhyt-wide sign-up or other products. Removing an owner denies new relay requests after redeployment. Already established environment sessions, connections, issued bootstrap credentials, retained webhook capabilities, notification subscriptions, and queued deliveries have their own lifetimes: revoke those separately when removing access. The relay does not proxy ordinary environment WebSockets, so this allowlist is not an immediate kill switch for existing environment sessions.

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
RELAY_ACCESS_MODE=allowlist
RELAY_ALLOWED_CLERK_USER_IDS=["user_REPLACE_WITH_VERIFIED_OWNER_ID"]
RELAY_OBSERVABILITY=none
```

For Neon, run `neon init` with the intended organization, project and branch, then `neon deploy` at the repository root. The root `neon.ts` keeps existing Clerk authentication. Load the generated `.env.local` into the deployment environment and set `RELAY_DATABASE_PROVIDER=external-postgres`: the relay accepts `DATABASE_URL_UNPOOLED` directly instead of the individual `RELAY_POSTGRES_*` fields. Keep this URL private. Hyperdrive handles pooling; the Neon pooler URL is rejected on this path. The existing Effect PostgreSQL driver remains in use.

The external PostgreSQL database must already exist and be reachable by Hyperdrive. Apply the checked-in `infra/relay/migrations/postgres` migrations with a separate migration role before deploying; external mode deliberately does not migrate an operator-owned database or grant roles. Give the runtime role only the schema access needed by the relay. The upstream default remains PlanetScale with its original sizing and replicas when the provider is omitted; do not deploy with an omitted provider by accident.

Export deployment identity in the **shell before invoking Alchemy** (its entrypoint loads before Effect configuration, so putting these only in an Alchemy `--env-file` is insufficient):

```sh
export RELAY_STACK_NAME=RoRelay
export RELAY_STATE_WORKER_NAME=ro-relay-state
export CLOUDFLARE_ACCOUNT_ID='<verified Brhyt Cloudflare account ID>'
```

A non-upstream stack name requires both a dedicated state Worker name and an explicit account ID. The state Worker, its Durable Object state, and its authentication/encryption secret names are isolated by that Worker name. Cloudflare permits one Secrets Store per account; its container is shared, but these named secrets are separate. Cloudflare account-level credentials and Alchemy's local profile/cache are still shared infrastructure. Keep the chosen stack name, state Worker and account fixed for all future plan/apply/destroy operations; changing them starts a different state history. Defaults remain `T3CodeRelay` and `alchemy-state-store` for upstream use.

Use existing-zone mode for the Brhyt deployment:

```dotenv
RELAY_ZONE_MODE=existing
RELAY_API_ZONE_NAME=brhyt.com
RELAY_API_ZONE_ID=<verified brhyt.com zone ID>
RELAY_TUNNEL_ZONE_NAME=brhyt.com
RELAY_TUNNEL_ZONE_ID=<same verified brhyt.com zone ID>
# Example only; confirm this hostname before building clients:
RELAY_DOMAIN=relay.roc.brhyt.com
```

Both zone IDs are required and validated. The deploy performs read-only checks that each ID belongs to the configured account and matches the configured name. **No Zone resource is declared or adopted in existing mode**, so zone settings and the zone lifecycle are outside this stack. The relay still owns its Worker custom-domain mapping, its zone-scoped runtime DNS token, and DNS records/tunnels created by that runtime. An ordinary subdomain such as `roc.brhyt.com` is not itself a Cloudflare zone; use the actual `brhyt.com` zone unless a separate delegated zone really exists. Fork endpoint hashes, tunnel names, hostnames and preview cleanup include the stack namespace. Fresh stages need no production-zone state reference in existing mode. The omitted-mode default retains upstream managed/adopted production zones; do not omit it for this deployment.

Provisioning permissions are account-scoped **Workers Scripts Edit**, **Queues Edit**, **Hyperdrive Edit**, **Cloudflare Tunnel Edit**, **API Tokens Edit/Write**, and **Secrets Store Edit**, plus the account's Worker/Durable Object deployment access. Keep zone permissions **DNS Edit**, **Workers Routes Edit**, and **Zone Read** limited to the selected zones. Account token creation is needed because Alchemy mints runtime credentials for tunnels and zone-scoped DNS; the deployment token is not embedded as the runtime credential. Secrets Store access bootstraps the isolated state Worker. With `RELAY_OBSERVABILITY=none`, the relay does not need R2 or KV permissions for telemetry/source maps, nor Axiom credentials. Verify actual permission labels/capabilities against the target account before deployment; a successful read probe alone does not establish write access.

Use `prod` for the first private deployment with these distinct identities. Do not reuse upstream state or adopt existing Brhyt zones into the new stack. Review the plan: it must contain no `Cloudflare.Zone.Zone` resources, and every new Worker/queue/token/Hyperdrive resource must belong to the intended fork stack. Moving an already deployed stack to existing-zone mode or changing its identity needs a separate state migration review; this recipe is for a fresh stack.

Set `RELAY_OBSERVABILITY=none` for a fresh private stack that does not use Axiom. The default remains `axiom`, with all existing exporters, datasets, tokens, dashboards and monitors. Disabled mode skips Axiom provider initialization, telemetry resources, source-map storage and upload credentials; the mobile telemetry endpoint acknowledges and discards incoming payloads without reading them. Generated client configuration clears old telemetry endpoints and ingest tokens. Cloudflare runtime logs remain available. Rebuild clients from the generated configuration so previously embedded ingest credentials are not retained. Do not turn this off on an existing Axiom-backed stack without reviewing Alchemy's deletion plan and retention requirements.

APNs can be disabled as above; omit FCM credentials for a web-only beta, though queue resources remain in the stack. Leave optional T3 Chat linking unconfigured. External PostgreSQL mode also skips PlanetScale provider initialization; it does not need PlanetScale credentials.

| Boundary             | Required before deployment                                                                                                   | Private beta choice                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Hosted pages         | Existing Cloudflare Access applications, owner email policy and HTTPS                                                        | `roc.brhyt.com` and `t3po.roc.brhyt.com`; keep private                                                            |
| Relay identity       | Existing Brhyt Clerk keys, `CLERK_JWT_AUDIENCE`, verified owner user ID                                                      | `ro-relay` audience; explicit allowlist mode                                                                      |
| Client identity      | Brhyt publishable key, ro CLI OAuth public client ID, JWT template name                                                      | Existing Brhyt sign-in; no new account-wide policy                                                                |
| Relay API            | An available relay hostname under a managed Cloudflare zone                                                                  | Choose its hostname before building clients; set `RELAY_DOMAIN`                                                   |
| Managed environments | `RELAY_TUNNEL_ZONE_NAME` naming an actual active zone, tunnel/DNS API access                                                 | Reuse an authorized zone or explicitly delegate a separate one; an ordinary subdomain is not automatically a zone |
| Persistence          | Reachable PostgreSQL host/port/database/runtime role; separate migration access                                              | `external-postgres`, Hyperdrive cache disabled                                                                    |
| Provisioning         | Named state Worker/account, existing zone IDs, and Cloudflare permissions including Secrets Store and account token creation | Do not reuse upstream production state                                                                            |
| Telemetry            | Explicit deployment choice                                                                                                   | `RELAY_OBSERVABILITY=none` needs no Axiom account                                                                 |
| Native push          | APNs/FCM credentials only when enabled                                                                                       | `APNS_ENABLED=false`; no FCM credentials for web beta                                                             |

Before publishing a Clerk-enabled frontend, verify the owner can enroll and discover an environment, a second Brhyt account is rejected by direct relay calls, existing DPoP credentials are denied after removing an owner, and browser pairing works at the canonical HTTPS origin. Keep the currently working pairing route until those checks pass. No cloud resources, credentials, live database writes, production service changes, or deployments are performed by this preparation.
