import { Effect, Schema } from "effect";

import { AbsolutePath, refuse } from "./files.ts";
import type { Node } from "./inventory-schema.ts";
import { maintenanceGuardBlocks, validateMaintenanceGuard } from "./maintenance-guard.ts";
import type { MaintenanceGuard } from "./maintenance-guard.ts";

export const InstanceNameSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{0,15}$/u));

export type InstanceName = typeof InstanceNameSchema.Type;

export const PortBaseSchema = Schema.Int.check(
  Schema.isBetween({ maximum: 65_526, minimum: 1024 }),
);

export type PortBase = typeof PortBaseSchema.Type;

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));

export const instancePortsError =
  "Missing or invalid ports. Pass ports: { public, internal, filer, filerGrpc, master, masterGrpc, s3, s3Grpc, volume, volumeGrpc } with all ten integer ports between 1 and 65535.";
export const restartGateCommandsError =
  "Missing or invalid restartGateCommands. Pass restartGateCommands: { beforeNode, node, store } with three nonblank command strings containing no CR, LF or NUL, and set restartGate: true.";

export const InstancePortsSchema = Schema.Struct({
  public: Port,
  internal: Port,
  filer: Port,
  filerGrpc: Port,
  master: Port,
  masterGrpc: Port,
  s3: Port,
  s3Grpc: Port,
  volume: Port,
  volumeGrpc: Port,
});

export type InstancePorts = typeof InstancePortsSchema.Type;

// Keep the existing 16-character owner-unit/credential-rotation bound, even for adopted names.
export const InstanceAdoptionSchema = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    Schema.isMaxLength(16),
  ),
  acceptsNestedSlice: Schema.Literal(true),
});

export type InstanceAdoption = typeof InstanceAdoptionSchema.Type;

const GateCommand = Schema.NonEmptyString.check(
  Schema.isPattern(/^[^\r\n\0]+$/u),
  Schema.isPattern(/\S/u),
);

export const RestartGateCommandsSchema = Schema.Struct({
  beforeNode: GateCommand,
  node: GateCommand,
  store: GateCommand,
});

export type RestartGateCommands = typeof RestartGateCommandsSchema.Type;

export const RestartGateContextSchema = Schema.Struct({
  ports: Schema.optionalKey(InstancePortsSchema),
  adopt: Schema.optionalKey(InstanceAdoptionSchema),
});

export const validateInstanceName = Effect.fn("Instance.validateName")(function* validateName(
  instance: string,
  adopt?: InstanceAdoption,
) {
  if (adopt !== undefined) {
    yield* Schema.decodeEffect(InstanceAdoptionSchema, { onExcessProperty: "error" })(adopt).pipe(
      Effect.mapError(() =>
        refuse("Adoption requires a safe existing name and acceptsNestedSlice: true."),
      ),
    );
    if (adopt.name !== instance) {
      return yield* refuse("Adopted name must match the instance name.");
    }
  } else {
    yield* Schema.decodeEffect(InstanceNameSchema)(instance).pipe(
      Effect.mapError(() => refuse("Invalid instance name.")),
    );
  }
  return instance;
});

export const uniformInstancePorts = (base: PortBase): InstancePorts => ({
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
});

export interface InstanceProps {
  readonly instance: InstanceName;
  readonly portBase: PortBase;
  readonly ports?: InstancePorts;
  readonly adopt?: InstanceAdoption;
  readonly restartGate: boolean;
  readonly restartGateCommands?: RestartGateCommands;
  readonly maintenanceGuard?: MaintenanceGuard;
}

export const instanceLayout = (
  host: Node,
  props: InstanceProps & { readonly dataRoot?: string },
) => {
  const { instance, portBase: base, restartGate } = props;

  // This pure renderer is also public. Never silently fall back on an invalid override.
  if (
    props.ports !== undefined &&
    (!Schema.is(InstancePortsSchema)(props.ports) || Object.keys(props.ports).length !== 10)
  ) {
    throw refuse(instancePortsError);
  }
  if (
    props.adopt !== undefined &&
    (!Schema.is(InstanceAdoptionSchema)(props.adopt) ||
      Object.keys(props.adopt).length !== 2 ||
      props.adopt.name !== instance)
  ) {
    throw refuse("Adoption requires a matching safe name and acceptsNestedSlice: true.");
  }
  if (
    props.restartGateCommands !== undefined &&
    (!restartGate ||
      !Schema.is(RestartGateCommandsSchema)(props.restartGateCommands) ||
      Object.keys(props.restartGateCommands).length !== 3)
  ) {
    throw refuse(restartGateCommandsError);
  }

  if (props.maintenanceGuard !== undefined) maintenanceGuardBlocks(props.maintenanceGuard);

  return {
    ...(props.maintenanceGuard === undefined ? {} : { maintenanceGuard: props.maintenanceGuard }),
    ...(props.adopt === undefined ? {} : { adopt: props.adopt }),
    ...(props.restartGateCommands === undefined
      ? {}
      : { restartGateCommands: props.restartGateCommands }),
    bin: `${host.home}/.local/share/${instance}/bin`,
    binaryRoot: `${host.home}/.local/share/${instance}`,
    configuration: `${host.home}/.config/${instance}`,
    dataRoot: props.dataRoot ?? host.dataRoot,
    instance,
    nodeUnit: `${instance}-celld.service`,
    portBase: base,
    ports: props.ports ?? uniformInstancePorts(base),
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
  yield* validateInstanceName(props.instance, props.adopt);
  if (props.maintenanceGuard !== undefined) yield* validateMaintenanceGuard(props.maintenanceGuard);
  yield* Schema.decodeEffect(PortBaseSchema)(props.portBase).pipe(
    Effect.mapError(() => refuse("Invalid instance port base.")),
  );
  if (props.ports !== undefined) {
    yield* Schema.decodeEffect(InstancePortsSchema, { onExcessProperty: "error" })(
      props.ports,
    ).pipe(Effect.mapError(() => refuse(instancePortsError)));
  }
  yield* Schema.decodeEffect(Schema.Boolean)(props.restartGate).pipe(
    Effect.mapError(() => refuse("Restart-gate choice is required.")),
  );
  if (props.restartGateCommands !== undefined) {
    yield* Schema.decodeEffect(RestartGateCommandsSchema, { onExcessProperty: "error" })(
      props.restartGateCommands,
    ).pipe(Effect.mapError(() => refuse(restartGateCommandsError)));
    if (!props.restartGate) {
      return yield* refuse("Custom restart-gate commands require restartGate: true.");
    }
  }
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
