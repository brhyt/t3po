#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const BETA_VERSION = "0.1.0-private.1";
export const SERVICE = "computer.ro.t3po.beta";
export function validateRevision(revision) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? ""))
    throw new Error("Supply the full reviewed fork commit SHA.");
  return revision;
}
export const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const xml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function serviceDefinition(platform, node, script, home) {
  const args = [node, script, "run"];
  if (platform === "darwin")
    return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${SERVICE}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(NodePath.join(home, "service.log"))}</string><key>StandardErrorPath</key><string>${xml(NodePath.join(home, "service.log"))}</string></dict></plist>\n`;
  if (platform !== "linux") throw new Error("Private source beta supports macOS and Linux only.");
  const quote = (a) =>
    `"${a
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("%", "%%")
      .replaceAll("$", () => "$$")}"`;
  return `[Unit]\nDescription=ro connect private beta\n[Service]\nExecStart=${args.map(quote).join(" ")}\nRestart=on-failure\nRestartSec=5\n[Install]\nWantedBy=default.target\n`;
}
function main() {
  const root = NodePath.join(NodeOS.homedir(), ".local", "share", "t3po-beta");
  const manifest = NodePath.join(root, "install.json");
  const launcher = NodePath.join(root, "ro-connect.mjs");
  // oxlint-disable-next-line t3code/no-global-process-runtime -- standalone Node installer, outside the Effect application runtime
  const platform = NodeOS.platform();
  const unit =
    platform === "darwin"
      ? NodePath.join(NodeOS.homedir(), "Library", "LaunchAgents", `${SERVICE}.plist`)
      : NodePath.join(NodeOS.homedir(), ".config", "systemd", "user", `${SERVICE}.service`);
  const run = (exe, args, options = {}) =>
    NodeChildProcess.execFileSync(exe, args, { stdio: "inherit", ...options });
  const capture = (exe, args, cwd) =>
    NodeChildProcess.execFileSync(exe, args, { cwd, encoding: "utf8" }).trim();
  const action = process.argv[2];
  if (!["install", "update", "start", "stop", "status", "pair", "run", "version"].includes(action))
    throw new Error(
      "Usage: ro-connect install|update SOURCE FULL_SHA | start|stop|status|pair|version",
    );
  if (action === "version") {
    console.log(`ro connect ${BETA_VERSION}`);
    return;
  }
  serviceDefinition(platform, process.execPath, launcher, root);
  const loaded = () => {
    try {
      run("launchctl", ["print", `gui/${process.getuid()}/${SERVICE}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  const stop = () => {
    if (platform === "darwin") {
      if (loaded()) run("launchctl", ["bootout", `gui/${process.getuid()}/${SERVICE}`]);
    } else run("systemctl", ["--user", "stop", `${SERVICE}.service`]);
  };
  const start = () => {
    if (platform === "darwin") {
      if (!loaded()) run("launchctl", ["bootstrap", `gui/${process.getuid()}`, unit]);
    } else run("systemctl", ["--user", "enable", "--now", `${SERVICE}.service`]);
  };
  if (action === "install" || action === "update") {
    const source = NodeFS.realpathSync(NodePath.resolve(process.argv[3] ?? "."));
    const revision = validateRevision(process.argv[4]);
    if (capture("git", ["rev-parse", "HEAD"], source) !== revision)
      throw new Error("Source HEAD does not match requested revision.");
    if (capture("git", ["status", "--porcelain", "--untracked-files=normal"], source))
      throw new Error("Use a clean dedicated fork checkout.");
    if (!NodeFS.existsSync(NodePath.join(source, "scripts", "ro-connect.mjs")))
      throw new Error("Source is not a ro connect fork release.");
    if (NodeFS.existsSync(manifest)) {
      const previous = JSON.parse(NodeFS.readFileSync(manifest, "utf8"));
      if (action === "install" && previous.source === source && previous.revision === revision) {
        console.log("Already installed.");
        return;
      }
      if (action === "install")
        throw new Error("Already installed; use update with a new dedicated checkout.");
      if (previous.source === source && previous.revision !== revision)
        throw new Error("Prepare updates in a separate checkout; preserve the installed source.");
    } else if (action === "update") throw new Error("Install first.");
    const bin = NodePath.join(NodeOS.homedir(), ".local", "bin", "ro-connect");
    if (
      NodeFS.existsSync(bin) &&
      !NodeFS.readFileSync(bin, "utf8").includes("# ro-connect private beta")
    )
      throw new Error(`Refusing to overwrite ${bin}`);
    if (NodeFS.existsSync(unit) && !NodeFS.readFileSync(unit, "utf8").includes("ro-connect.mjs"))
      throw new Error(`Refusing to overwrite ${unit}`);
    const vp = NodePath.join(source, "node_modules", ".bin", "vp");
    run(vp, ["run", "--filter", "@t3tools/web", "build"], { cwd: source });
    NodeFS.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (action === "update") stop();
    NodeFS.writeFileSync(
      launcher,
      NodeFS.readFileSync(NodePath.join(source, "scripts", "ro-connect.mjs")),
      {
        mode: 0o700,
      },
    );
    NodeFS.writeFileSync(
      `${manifest}.tmp`,
      JSON.stringify({ version: BETA_VERSION, revision, source, node: process.execPath }, null, 2),
      { mode: 0o600 },
    );
    NodeFS.renameSync(`${manifest}.tmp`, manifest);
    NodeFS.mkdirSync(NodePath.dirname(unit), { recursive: true });
    NodeFS.writeFileSync(unit, serviceDefinition(platform, process.execPath, launcher, root));
    NodeFS.mkdirSync(NodePath.dirname(bin), { recursive: true });
    if (
      NodeFS.existsSync(bin) &&
      !NodeFS.readFileSync(bin, "utf8").includes("# ro-connect private beta")
    )
      throw new Error(`Refusing to overwrite ${bin}`);
    NodeFS.writeFileSync(
      bin,
      `#!/bin/sh\n# ro-connect private beta\nexec ${shellQuote(process.execPath)} ${shellQuote(launcher)} "$@"\n`,
      { mode: 0o700 },
    );
    if (platform === "linux") run("systemctl", ["--user", "daemon-reload"]);
    if (action === "update") start();
    console.log(
      `Installed ro connect ${BETA_VERSION} at ${revision}. Data: ${NodePath.join(root, "data")}. Run ro-connect start.`,
    );
    return;
  }
  const config = JSON.parse(NodeFS.readFileSync(manifest, "utf8"));
  if (action === "stop") return stop();
  if (action === "status") {
    console.log(
      `ro connect ${config.version}\nRevision: ${config.revision}\nSource: ${config.source}\nData: ${NodePath.join(root, "data")}`,
    );
    return platform === "darwin"
      ? run("launchctl", ["print", `gui/${process.getuid()}/${SERVICE}`])
      : run("systemctl", ["--user", "status", `${SERVICE}.service`]);
  }
  if (
    capture("git", ["rev-parse", "HEAD"], config.source) !== config.revision ||
    capture("git", ["status", "--porcelain", "--untracked-files=normal"], config.source)
  )
    throw new Error(
      "Installed source changed; restore the reviewed checkout before starting or pairing.",
    );
  if (action === "start") return start();
  const args = [
    NodePath.join(config.source, "apps/server/src/bin.ts"),
    action === "pair" ? "pair" : "serve",
    "--base-dir",
    NodePath.join(root, "data"),
    ...(action === "run" ? ["--host", "127.0.0.1", "--port", "13774", "--no-browser"] : []),
  ];
  const env = {
    ...process.env,
    T3CODE_HOME: NodePath.join(root, "data"),
    PATH: `${NodePath.dirname(config.node)}:${NodePath.join(config.source, "node_modules", ".bin")}:${process.env.PATH}`,
  };
  delete env.VITE_DEV_SERVER_URL;
  const child = NodeChildProcess.spawn(config.node, args, {
    cwd: config.source,
    env,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
