// @effect-diagnostics nodeBuiltinImport:off -- Descriptor-based containment and bounded positional reads require Node file handles.
import * as Store from "./Store.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Option from "effect/Option";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import {
  ArtifactError,
  ArtifactVersion,
  type ArtifactQuery,
  type ArtifactSave,
  type ArtifactRead,
  type ArtifactPage,
} from "../../../../packages/contracts/src/t3poArtifacts.ts";
import type { ProjectId, T3poResult } from "@t3tools/contracts";

// Supplied per request by the authenticated USER transport, never by agent tools.
export class ArtifactAccess extends Context.Service<
  ArtifactAccess,
  {
    readonly authorize: (
      projectId: ProjectId,
      write: boolean,
    ) => Effect.Effect<void, ArtifactError>;
  }
>()("t3/t3po/Artifacts/ArtifactAccess") {}
export class ArtifactSource extends Context.Service<
  ArtifactSource,
  {
    readonly resolve: (
      input: ArtifactSave,
    ) => Effect.Effect<
      { threadId: string; workspacePath: string | null; result: T3poResult },
      ArtifactError
    >;
  }
>()("t3/t3po/Artifacts/ArtifactSource") {}
export const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * MAX_FILE_BYTES;
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const contained = (root: string, file: string) => {
  const rel = NodePath.relative(root, file);
  return (
    rel !== "" && !rel.startsWith(`..${NodePath.sep}`) && rel !== ".." && !NodePath.isAbsolute(rel)
  );
};
export async function captureSelectedFiles(root: string, paths: readonly string[]) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Native open flags must match the actual kernel, never a substituted runtime platform.
  const platform = NodeOS.platform();
  if (paths.length > 20 || new Set(paths).size !== paths.length)
    throw new ArtifactError({ reason: "limit" });
  if (platform !== "linux" && platform !== "darwin")
    throw new ArtifactError({ reason: "unavailable" });
  // Darwin 20+ supports whole-path no-follow; older kernels may ignore unknown flags.
  if (platform === "darwin" && !(Number.parseInt(NodeOS.release(), 10) >= 20))
    throw new ArtifactError({ reason: "unavailable" });
  // Darwin's O_NOFOLLOW_ANY (absent from Node constants) must not be combined with O_NOFOLLOW.
  // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h
  const noFollow = platform === "darwin" ? 0x20000000 : NodeFS.constants.O_NOFOLLOW;
  const base = await NodeFSP.realpath(root);
  let total = 0;
  const files = [];
  for (const selected of paths) {
    if (
      !selected ||
      selected.length > 1024 ||
      selected.includes("\\") ||
      NodePath.isAbsolute(selected) ||
      selected.split("/").some((part) => part === ".." || part === "." || part === "")
    )
      throw new ArtifactError({ reason: "path" });
    const target = await NodeFSP.realpath(NodePath.join(base, selected));
    if (!contained(base, target)) throw new ArtifactError({ reason: "path" });
    const file = await NodeFSP.open(
      target,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK | noFollow,
    );
    try {
      // Linux checks the descriptor; Darwin rejects every symlink during open itself.
      if (
        platform === "linux" &&
        !contained(base, await NodeFSP.realpath(`/proc/self/fd/${file.fd}`))
      )
        throw new ArtifactError({ reason: "path" });
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile()) throw new ArtifactError({ reason: "path" });
      if (stat.size > BigInt(MAX_FILE_BYTES)) throw new ArtifactError({ reason: "limit" });
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      const after = await file.stat({ bigint: true });
      total += size;
      if (size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES)
        throw new ArtifactError({ reason: "limit" });
      if (
        stat.size !== after.size ||
        stat.mtimeNs !== after.mtimeNs ||
        stat.ctimeNs !== after.ctimeNs
      )
        throw new ArtifactError({ reason: "unavailable" });
      if (platform === "darwin") {
        const currentPath = await NodeFSP.realpath(target);
        const current = await NodeFSP.stat(currentPath, { bigint: true });
        if (currentPath !== target || current.dev !== stat.dev || current.ino !== stat.ino)
          throw new ArtifactError({ reason: "unavailable" });
      }
      const content = buffer.subarray(0, size);
      files.push({ path: selected, sha256: hash(content), bytes: size, content });
    } finally {
      await file.close();
    }
  }
  return files;
}
/** @effect-expect-leaking ArtifactAccess -- Authorization is per request, never captured from another session. */
export class Artifacts extends Context.Service<
  Artifacts,
  {
    readonly save: (
      input: ArtifactSave,
    ) => Effect.Effect<ArtifactVersion, ArtifactError, ArtifactAccess>;
    readonly list: (
      input: ArtifactQuery,
    ) => Effect.Effect<ArtifactPage, ArtifactError, ArtifactAccess>;
    readonly read: (
      input: ArtifactRead,
    ) => Effect.Effect<{ base64: string; sha256: string }, ArtifactError, ArtifactAccess>;
  }
