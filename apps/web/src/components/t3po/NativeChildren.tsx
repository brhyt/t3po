import { useState } from "react";
import { Button } from "../ui/button";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useEnvironmentThreadRefs, useQuietThreadProjection } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { deriveNativeChildren } from "./nativeChildren";

export function NativeChildren({
  environmentId,
  threadId,
  parentTitle,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  parentTitle: string;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  const threadRefs = useEnvironmentThreadRefs(environmentId);
  const exists = threadRefs.some((ref) => ref.threadId === threadId);
  const projection = useQuietThreadProjection(
    expanded && exists ? { environmentId, threadId } : null,
  )?.projection;
  const providers = useEnvironmentProviders().get(environmentId);
  const entries = deriveProviderInstanceEntries(providers ?? []);
  const children = projection
    ? deriveNativeChildren(projection, new Set(threadRefs.map((ref) => ref.threadId)))
    : [];
  if (!exists) return null;
  const statuses = {
    idle: gt("idle", { $context: "subagent status" }),
    pending: gt("pending", { $context: "subagent status" }),
    running: gt("running", { $context: "subagent status" }),
    waiting: gt("waiting", { $context: "subagent status" }),
    completed: gt("completed", { $context: "subagent status" }),
    failed: gt("failed", { $context: "subagent status" }),
    cancelled: gt("cancelled", { $context: "subagent status" }),
    interrupted: gt("interrupted", { $context: "subagent status" }),
  };
  return (
    <section className="mt-3 space-y-2 border-t pt-3" aria-label={gt("Native children")}>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <T>Native children</T>
      </Button>
      {expanded ? (
        <>
          <p className="break-words text-xs text-muted-foreground">
            {gt("Parent: {name}", { name: parentTitle })}
          </p>
          {!projection ? (
            <p role="status">
              <T>Loading…</T>
            </p>
          ) : children.length === 0 ? (
            <p>
              <T>No agents yet</T>
            </p>
          ) : null}
          <ul className="space-y-2">
            {children.map(({ child, navigableThreadId }) => (
              <li key={child.id} className="space-y-1 text-sm">
                {navigableThreadId ? (
                  <Link
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId: navigableThreadId }}
                    className="break-words text-primary hover:underline"
                  >
                    {child.title || child.id}
                  </Link>
                ) : (
                  <span className="break-words">{child.title || child.id}</span>
                )}
                <p className="break-words text-xs text-muted-foreground">
                  {statuses[child.status]}
                  {" · "}
                  {entries.find((entry) => entry.instanceId === child.providerInstanceId)
                    ?.displayName ?? child.driver}
                  {child.model ? ` · ${child.model}` : null}
                </p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
