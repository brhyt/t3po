import { describe, expect, it } from "vitest";

import { blockedCommandMatch, withAgentEnvironment } from "./mcpSession.ts";

describe("blockedCommandMatch", () => {
  const blocked = ["git push --force", "gh repo delete"];
  it("finds a blocked command however it is wrapped", () => {
    expect(blockedCommandMatch("git push --force origin main", blocked)).toBe("git push --force");
    expect(blockedCommandMatch("cd x && /usr/bin/git  push --force", blocked)).toBe(
      "git push --force",
    );
    expect(blockedCommandMatch(`bash -c "gh repo delete me/x --yes"`, blocked)).toBe(
      "gh repo delete",
    );
    expect(blockedCommandMatch("sudo gh repo delete x", blocked)).toBe("gh repo delete");
  });
  it("lets other commands through", () => {
    expect(blockedCommandMatch("git push origin main", blocked)).toBeUndefined();
    expect(blockedCommandMatch("git push --force-with-lease", blocked)).toBeUndefined();
    expect(blockedCommandMatch("gh repo view", blocked)).toBeUndefined();
    expect(blockedCommandMatch("anything", [])).toBeUndefined();
    expect(blockedCommandMatch("anything", ["  "])).toBeUndefined();
  });
});

describe("withAgentEnvironment", () => {
  it("lays the space's variables over the agent's own", () => {
    expect(
      withAgentEnvironment(
        { A: "1", GH_TOKEN: "mine" },
        { agentEnvironment: { GH_TOKEN: "space" } },
      ),
    ).toEqual({ A: "1", GH_TOKEN: "space" });
    const base = { A: "1" };
    expect(withAgentEnvironment(base, undefined)).toBe(base);
  });
});
