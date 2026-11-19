import { describe, expect, it } from "vite-plus/test";
import { relayDeploymentIdentity, relayEndpointNamespace } from "./deploymentIdentity.ts";

const ACCOUNT = "a".repeat(32);
describe("private deployment identity", () => {
  it("preserves upstream defaults", () => {
    expect(relayDeploymentIdentity({})).toEqual({ name: "T3CodeRelay", state: {} });
    expect(relayEndpointNamespace("T3CodeRelay", "prod")).toBe("prod");
  });
  it("requires a distinct state worker and pinned account for a fork", () => {
    const fork = { RELAY_STACK_NAME: "RoRelay" };
    expect(() => relayDeploymentIdentity(fork)).toThrow();
    expect(() =>
      relayDeploymentIdentity({
        ...fork,
        RELAY_STATE_WORKER_NAME: "alchemy-state-store",
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      }),
    ).toThrow();
    expect(() =>
      relayDeploymentIdentity({ ...fork, RELAY_STATE_WORKER_NAME: "ro-relay-state" }),
    ).toThrow();
    expect(
      relayDeploymentIdentity({
        ...fork,
        RELAY_STATE_WORKER_NAME: "ro-relay-state",
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      }),
    ).toEqual({ name: "RoRelay", state: { workerName: "ro-relay-state", accountId: ACCOUNT } });
    expect(relayEndpointNamespace("RoRelay", "prod")).toBe("rorelay-prod");
  });
  it("rejects invalid identities before Alchemy loads state", () => {
    for (const name of ["", "../prod", "ro relay", "a".repeat(41)]) {
      expect(() => relayDeploymentIdentity({ RELAY_STACK_NAME: name })).toThrow();
    }
    expect(() => relayDeploymentIdentity({ RELAY_STATE_WORKER_NAME: "bad.worker" })).toThrow();
  });
});
