import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Effect, Redacted, Schema } from "effect";

import { Deployment, DeploymentProvider } from "./deployment.ts";
import { textDigest, refuse } from "./files.ts";
import { instanceNodeUnit } from "./instance-units.ts";
import {
  InstancePortsSchema,
  instancePortsError,
  RestartGateCommandsSchema,
  restartGateCommandsError,
  validateInstanceName,
} from "./instance.ts";
import type { InstanceProps } from "./instance.ts";
import type { Node as HostNode } from "./inventory-schema.ts";
import { NodeProvider, NodeResource } from "./node-provider.ts";
import type { BucketOutput } from "./object-store.ts";
import { celldBinary } from "./pins.ts";
import { HostDirectory, ReleaseBinary, RemoteFile } from "./providers.ts";
import type { ServiceLimits } from "./service-units.ts";
import { renderUnit } from "./systemd.ts";

const envQuote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;

export interface CelldProps extends InstanceProps, ServiceLimits {
  readonly bucket: BucketOutput;
  readonly host: HostNode;
  readonly prepared?: readonly Output.Output<string>[];
  readonly purgeOnDelete?: boolean;
  readonly workerIPv4?: string;
}

export const Node = (id: string, props: CelldProps) =>
  Effect.gen(function* node() {
    const { host, bucket } = props;
    const { layout } = bucket;

    yield* validateInstanceName(props.instance, props.adopt);

    if (layout.configuration !== `${host.home}/.config/${layout.instance}`) {
      return yield* refuse("Node host must match its bucket.");
    }

    if (
      props.instance !== layout.instance ||
      props.portBase !== layout.portBase ||
      props.restartGate !== layout.restartGate
    ) {
      return yield* refuse("Node instance must match its bucket.");
    }

    if (props.ports !== undefined) {
      const ports = yield* Schema.decodeEffect(InstancePortsSchema, {
        onExcessProperty: "error",
      })(props.ports).pipe(Effect.mapError(() => refuse(instancePortsError)));
      const bucketPorts: Readonly<Record<string, number>> = layout.ports;
      if (Object.entries(ports).some(([name, port]) => port !== bucketPorts[name])) {
        return yield* refuse("Node ports must match its bucket.");
      }
    }

    if (props.restartGateCommands !== undefined) {
      const commands = yield* Schema.decodeEffect(RestartGateCommandsSchema, {
        onExcessProperty: "error",
      })(props.restartGateCommands).pipe(Effect.mapError(() => refuse(restartGateCommandsError)));
      if (
        !props.restartGate ||
        !layout.restartGateCommands ||
        commands.beforeNode !== layout.restartGateCommands.beforeNode ||
        commands.node !== layout.restartGateCommands.node ||
        commands.store !== layout.restartGateCommands.store
      ) {
        return yield* refuse("Node restart-gate commands must match its bucket.");
      }
    }

    const workerIPv4 = props.workerIPv4 ?? host.tailnetIPv4;

    const data = yield* HostDirectory("data", {
      mode: 0o700,
      path: Output.interpolate`${bucket.dataRoot}/celld`,
      purgeOnDelete: props.purgeOnDelete ?? false,
      purgeRoot: layout.dataRoot,
    });

    const binary = yield* ReleaseBinary("celld", {
      ...celldBinary(`${layout.bin}/celld`),
      path: Output.interpolate`${bucket.bin}/celld`,
    });

    const declaration = instanceNodeUnit(host, layout, {
      cpuQuota: props.cpuQuota,
      memoryMax: props.memoryMax,
      oomPolicy: props.oomPolicy,
      restartGate: bucket.restartGate !== undefined,
      workerIPv4,
    });

    const environment = yield* RemoteFile("environment", {
      content: Output.all(
        bucket.accessKey,
        bucket.secretKey,
        bucket.resource.name,
        bucket.resource.endpoint,
      ).pipe(
        Output.map(([access, secret, name, endpoint]) =>
          Redacted.make(
            [
              `AWS_ACCESS_KEY_ID=${envQuote(Redacted.value(access))}`,
              `AWS_SECRET_ACCESS_KEY=${envQuote(Redacted.value(secret))}`,
              "AWS_REGION=us-east-1",
              `S3_ENDPOINT=${envQuote(endpoint)}`,
              `CELLD_BUCKET=${envQuote(`s3://${name}`)}`,
              "CELLD_OTEL=0",
              "",
            ].join("\n"),
          ),
        ),
      ),
      mode: 0o600,
      path: Output.interpolate`${bucket.configuration}/celld.env`,
      rotationOwner: {
        home: host.home,
        name: layout.nodeUnit,
        sha256: textDigest(renderUnit(declaration)),
      },
    });

    const unit = yield* NodeResource("node", {
      ...declaration,
      internalUrl: `http://127.0.0.1:${layout.ports.internal}`,
      prepared: [
        binary.path,
        data.path,
        environment.path,
        bucket.resource.name,
        bucket.restartGate?.sha256 ?? bucket.resource.name,
        bucket.storageMaintenance.sha256,
        ...(props.prepared ?? []),
      ],
      publicUrl: `http://${workerIPv4}:${layout.ports.public}`,
      restartOn: Output.all(environment.sha256, binary.sha256),
      version: "v0.6.1",
    });

    return {
      internalUrl: unit.internalUrl,
      layout,
      publicUrl: unit.publicUrl,
      unit,
      version: unit.version,
    };
  }).pipe(Namespace.push(id));

export const Celld = {
  Deployment,
  Node,
  deploymentProvider: DeploymentProvider,
  providers: NodeProvider,
};
