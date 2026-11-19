// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Axiom from "@alchemy.run/axiom";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as Planetscale from "@alchemy.run/planetscale";

import { relayDeploymentIdentity } from "./src/deploymentIdentity.ts";
import { relayObservabilityMode } from "./src/privateDeployment.ts";
import { PublishClientConfig, tokenDigest } from "./src/clientConfig.ts";
import * as RelayDb from "./src/db.ts";
import { MobileSourceMapsUploadCredentials, RelayObservability } from "./src/observability.ts";
import { isPreviewStage } from "./src/previewStages.ts";
import { PreviewTunnelSweep, PreviewTunnelSweepProvider } from "./src/previewTunnelSweep.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./src/zone.ts";
import * as RelayWorker from "./src/worker.ts";

// Export identity variables in the shell; Alchemy imports this before loading Effect config.
const deployment = relayDeploymentIdentity(process.env);

export default Alchemy.Stack(
  deployment.name,
  {
    providers: Layer.mergeAll(
      Layer.unwrap(
        Effect.map(relayObservabilityMode, (mode) =>
          mode === "none" ? Layer.empty : Axiom.providers(),
        ),
      ).pipe(Layer.orDie),
      Cloudflare.providers(),
      Drizzle.providers(),
      Layer.unwrap(
        Effect.map(
          Config.String("RELAY_DATABASE_PROVIDER").pipe(Config.withDefault("planetscale")),
          (provider) => (provider === "external-postgres" ? Layer.empty : Planetscale.providers()),
        ),
      ).pipe(Layer.orDie),
      PreviewTunnelSweepProvider(),
    ),
    state: Cloudflare.state(deployment.state),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const db = yield* RelayDb.PlanetscaleDatabase;
    const hyperdrive = yield* RelayDb.RelayHyperdrive;
    const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const observability = yield* RelayObservability;
    const mobileSourceMapsUploadCredentials = yield* MobileSourceMapsUploadCredentials;
    const api = yield* RelayWorker.Api;
    if (isPreviewStage(stage)) {
      const { managedEndpointZoneName, endpointNamespace } = yield* RelayDeploymentConfig;
      yield* PreviewTunnelSweep("PreviewTunnelSweep", {
        stage,
        namespace: endpointNamespace,
        tunnelZoneName: managedEndpointZoneName,
        workerName: api.workerName,
      });
    }
    yield* PublishClientConfig(
      observability === undefined
        ? { url: api.url, telemetryDisabled: true }
        : {
            url: api.url,
            mobileTracingUrl: observability.traces.otelTracesEndpoint,
            mobileTracingDataset: observability.traces.name,
            mobileTracingToken: observability.mobileIngestToken.token,
            clientTracingUrl: observability.traces.otelTracesEndpoint,
            clientTracingDataset: observability.traces.name,
            clientTracingToken: observability.clientIngestToken.token,
            tokenDigest: Output.map(
              Output.all(
                observability.mobileIngestToken.token,
                observability.clientIngestToken.token,
              ),
              tokenDigest,
            ),
          },
    );

    return {
      databaseName: db?.database.name ?? "external-postgres",
      databaseBranchName: db?.branch?.name ?? "main",
      hyperdriveName: hyperdrive.name,
      workerName: api.workerName,
      url: api.url,
      relayApiZoneId: relayApiZone.zoneId,
      managedEndpointZoneId: managedEndpointZone.zoneId,
      ...(observability === undefined
        ? { telemetry: "disabled" as const }
        : {
            mobileTracingUrl: observability.traces.otelTracesEndpoint,
            mobileTracingDataset: observability.traces.name,
            mobileTracingToken: observability.mobileIngestToken.token,
            clientTracingUrl: observability.traces.otelTracesEndpoint,
            clientTracingDataset: observability.traces.name,
            clientTracingToken: observability.clientIngestToken.token,
            mobileLogsDataset: observability.mobileLogs.name,
            mobileMetricsDataset: observability.mobileMetrics.name,
            mobileSourceMapsBucket: observability.mobileSourceMaps.bucketName,
          }),
      // The MOBILE_SOURCEMAPS_R2 secret for GitHub Actions and EAS Build.
      mobileSourceMapsUploadCredentials,
    };
  }).pipe(Effect.provide(RelayWorker.layer)),
);
