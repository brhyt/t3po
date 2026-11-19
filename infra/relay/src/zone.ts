import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Zones from "@distilled.cloud/cloudflare/zones";
import { authorizeWith } from "@alchemy.run/cloudflare/HttpClientUtils";
import * as Schema from "effect/Schema";
import { relayEndpointNamespace } from "./deploymentIdentity.ts";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  MANAGED_ENDPOINT_ZONE_OWNER_STAGE,
  relayOwnsManagedEndpointZone,
  relayPublicDomainForStage,
} from "./deploymentConfig.ts";

function withLogicalId<Resource extends object>(resource: Resource, logicalId: string): Resource {
  return new Proxy(resource, {
    has: (target, property) => property === "LogicalId" || property in target,
    get: (target, property, receiver) =>
      property === "LogicalId" ? logicalId : Reflect.get(target, property, receiver),
  });
}

export const RelayDeploymentConfig = Effect.gen(function* () {
  const { stage, name } = yield* Alchemy.Stack;
  const existingZones = yield* existingZoneIds;
  const relayApiZoneName = yield* Config.NonEmptyString("RELAY_API_ZONE_NAME");
  const managedEndpointZoneName = yield* Config.NonEmptyString("RELAY_TUNNEL_ZONE_NAME");
  const relayPublicDomainOverride = yield* Config.String("RELAY_DOMAIN").pipe(
    Config.option,
    Config.map(
      Option.flatMap((value) => {
        const trimmed = value.trim();
        return trimmed ? Option.some(trimmed) : Option.none();
      }),
    ),
  );
  const relayPublicDomain = Option.getOrElse(relayPublicDomainOverride, () =>
    relayPublicDomainForStage(stage, relayApiZoneName),
  );

  return {
    stage,
    endpointNamespace: relayEndpointNamespace(name, stage),
    existingZones,
    relayPublicDomain,
    relayPublicOrigin: `https://${relayPublicDomain}`,
    relayApiZoneName,
    managedEndpointZoneName,
  };
});

const ManagedEndpointZoneResource = RelayDeploymentConfig.pipe(
  Effect.flatMap(({ stage, managedEndpointZoneName }) =>
    relayOwnsManagedEndpointZone(stage)
      ? Cloudflare.Zone.Zone("ManagedEndpointZone", { name: managedEndpointZoneName }).pipe(
          adopt(true),
        )
      : Cloudflare.Zone.Zone.ref("ManagedEndpointZone", {
          stage: MANAGED_ENDPOINT_ZONE_OWNER_STAGE,
        }).pipe(
          // Alchemy DNS policies need LogicalId for stable SIDs; Resource.ref returns a lazy proxy.
          Effect.map((zone) => withLogicalId(zone, "ManagedEndpointZone")),
        ),
  ),
);

const RelayApiZoneResource = RelayDeploymentConfig.pipe(
  Effect.flatMap(({ stage, relayApiZoneName, managedEndpointZoneName }) =>
    relayApiZoneName === managedEndpointZoneName
      ? ManagedEndpointZoneResource
      : relayOwnsManagedEndpointZone(stage)
        ? Cloudflare.Zone.Zone("RelayApiZone", { name: relayApiZoneName }).pipe(adopt(true))
        : Cloudflare.Zone.Zone.ref("RelayApiZone", {
            stage: MANAGED_ENDPOINT_ZONE_OWNER_STAGE,
          }),
  ),
);

export const existingZoneIds = Effect.gen(function* () {
  const mode = yield* Config.schema(
    Schema.Literals(["managed", "existing"]),
    "RELAY_ZONE_MODE",
  ).pipe(Config.withDefault("managed"));
  if (mode === "managed") return undefined;
  const id = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/i));
  return {
    api: yield* Config.schema(id, "RELAY_API_ZONE_ID"),
    tunnel: yield* Config.schema(id, "RELAY_TUNNEL_ZONE_ID"),
  };
});

/** Read-only lookup: no Zone resource is registered, adopted, updated or deleted. */
const existingZone = (zoneId: string, name: string) => ({
  kind: "existing" as const,
  name: Output.literal(name),
  zoneId: Output.fromEffect(
    Effect.gen(function* () {
      const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
      const zone = yield* Zones.getZone({ zoneId });
      if (zone.name !== name || zone.account.id !== accountId) {
        return yield* Effect.die(`Existing zone ${zoneId} does not match configured name/account`);
      }
      return zoneId;
    }).pipe(Effect.orDie),
  ),
});

export const ManagedEndpointZone = Effect.gen(function* () {
  const config = yield* RelayDeploymentConfig;
  if (config.existingZones)
    return existingZone(config.existingZones.tunnel, config.managedEndpointZoneName);
  const resource = yield* ManagedEndpointZoneResource;
  return { kind: "managed" as const, resource, name: resource.name, zoneId: resource.zoneId };
});

export const RelayApiZone = Effect.gen(function* () {
  const config = yield* RelayDeploymentConfig;
  if (config.existingZones) return existingZone(config.existingZones.api, config.relayApiZoneName);
  const resource = yield* RelayApiZoneResource;
  return { kind: "managed" as const, resource, name: resource.name, zoneId: resource.zoneId };
});

export const ManagedEndpointDns = Effect.gen(function* () {
  const zone = yield* ManagedEndpointZone;
  if (zone.kind === "managed") return yield* Cloudflare.DNS.ReadWriteDns(zone.resource);
  // Only the runtime DNS credential is managed; the existing zone remains external.
  const token = yield* Cloudflare.ApiToken.AccountApiToken("ManagedEndpointDnsToken", {
    policies: [
      {
        effect: "allow",
        permissionGroups: ["DNS Read", "DNS Write"],
        resources: Output.map(zone.zoneId, (id) => ({
          [`com.cloudflare.api.account.zone.${id}`]: "*",
        })),
      },
    ],
  });
  const value = yield* token.value;
  const zoneId = yield* zone.zoneId;
  return Cloudflare.DNS.dnsReadWriteClient({ authorize: authorizeWith({ value }) }, zoneId);
});
