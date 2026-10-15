import { Effect, Schema } from "effect";

import { AbsolutePath, refuse } from "./files.ts";
import type { Node } from "./inventory-schema.ts";

export const InstanceNameSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{0,15}$/u));

export type InstanceName = typeof InstanceNameSchema.Type;

export const PortBaseSchema = Schema.Int.check(
  Schema.isBetween({ maximum: 65_526, minimum: 1024 }),
);

export type PortBase = typeof PortBaseSchema.Type;

export interface InstanceProps {
  readonly instance: InstanceName;
  readonly portBase: PortBase;
  readonly restartGate: boolean;
}

export const instanceLayout = (
  host: Node,
  props: InstanceProps & { readonly dataRoot?: string },
) => {
  const { instance, portBase: base, restartGate } = props;

  return {
    bin: `${host.home}/.local/share/${instance}/bin`,
    binaryRoot: `${host.home}/.local/share/${instance}`,
    configuration: `${host.home}/.config/${instance}`,
    dataRoot: props.dataRoot ?? host.dataRoot,
    instance,
    nodeUnit: `${instance}-celld.service`,
    portBase: base,
    ports: {
      filer: base + 2,
      filerGrpc: base + 3,
      internal: base + 1,
      master: base + 4,
      masterGrpc: base + 5,
      public: base,
      s3: base + 6,
      s3Grpc: base + 7,
      volume: base + 8,
      volumeGrpc: base + 9,
    },
    restartGate,
    retentionTimer: `${instance}-storage-retention.timer`,
    retentionUnit: `${instance}-storage-retention.service`,
    slice: `${instance}.slice`,
    storeUnit: `${instance}-seaweedfs.service`,
  };
};

export type InstanceLayout = ReturnType<typeof instanceLayout>;

export const validateInstance = Effect.fn("Instance.validate")(function* validate(
  host: Node,
  props: InstanceProps & { readonly dataRoot?: string },
) {
  yield* Schema.decodeEffect(InstanceNameSchema)(props.instance).pipe(
    Effect.mapError(() => refuse("Invalid instance name.")),
  );
  yield* Schema.decodeEffect(PortBaseSchema)(props.portBase).pipe(
    Effect.mapError(() => refuse("Invalid instance port base.")),
  );
  yield* Schema.decodeEffect(Schema.Boolean)(props.restartGate).pipe(
    Effect.mapError(() => refuse("Restart-gate choice is required.")),
  );
  yield* Schema.decodeEffect(AbsolutePath)(props.dataRoot ?? host.dataRoot).pipe(
    Effect.mapError(() => refuse("Invalid instance data root.")),
  );

  const layout = instanceLayout(host, props);

  if (
    [`${host.home}/.config`, `${host.home}/.local/share`].some(
      (root) =>
        layout.dataRoot === root ||
        layout.dataRoot.startsWith(`${root}/`) ||
        root.startsWith(`${layout.dataRoot}/`),
    )
  ) {
    return yield* refuse("Data roots must not overlap configuration or binary custody.");
  }

  return layout;
});
