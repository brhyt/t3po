/** Stack identity is evaluated when Alchemy imports its entrypoint, before Effect config. */
export function relayDeploymentIdentity(env: Readonly<Record<string, string | undefined>>) {
  const name = env.RELAY_STACK_NAME ?? "T3CodeRelay";
  if (!/^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(name)) {
    throw new Error(
      "RELAY_STACK_NAME must be 1–40 letters, digits or hyphens, starting with a letter",
    );
  }
  const workerName = env.RELAY_STATE_WORKER_NAME;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (workerName !== undefined && !/^[a-z0-9][a-z0-9_-]{0,53}$/.test(workerName)) {
    throw new Error("RELAY_STATE_WORKER_NAME must be a valid Cloudflare Worker name");
  }
  if (name !== "T3CodeRelay") {
    if (!workerName || workerName === "alchemy-state-store") {
      throw new Error("A fork stack requires a dedicated RELAY_STATE_WORKER_NAME");
    }
    if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId)) {
      throw new Error("A fork stack requires an explicit CLOUDFLARE_ACCOUNT_ID");
    }
  }
  return {
    name,
    state: {
      ...(workerName === undefined ? {} : { workerName }),
      ...(accountId === undefined ? {} : { accountId }),
    },
  };
}

export function relayEndpointNamespace(stackName: string, stage: string): string {
  return stackName === "T3CodeRelay" ? stage : `${stackName.toLowerCase()}-${stage}`;
}
