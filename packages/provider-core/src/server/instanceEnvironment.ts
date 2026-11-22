import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomeVariable } from "./pathExpansion.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  const host = yield* HostProcess.Environment;
  const allowlist = host.T3CODE_PROVIDER_ENV_ALLOWLIST ?? baseEnv.T3CODE_PROVIDER_ENV_ALLOWLIST;
  if (allowlist !== undefined) {
    const platform = yield* HostProcess.Platform;
    const canonical = (name: string) => (platform === "win32" ? name.toUpperCase() : name);
    const allowed = new Set(allowlist.split(",").map((name) => canonical(name.trim())));
    // Undefined entries remove inherited values even in launchers that extend process.env.
    baseEnv = Object.fromEntries(
      Object.keys({ ...host, ...baseEnv }).map((name) => [
        name,
        allowed.has(canonical(name)) ? baseEnv[name] : undefined,
      ]),
    );
  }
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const windows = (yield* HostProcess.Platform) === "win32";
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    // Windows reads names without regard to case, and a child gets the first spelling in sort
    // order. Upper case sorts first, so the configured value wins even where a spawn merges the
    // parent environment back in.
    const name = windows ? variable.name.toUpperCase() : variable.name;
    if (windows) {
      for (const inherited of Object.keys(next)) {
        if (inherited.toUpperCase() === name) delete next[inherited];
      }
    }
    next[name] = expandHomeVariable(name, variable.value, home);
  }
  return next;
});