>()("t3/t3po/Artifacts") {}
const isArtifactError = Schema.is(ArtifactError);
const encodeVersion = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeVersion = Schema.decodeEffect(Schema.fromJsonString(ArtifactVersion));
const mapError = (cause: unknown) =>
  isArtifactError(cause) ? cause : new ArtifactError({ reason: "storage", cause });
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const source = yield* ArtifactSource;
  const save = Effect.fn("Artifacts.save")(function* (input: ArtifactSave) {
    yield* (yield* ArtifactAccess).authorize(input.projectId, true);
    const origin = yield* source.resolve(input);
    if (
      origin.result.runId !== input.runId ||
      Buffer.byteLength(origin.result.text) > MAX_TOTAL_BYTES
    )
      return yield* new ArtifactError({ reason: "unavailable" });
    if (input.paths.length && !origin.workspacePath)
      return yield* new ArtifactError({ reason: "unavailable" });
    const files = input.paths.length
      ? yield* Effect.tryPromise({
          try: () => captureSelectedFiles(origin.workspacePath!, input.paths),
          catch: mapError,
        })
      : [];
    const version = {
      id: NodeCrypto.randomUUID(),
      projectId: input.projectId,
      taskId: input.taskId,
      threadId: origin.threadId,
      savedAt: DateTime.formatIso(yield* DateTime.now),
      result: origin.result,
      resultSha256: hash(Buffer.from(origin.result.text)),
      files: files.map(({ content: _content, ...meta }) => meta),
    };
    const encoded = yield* encodeVersion(version);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          sequence: number;
        }>`INSERT INTO t3po_artifact_versions(id, project_id, task_id, data) VALUES (${version.id}, ${input.projectId}, ${input.taskId}, ${encoded}) RETURNING sequence`;
        for (const file of files)
          yield* sql`INSERT INTO t3po_artifact_files(version_id, path, sha256, content) VALUES (${version.id}, ${file.path}, ${file.sha256}, ${file.content})`;
        return { ...version, sequence: rows[0]!.sequence };
      }),
    );
  }, Effect.mapError(mapError));
  const list = Effect.fn("Artifacts.list")(function* (input: ArtifactQuery) {
    yield* (yield* ArtifactAccess).authorize(input.projectId, false);
    const rows = yield* sql<{
      sequence: number;
      data: string;
    }>`SELECT sequence, json_set(data, '$.sequence', sequence) AS data FROM t3po_artifact_versions WHERE project_id = ${input.projectId} AND task_id = ${input.taskId} ${input.before === undefined ? sql`` : sql`AND sequence < ${input.before}`} ORDER BY sequence DESC LIMIT 11`;
    const versions = yield* Effect.forEach(rows.slice(0, 10), (row) => decodeVersion(row.data));
    return { versions, nextCursor: rows.length > 10 ? rows[9]!.sequence : null };
  }, Effect.mapError(mapError));
  const read = Effect.fn("Artifacts.read")(function* (input: ArtifactRead) {
    yield* (yield* ArtifactAccess).authorize(input.projectId, false);
    const rows = yield* sql<{
      content: Uint8Array;
      sha256: string;
    }>`SELECT f.content, f.sha256 FROM t3po_artifact_files f JOIN t3po_artifact_versions v ON v.id = f.version_id WHERE v.project_id = ${input.projectId} AND v.id = ${input.versionId} AND f.path = ${input.path}`;
    const row = rows[0];
    if (!row || hash(row.content) !== row.sha256)
      return yield* new ArtifactError({ reason: "unavailable" });
    return { base64: Buffer.from(row.content).toString("base64"), sha256: row.sha256 };
  }, Effect.mapError(mapError));
  return Artifacts.of({ save, list, read });
});
export const layer = Layer.effect(Artifacts, make);

export const sourceLayer = Layer.effect(
  ArtifactSource,
  Effect.gen(function* () {
    const store = yield* Store.Store;
    const threads = yield* Threads.ThreadManagementService;
    const projects = yield* Projects.ProjectService;
    const sql = yield* SqlClient.SqlClient;
    return ArtifactSource.of({
      resolve: Effect.fn("ArtifactSource.resolve")(function* (input: ArtifactSave) {
        const task = yield* store.getTask(input.taskId, input.projectId);
        const project = yield* projects.getById(input.projectId);
        if (Option.isNone(project)) return yield* new ArtifactError({ reason: "unavailable" });
        const runs = yield* sql<{
          ordinal: number;
        }>`SELECT ordinal FROM orchestration_v2_projection_runs WHERE run_id = ${input.runId} AND thread_id = ${task.threadId} AND status = 'completed'`;
        if (!runs[0]) return yield* new ArtifactError({ reason: "unavailable" });
        const result = (yield* store.results(
          { projectId: input.projectId, taskId: input.taskId, before: runs[0].ordinal + 1 },
          1,
        )).results[0];
        if (!result || result.runId !== input.runId)
          return yield* new ArtifactError({ reason: "unavailable" });
        const texts = yield* sql<{
          text: string;
        }>`SELECT substr(COALESCE(json_extract(m.payload_json, '$.text'), json_extract(i.payload_json, '$.text'), ''), 1, ${MAX_FILE_BYTES + 1}) AS text FROM orchestration_v2_projection_turn_items i LEFT JOIN orchestration_v2_projection_messages m ON m.message_id = ${result.messageId} AND m.thread_id = ${task.threadId} WHERE i.thread_id = ${task.threadId} AND i.run_id = ${input.runId} AND json_extract(i.payload_json, '$.messageId') = ${result.messageId} LIMIT 1`;
        const text = texts[0]?.text;
        if (text === undefined || Buffer.byteLength(text) > MAX_FILE_BYTES)
          return yield* new ArtifactError({ reason: "limit" });
        const shell = yield* threads.getThreadShell(task.threadId);
        const workspacePath =
          shell?.worktreePath ??
          (task.workspace?.type === "worktree" ? null : project.value.workspaceRoot);
        return {
          threadId: task.threadId,
          workspacePath,
          result: { ...result, text, truncated: false },
        };
      }, Effect.mapError(mapError)),
    });
  }),
);
