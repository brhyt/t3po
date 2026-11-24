import { T, useGT } from "gt-react";
import type { AttentionPage, AttentionItem } from "@t3tools/contracts";
import { uniqueAttention } from "@t3tools/client-runtime/state/t3poAttention";
import { Button } from "../ui/button";
export function NeedsYou({
  page,
  error,
  onOpen,
  onOpenProject,
  onPage,
}: {
  page?: AttentionPage;
  error?: string;
  onOpen: (item: AttentionItem) => void;
  onOpenProject: (target: "budget" | "memory") => void;
  onPage: (before?: number) => void;
}) {
  const gt = useGT();
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">
        <T>Needs you</T>
      </h3>
      {error ? <p role="alert">{error}</p> : null}
      {!page && !error ? (
        <p role="status">
          <T>Loading…</T>
        </p>
      ) : null}
      {page?.projectItems.map((item) => (
        <div key={item.key} className="space-y-1 text-sm">
          <Button
            variant="link"
            size="sm"
            onClick={() => onOpenProject(item.reason === "budget" ? "budget" : "memory")}
          >
            {item.reason === "budget" ? <T>Review run budget</T> : <T>Review memory delivery</T>}
          </Button>
          <p className="text-muted-foreground">
            {item.reason === "budget" ? (
              <T>New task runs are disabled.</T>
            ) : (
              gt("Delivery receipt missing for {count} records.", { count: item.pendingCount })
            )}
          </p>
        </div>
      ))}
      {page && page.items.length === 0 && page.projectItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <T>No items on this page.</T>
        </p>
      ) : null}
      {uniqueAttention(page?.items ?? []).map((item) => (
        <div key={item.key} className="flex items-center gap-2 text-sm">
          <Button variant="link" size="sm" onClick={() => onOpen(item)}>
            {item.title}
          </Button>
          <span>
            {item.reason === "request" ? (
              <T>Response needed</T>
            ) : item.reason === "plan" ? (
              <T>Plan to review</T>
            ) : item.reason === "failed" ? (
              <T>Work needs intervention</T>
            ) : (
              <T>Result to review</T>
            )}
          </span>
        </div>
      ))}
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={() => onPage()}>
          <T>Latest</T>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={page?.nextCursor == null}
          onClick={() => {
            if (page?.nextCursor != null) onPage(page.nextCursor);
          }}
        >
          <T>Next</T>
        </Button>
      </div>
    </section>
  );
}
