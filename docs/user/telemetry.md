# Product usage data

The T3 Code server sends product usage events to T3 Code's own endpoint at `ingest.t3.codes`,
associated with a hashed account or installation identifier. To count how many installations one person
uses, the server also sends hashed account identifiers: your T3 Connect account, your OpenAI and
Claude accounts when you are signed in, and a random identifier for each device that connects. The endpoint keeps a copy of each
event and forwards events to PostHog. Events include the provider, model, reasoning effort,
permission mode, turn and request results, duration, release channel, and token counts when
available. Child-agent token counts are reported separately from the main agent's. Model names
are sent only when they appear in a provider's public model list.

Product events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output.

## Relay connection diagnostics

T3 Code sends relay connection traces to Axiom to diagnose T3 Connect connectivity. These are
separate from product events. Depending on the client version, traces can include connection
timings, environment identifiers and the connected machine's name. Failed spans can include error
messages and stack traces; error text can quote a value the app was handling.

To disable product events and relay tracing from the server, set
`T3CODE_TELEMETRY_ENABLED=false` in its environment before starting it. Relay tracing also stops
when `T3CODE_OTEL_SDK_DISABLED` or `OTEL_SDK_DISABLED` turns OpenTelemetry export off.

An administrator can turn product events and relay tracing off in the server and desktop app with
a [managed policy](./managed-policy.md#other-capabilities). This does not control traces sent by
separate browser or mobile clients.

The desktop app reads `T3CODE_TELEMETRY_ENABLED` from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.

The web app in a browser, including one the `t3` CLI opens, does not read these environment
variables. When its build has relay tracing configured, it sends its own connection traces even
if the server has opted out. The browser app has no relay tracing toggle.

## Mobile app diagnostics

When the iOS or Android app crashes or hits an error, it sends a report to T3 Code: the error
message, the stack trace, the app version, and the device model and OS version. Each launch also
sends startup timings, and every report carries a random ID for the install. Reports go through
the T3 Connect relay to Axiom. They do not include your threads, prompts, or connection details,
but an error message can quote a value the app was handling.

To stop sending them, turn off **Send crash reports** in **Settings > About T3 Code > Diagnostics**.

The mobile app also sends relay connection traces when its build has tracing configured. These
carry an identifier for the current app session. **Send crash reports** does not control these
traces, and the mobile app has no separate relay tracing toggle. Server environment variables and
managed policy do not disable mobile tracing.

## Agent activity for mobile notifications

When **Publish agent activity** is enabled on a host, it sends project and thread titles, model
names, activity status, and environment and thread identifiers to the T3 Connect relay for
[mobile notifications and live activities](./mobile-notifications.md). This is separate from
product events and relay diagnostics. The telemetry opt-out does not disable it.

To stop publishing, turn off **Publish agent activity** under **Settings > Sharing & access** on
the host. Turning off notifications on a phone controls that phone's alerts, not the host's
publishing setting.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.

## Privacy controls in this fork

Product analytics and server relay tracing are off unless `T3CODE_TELEMETRY_ENABLED=true` is set before startup. Browser relay tracing also requires `VITE_T3CODE_TELEMETRY_ENABLED=true` at build time; mobile relay tracing requires `EXPO_PUBLIC_T3CODE_TELEMETRY_ENABLED=true` at build time. Configured collector URLs alone no longer enable these exports. Existing telemetry opt-outs and SDK disable flags still take precedence where supported. User-configured OpenTelemetry receivers are separate.

Claude launches default to `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`; an explicit provider environment value can override it. Codex app-server launches default to `-c analytics.enabled=false`; explicit launch arguments can override it. These switches do not disable conversation uploads or model-initiated requests. Other providers retain their own controls. Claude hostname safety checks remain enabled.

To observe destinations and masked sensitive-data findings before blocking anything, use the [local data activity dashboard](../../tools/privacy-observer/README.md). It must be started separately and sees only traffic routed through its proxy. No network restrictions are enabled by default.

To limit inherited provider environment variables, set `T3CODE_PROVIDER_ENV_ALLOWLIST` on the server to a comma-separated list of exact variable names, for example `PATH,HOME,USER,LANG,TERM`. An empty list inherits none. Explicit provider-instance values are still passed. Restart the server/providers afterward. Include required proxy and certificate variables when testing the observer. This controls environment inheritance, not filesystem access: agents can still read credentials in accessible files. Provider-native settings and subprocess startup scripts can supply additional variables.

The repository ignores `.claude/settings.local.json`. The commit hook checks staged agent configuration when JSON or TOML files change; run `node scripts/check-agent-secrets.mjs` to check it manually. CI checks tracked configuration too. It rejects local permission history and common literal credential patterns, without printing matched values. Use environment-variable or secret-provider references in approved commands. This targeted check is not a complete secret scanner or a scan of Git history.

In t3po, the sidebar shield opens the embedded **Privacy dashboard**. It is also available in the command palette and **Settings → Maintenance**. Choose the observer’s machine and follow the [connection setup](../../tools/privacy-observer/README.md#open-inside-t3po).

The privacy dashboard now brings the selected machine's startup telemetry settings, running custom diagnostics receivers, provider configuration, and activity publishing into one view. Browser relay tracing describes only the current client; other clients and installed mobile builds remain unknown. Activity publishing uses its existing relay permission. Clearing saved diagnostics receivers requires settings permission and takes effect after a server restart; environment overrides still apply.

Use **Limit inherited variables** beside a provider to save a minimal environment profile, or **Use host inheritance** to remove that provider override. The profile keeps shell, home, proxy, and certificate variables; explicitly configured provider variables remain available. Any host allowlist is intersected with the provider list. Required API credentials should be configured explicitly on that provider. Changes can restart the provider, so finish active work first. This does not isolate files, block network destinations, or prove that the provider honored telemetry or proxy settings.
