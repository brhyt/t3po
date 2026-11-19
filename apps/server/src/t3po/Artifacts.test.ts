// @effect-diagnostics nodeBuiltinImport:off -- Real filesystem fixtures exercise symlinks and deletion.
import { it, expect } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProjectId, RunId, MessageId } from "@t3tools/contracts";
import * as Sqlite from "../persistence/Sqlite.ts";
import migration from "../persistence/Migrations/105_T3poArtifacts.ts";
import { ArtifactError } from "../../../../packages/contracts/src/t3poArtifacts.ts";
import * as Artifacts from "./Artifacts.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

it("rejects escapes, missing files, directories and file/total overflow", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "artifacts-"));
  try {
    await NodeFSP.mkdir(NodePath.join(root, "work"));
    await NodeFSP.writeFile(NodePath.join(root, "outside"), "private");
    await NodeFSP.symlink(NodePath.join(root, "outside"), NodePath.join(root, "work", "link"));
    for (const selected of ["../outside", "link", "missing", ".", "/etc/passwd"])
      await expect(
        Artifacts.captureSelectedFiles(NodePath.join(root, "work"), [selected]),
      ).rejects.toBeDefined();
    await NodeFSP.writeFile(
      NodePath.join(root, "work", "large"),
      Buffer.alloc(Artifacts.MAX_FILE_BYTES + 1),
    );
    await expect(
      Artifacts.captureSelectedFiles(NodePath.join(root, "work"), ["large"]),
    ).rejects.toMatchObject({ reason: "limit" });
    await NodeFSP.mkdir(NodePath.join(root, "work", "nested"));
    await NodeFSP.writeFile(NodePath.join(root, "work", "nested", "report.md"), "safe");
    await NodeFSP.symlink("nested/report.md", NodePath.join(root, "work", "internal"));
    expect(
      (
        await Artifacts.captureSelectedFiles(NodePath.join(root, "work"), ["internal"])
      )[0]!.content.toString(),
    ).toBe("safe");
    for (let i = 0; i < 6; i++)
      await NodeFSP.writeFile(
        NodePath.join(root, "work", `file-${i}`),
        Buffer.alloc(Artifacts.MAX_FILE_BYTES),
      );
    await expect(
      Artifacts.captureSelectedFiles(
        NodePath.join(root, "work"),
        Array.from({ length: 6 }, (_, i) => `file-${i}`),
      ),
    ).rejects.toMatchObject({ reason: "limit" });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("rejects an ancestor replaced by a symlink after resolution and before open", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "artifacts-race-"));
  try {
    const work = NodePath.join(root, "work");
    const directory = NodePath.join(work, "nested");
    const outside = NodePath.join(root, "outside");
    await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.mkdir(outside);
    await NodeFSP.writeFile(NodePath.join(directory, "report.md"), "safe");
    await NodeFSP.writeFile(NodePath.join(outside, "report.md"), "private");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const originalOpen = actual.open;
    using intercepted = vi
      .spyOn(NodeFSP, "open")
      .mockImplementationOnce(async (filename, flags, mode) => {
        await NodeFSP.rename(directory, NodePath.join(work, "moved"));
        await NodeFSP.symlink(outside, directory);
        return originalOpen(filename, flags, mode);
      });
    await expect(Artifacts.captureSelectedFiles(work, ["nested/report.md"])).rejects.toBeDefined();
    expect(intercepted).toHaveBeenCalledOnce();
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it.effect(
  "saves immutable bytes atomically, survives source removal, scopes reads and paginates",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "versions-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "report.md"), "original"));
      const database = yield* SqlClient.SqlClient;
      const installed =
        yield* database`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 't3po_artifact_versions'`;
      if (!installed.length) yield* migration;
      const projectId = ProjectId.make("p");
      const runId = RunId.make("run");
      const result = {
        runId,
        runOrdinal: 1,
        messageId: MessageId.make("message"),
        completedAt: "2026-11-18T00:00:00Z",
        checkpointId: null,
        text: "result",
        truncated: false,
      };
      const source = Layer.succeed(Artifacts.ArtifactSource, {
        resolve: () => Effect.succeed({ threadId: "thread", workspacePath: root, result }),
      });
      yield* Effect.gen(function* () {
        const service = yield* Artifacts.Artifacts;
        const input = { projectId, taskId: "task", runId, paths: ["report.md"] };
        const saved = yield* service.save(input);
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(root, "report.md"), "changed"));
        for (let i = 0; i < 10; i++) yield* service.save({ ...input, paths: [] });
        const failed = yield* Effect.result(service.save({ ...input, paths: ["missing"] }));
        expect(failed._tag).toBe("Failure");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER reject_artifact BEFORE INSERT ON t3po_artifact_files BEGIN SELECT RAISE(ABORT, 'fixture'); END`;
        expect((yield* Effect.result(service.save(input)))._tag).toBe("Failure");
        yield* sql`DROP TRIGGER reject_artifact`;
        expect(
          (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM t3po_artifact_versions`)[0]!
            .count,
        ).toBe(11);
        yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
        yield* sql`DELETE FROM orchestration_v2_projection_runs`;
        const bytes = yield* service.read({ projectId, versionId: saved.id, path: "report.md" });
        expect(Buffer.from(bytes.base64, "base64").toString()).toBe("original");
        expect(bytes.sha256).toBe(saved.files[0]!.sha256);
        const page = yield* service.list(input);
        expect(page.versions).toHaveLength(10);
        expect(
          (yield* service.list({ ...input, before: page.nextCursor! })).versions.map((v) => v.id),
        ).toEqual([saved.id]);
        expect(
          (yield* service.list({ ...input, projectId: ProjectId.make("other") })).versions,
        ).toEqual([]);
        expect(
          (yield* Effect.result(
            service.save(input).pipe(
              Effect.provideService(Artifacts.ArtifactAccess, {
                authorize: () => Effect.fail(new ArtifactError({ reason: "unauthorized" })),
              }),
            ),
          ))._tag,
        ).toBe("Failure");
      }).pipe(
        Effect.provide(Artifacts.layer.pipe(Layer.provide(source))),
        Effect.provideService(Artifacts.ArtifactAccess, { authorize: () => Effect.void }),
      );
    }).pipe(Effect.scoped, Effect.provide(Sqlite.layerMemory)),
);
