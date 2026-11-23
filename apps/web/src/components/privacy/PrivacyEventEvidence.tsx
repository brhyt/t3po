import type { PrivacyJournal } from "@t3tools/contracts";
import { T } from "gt-react";
type Event = PrivacyJournal["events"][number];
export function PrivacyEventEvidence({ event }: { event: Event }) {
  const attribution = event.launchAttribution;
  return (
    <div className="my-2 space-y-1 break-all text-muted-foreground">
      <div>
        <T>Launch evidence</T>: {attribution?.evidence ?? "unknown"}
      </div>
      <div>
        <T>Initiating component</T>: {attribution?.component ?? "unknown"}
      </div>
      <div>
        <T>Provider instance</T>: {attribution?.providerInstanceId ?? "unknown"}
      </div>
      <div>
        <T>Opaque launch ID</T>: {attribution?.launchId ?? "unknown"}
      </div>
      <div>
        <T>Launch origin thread</T>: {attribution?.initiatingThreadId ?? "unknown"}
      </div>
      <p>
        <T>
          Workflow remains unknown. Launch evidence cannot prove a user request or model cause.
          Copied credentials and shared hosts limit attribution.
        </T>
      </p>
      <div>
        <T>Stage evidence</T>:{" "}
        {event.stages
          ? Object.entries(event.stages)
              .map(([stage, evidence]) => `${stage}: ${evidence}`)
              .join(" · ")
          : "unknown"}
      </div>
    </div>
  );
}
export function PrivacyFindingEvidence({ finding }: { finding: Event["findings"][number] }) {
  return (
    <div className="text-muted-foreground">
      <div>
        <T>Detector</T>: {finding.detectorId ?? "unknown"}
      </div>
      <div>
        <T>Detection context</T>: {finding.context ?? "unknown"}
      </div>
      <div>
        <T>Destination expectation</T>: {finding.destinationExpectation ?? "unknown"}
      </div>
      <div>
        <T>Value presence</T>: {finding.valuePresence ?? "unknown"}
      </div>
      <div>
        <T>Value type</T>: {finding.valueType ?? "unknown"}
      </div>
    </div>
  );
}
