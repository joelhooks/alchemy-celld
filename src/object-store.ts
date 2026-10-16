import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Random, RandomProvider } from "alchemy/Random";
import { Effect, Layer, Redacted } from "effect";

import { BucketProvider, BucketResource } from "./bucket-api.ts";
import { refuse, textDigest } from "./files.ts";
import { instanceStoreUnit } from "./instance-units.ts";
import { validateInstanceName, validateInstance } from "./instance.ts";
import type { InstanceAdoption, InstanceProps } from "./instance.ts";
import type { Node } from "./inventory-schema.ts";
import { renderMaintenanceScript } from "./maintenance-render.ts";
import { validateMaintenanceGuard } from "./maintenance-guard.ts";
import type { MaintenanceGuard } from "./maintenance-guard.ts";
import { operatorBundle } from "./operator-build.ts";
import { weedBinary } from "./pins.ts";
import {
  HostDirectory,
  ReleaseBinary,
  RemoteFile,
  SystemdUnit,
  providers as hostProviders,
} from "./providers.ts";
import { sliceUnit } from "./service-units.ts";
import type { ServiceLimits } from "./service-units.ts";
import { storageRetentionTimer, storageRetentionUnit } from "./storage-maintenance.ts";
import { renderUnit } from "./systemd.ts";

export interface SliceProps {
  readonly adopt?: InstanceAdoption;
  readonly cpuQuota?: string;
  readonly home: string;
  readonly instance: string;
  readonly memoryHigh?: string;
  readonly memoryMax?: string;
}

export const Slice = (props: SliceProps) =>
  Effect.gen(function* slice() {
    const instance = yield* validateInstanceName(props.instance, props.adopt);

    return yield* SystemdUnit(
      `${instance}-slice`,
      sliceUnit(props.home, props.memoryMax, props.cpuQuota, props),
    );
  });

export interface StoreProps extends InstanceProps, ServiceLimits {
  readonly maintenanceGuard: MaintenanceGuard;
  readonly dataRoot?: string;
  readonly host: Node;
  readonly name: string;
  readonly prepared?: readonly Output.Output<string>[];
  readonly purgeOnDelete?: boolean;
  readonly restartGateBundle?: string | undefined;
  readonly slice: Output.Output<string>;
  readonly volumeMax?: number;
  readonly volumePreStopSeconds?: 0;
}

