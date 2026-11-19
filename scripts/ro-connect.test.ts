// @effect-diagnostics nodeBuiltinImport:off - Exercises the source installer in an isolated subprocess and filesystem.
import { describe, expect, it } from "vite-plus/test";
import { serviceDefinition, validateRevision, shellQuote } from "./ro-connect.mjs";

describe("ro connect source service", () => {
  it("requires an exact commit rather than a moving branch or shell expression", () => {
    for (const value of ["main", "a2dbf8ae4a", "$(touch nope)", "", undefined])
      expect(() => validateRevision(value)).toThrow();
    expect(validateRevision("a".repeat(40))).toBe("a".repeat(40));
  });
  it("escapes service arguments and keeps the fork service separate", () => {
    const linux = serviceDefinition("linux", "/node with space", '/source/$a%p"b', "/data");
    expect(linux).toContain('"/node with space"');
    expect(linux).toContain('$$a%%p\\"b');
    const mac = serviceDefinition("darwin", "/node", "/source/<a>&b", "/data");
    expect(mac).toContain("computer.ro.t3po.beta");
    expect(mac).toContain("<key>KeepAlive</key><true/>");
    expect(mac).toContain("<key>ThrottleInterval</key><integer>10</integer>");
    expect(mac).toContain("&lt;a&gt;&amp;b");
    expect(mac).not.toContain("com.t3tools.t3code");
    expect(() => serviceDefinition("win32", "", "", "")).toThrow();
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

// oxlint-disable-next-line t3code/no-global-process-runtime -- this subprocess fixture executes only the Linux service manager path
it.skipIf(NodeOS.platform() !== "linux")(
  "installs idempotently and preserves data when an update build fails",
  () => {
    const sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ro-connect-"));
    try {
      const home = NodePath.join(sandbox, "home");
      const source = NodePath.join(sandbox, "source");
      const next = NodePath.join(sandbox, "next");
      const bin = NodePath.join(sandbox, "bin");
      NodeFS.mkdirSync(bin, { recursive: true });
      for (const path of [source, next]) {
        NodeFS.mkdirSync(NodePath.join(path, "scripts"), { recursive: true });
        NodeFS.mkdirSync(NodePath.join(path, "node_modules/.bin"), { recursive: true });
        NodeFS.copyFileSync(
          NodePath.resolve("scripts/ro-connect.mjs"),
          NodePath.join(path, "scripts/ro-connect.mjs"),
        );
        NodeFS.writeFileSync(
          NodePath.join(path, "node_modules/.bin/vp"),
          `#!/bin/sh\nexit ${path === next ? 1 : 0}\n`,
          { mode: 0o700 },
        );
      }
      NodeFS.writeFileSync(
        NodePath.join(bin, "git"),
        `#!/bin/sh\nif [ "$1" = rev-parse ]; then echo ${"a".repeat(40)}; fi\n`,
        { mode: 0o700 },
      );
      NodeFS.writeFileSync(NodePath.join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const cli = (args: string[]) =>
        NodeChildProcess.execFileSync(
          process.execPath,
          [NodePath.resolve("scripts/ro-connect.mjs"), ...args],
          {
            env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
            encoding: "utf8",
            stdio: "pipe",
          },
        );
      cli(["install", source, "a".repeat(40)]);
      const data = NodePath.join(home, ".local/share/t3po-beta/data");
      NodeFS.mkdirSync(data);
      NodeFS.writeFileSync(NodePath.join(data, "keep"), "user data");
      expect(cli(["install", source, "a".repeat(40)])).toContain("Already installed");
      const manifest = NodePath.join(home, ".local/share/t3po-beta/install.json");
      const before = NodeFS.readFileSync(manifest, "utf8");
      expect(() => cli(["update", next, "a".repeat(40)])).toThrow();
      expect(NodeFS.readFileSync(manifest, "utf8")).toBe(before);
      expect(NodeFS.readFileSync(NodePath.join(data, "keep"), "utf8")).toBe("user data");
      expect(() => cli(["update", source, "main"])).toThrow();
    } finally {
      NodeFS.rmSync(sandbox, { recursive: true, force: true });
    }
  },
);
