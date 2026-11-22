import type { PrivacyJournal, PrivacyRule } from "@t3tools/contracts";
import { T } from "gt-react";
import { Button } from "../ui/button";

export function PrivacyFindings({
  journal,
  canChange,
  pending,
  apply,
}: {
  journal: PrivacyJournal;
  canChange: boolean;
  pending: boolean;
  apply: (rule: PrivacyRule) => Promise<void>;
}) {
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h3 className="font-medium">
        <T>Recurring findings</T>
      </h3>
      <p className="text-sm text-muted-foreground">
        <T>
          Direct traffic is unobserved. A configured proxy or an empty journal does not establish
          coverage. Findings are masked signals for investigation, not proof of a leak.
        </T>
      </p>
      {journal.issues?.length ? (
        <div className="space-y-2">
          {journal.issues.map((issue) => (
            <div key={issue.id} className="space-y-1 rounded border p-3 text-sm">
              <p className="break-all font-medium">
                {issue.host} · {issue.kind}
              </p>
              <p className="text-muted-foreground">
                {issue.source} · {issue.location} · {issue.occurrences} <T>occurrences</T> ·{" "}
                {issue.blocked} <T>blocked</T>
              </p>
              <p>
                {issue.state === "reviewed" ? (
                  <T>Reviewed; not certified fixed</T>
                ) : (
                  <T>Needs review</T>
                )}{" "}
                · {new Date(issue.lastSeen * 1000).toLocaleString()}
              </p>
              <details>
                <summary className="cursor-pointer">
                  <T>Finding detail</T>
                </summary>
                <p className="mt-2">
                  <T>Severity and confidence: unknown</T>
                </p>
                <p>
                  <T>First seen</T>: {new Date(issue.firstSeen * 1000).toLocaleString()}
                </p>
                <p>
                  <T>Last reviewed</T>:{" "}
                  {issue.reviewedAt ? (
                    new Date(issue.reviewedAt * 1000).toLocaleString()
                  ) : (
                    <T>Not reviewed</T>
                  )}
                </p>
                <p>
                  <T>
                    Counts cover retained finding history, not all traffic. Reviewed does not mean
                    verified fixed.
                  </T>
                </p>
              </details>
              <Button
                size="sm"
                variant="outline"
                disabled={!canChange || pending}
                onClick={() =>
                  void apply({
                    action: issue.state === "reviewed" ? "reopen-finding" : "review-finding",
                    findingId: issue.id,
                  })
                }
              >
                {issue.state === "reviewed" ? <T>Reopen</T> : <T>Mark reviewed</T>}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm">
          {journal.issues === undefined ? (
            <T>Finding history is unavailable from this observer.</T>
          ) : (
            <T>No retained findings. This does not establish that traffic is safe.</T>
          )}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        <T>
          A new matching event reopens a reviewed finding. Clearing the live journal preserves this
          history.
        </T>
      </p>
    </section>
  );
}