export const Bucket = (id: string, props: StoreProps) =>
  Effect.gen(function* bucket() {
    const { host } = props;
    yield* validateMaintenanceGuard(props.maintenanceGuard);
    const layout = yield* validateInstance(host, props);

    if (
      props.volumeMax !== undefined &&
      (!Number.isSafeInteger(props.volumeMax) || props.volumeMax < 1)
    ) {
      return yield* refuse("Invalid volume maximum.");
    }

    if (
      props.restartGateBundle !== undefined &&
      (!props.restartGate ||
        typeof props.restartGateBundle !== "string" ||
        props.restartGateBundle.trim().length === 0)
    ) {
      return yield* refuse(
        "A restart-gate bundle must be nonblank and requires restartGate: true.",
      );
    }

    if (
      props.restartGateCommands !== undefined &&
      (typeof props.restartGateBundle !== "string" || props.restartGateBundle.trim().length === 0)
    ) {
      return yield* refuse("Custom restart-gate commands require an explicit restart-gate bundle.");
    }

    if (props.volumePreStopSeconds !== undefined && props.volumePreStopSeconds !== 0) {
      return yield* refuse("volumePreStopSeconds must be 0 when supplied.");
    }

    const root = yield* HostDirectory("binary-root", {
      mode: 0o700,
      path: layout.binaryRoot,
    });

    const bin = yield* HostDirectory("bin", {
      mode: 0o700,
      path: Output.interpolate`${root.path}/bin`,
    });

    const configuration = yield* HostDirectory("config-root", {
      mode: 0o700,
      path: layout.configuration,
    });

    const dataRoot = yield* HostDirectory("data-root", {
      mode: 0o700,
      path: layout.dataRoot,
    });

    const data = yield* HostDirectory("data", {
      mode: 0o700,
      path: Output.interpolate`${dataRoot.path}/seaweedfs`,
      purgeOnDelete: props.purgeOnDelete ?? false,
      purgeRoot: layout.dataRoot,
    });

    const binary = yield* ReleaseBinary("weed", {
      ...weedBinary(`${layout.bin}/weed`),
      path: Output.interpolate`${bin.path}/weed`,
    });

    const restartGateBundle = props.restartGate
      ? (props.restartGateBundle ??
        (yield* operatorBundle(new URL("instance-restart-gate.ts", import.meta.url).pathname)))
      : undefined;

    const gate =
      restartGateBundle === undefined
        ? undefined
        : yield* RemoteFile("restart-gate", {
            content: restartGateBundle,
            mode: 0o600,
            path: Output.interpolate`${bin.path}/restart-gate.mjs`,
          });

    const access = yield* Random("access-key", { bytes: 16 });
    const secret = yield* Random("secret-key", { bytes: 32 });

    const declaration = instanceStoreUnit(host, layout, {
      cpuQuota: props.cpuQuota,
      memoryMax: props.memoryMax,
      oomPolicy: props.oomPolicy,
      restartGate: gate !== undefined,
      volumeMax: props.volumeMax,
      volumePreStopSeconds: props.volumePreStopSeconds,
    });

    const identity = yield* RemoteFile("identity", {
      content: Output.all(access.text, secret.text).pipe(
        Output.map(([accessKey, secretKey]) =>
          Redacted.make(
            JSON.stringify({
              identities: [
                {
                  actions: ["Admin", "Read", "Write", "List", "Tagging"],
                  credentials: [
                    {
                      accessKey: Redacted.value(accessKey),
                      secretKey: Redacted.value(secretKey),
                    },
                  ],
                  name: layout.instance,
                },
              ],
            }),
          ),
        ),
      ),
      mode: 0o600,
      path: Output.interpolate`${configuration.path}/s3.json`,
      rotationOwner: {
        home: host.home,
        name: layout.storeUnit,
        sha256: textDigest(renderUnit(declaration)),
      },
    });

    const unit = yield* SystemdUnit("server", {
      ...declaration,
      prepared: [
        binary.path,
        data.path,
        identity.path,
        props.slice,
        gate?.sha256 ?? props.slice,
        ...(props.prepared ?? []),
      ],
      restartOn: Output.all(identity.sha256, binary.sha256),
    });

    const maintenance = yield* RemoteFile("storage-maintenance", {
      content: renderMaintenanceScript(host, props).text,
      mode: 0o600,
      path: Output.interpolate`${bin.path}/storage-maintenance.py`,
    });

    const retention = yield* SystemdUnit(
      "storage-retention",
      Output.all(maintenance.path, maintenance.sha256, unit.sha256, props.slice).pipe(
        Output.map(([path, scriptHash, unitHash, sliceHash]) =>
          storageRetentionUnit(host.home, path, [scriptHash, unitHash, sliceHash], layout),
        ),
      ),
    );

    yield* SystemdUnit(
      "storage-retention-timer",
      Output.all(retention.sha256, maintenance.sha256).pipe(
        Output.map((ready) => storageRetentionTimer(host.home, ready, layout)),
      ),
    );

    const resource = yield* BucketResource("bucket", {
      config: identity.path,
      endpoint: `http://127.0.0.1:${layout.ports.s3}`,
      name: props.name,
      ownedStore: Output.all(unit.home, unit.sha256).pipe(
        Output.map(([home, sha256]) => ({
          home,
          name: layout.storeUnit,
          sha256,
        })),
      ),
      purgeOnDelete: props.purgeOnDelete ?? false,
      ready: unit.sha256,
      region: "us-east-1",
    });

    return {
      accessKey: access.text,
      bin: bin.path,
      binaryRoot: root.path,
      bucketName: resource.name,
      configuration: configuration.path,
      dataRoot: dataRoot.path,
      endpoint: resource.endpoint,
      layout,
      region: resource.region,
      resource,
      restartGate: gate,
      secretKey: secret.text,
      storageMaintenance: maintenance,
    };
  }).pipe(Namespace.push(id));

export type BucketOutput = Effect.Success<ReturnType<typeof Bucket>>;

export const providers = () => Layer.mergeAll(hostProviders(), RandomProvider(), BucketProvider());

export const ObjectStore = { Bucket, Slice, providers };
