import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, Schema } from "effect";

import { AbsolutePath, refuse } from "./files.ts";
import { assertStarted, stopUnits } from "./instance-startup-contract.ts";
import { waitForStorage } from "./instance-storage-readiness.ts";
import { RestartGateContextSchema, PortBaseSchema, validateInstance } from "./instance.ts";
import { localExec } from "./local-exec.ts";

const program = Effect.gen(function* restartGate() {
  const address = yield* Schema.decodeUnknownEffect(Schema.String)(process.argv[2]);

  const action = yield* Schema.decodeUnknownEffect(
    Schema.Literals(["store", "node", "before-node"]),
  )(process.argv[3]);

  // The complete context below determines strict-new-name versus explicit adoption validation.
  const instance = yield* Schema.decodeUnknownEffect(Schema.String)(process.argv[4]);

  const portBase = yield* Schema.decodeUnknownEffect(PortBaseSchema)(Number(process.argv[5]));

  const dataRoot = yield* Schema.decodeUnknownEffect(AbsolutePath)(process.argv[6]);

  const home = yield* Config.String("HOME");

  const contextArgument = process.argv[7];
  const context =
    contextArgument === undefined
      ? {}
      : yield* Schema.decodeEffect(Schema.fromJsonString(RestartGateContextSchema), {
          onExcessProperty: "error",
        })(contextArgument).pipe(Effect.mapError(() => refuse("Invalid restart-gate context.")));

  const layout = yield* validateInstance(
    { dataRoot, home, ssh: "unused", tailnetIPv4: address },
    { dataRoot, instance, portBase, restartGate: true, ...context },
  );

  const shell = yield* localExec;

  if (action === "before-node") {
    const location = yield* Config.String("CELLD_BUCKET");

    if (!location.startsWith("s3://")) {
      return yield* refuse("Storage bucket is not configured");
    }

    return yield* waitForStorage(shell, {
      bucket: location.slice(5),
      configuration: layout.configuration,
      endpoint: yield* Config.String("S3_ENDPOINT"),
      home,
    });
  }

  const nodeActive =
    (yield* shell.exec(["systemctl", "--user", "is-active", layout.nodeUnit])).code === 0;

  return yield* assertStarted(
    shell,
    address,
    action === "node" || nodeActive,
    layout,
    action === "store" ? 120 : 40,
  ).pipe(
    Effect.catchTag("HostError", (error) =>
      Effect.logError("RESTART_GATE_FAILED_UNITS_LEFT_RUNNING", error),
    ),
    Effect.catchTag("ListenerExposure", ({ receipt }) =>
      stopUnits(shell, [layout.nodeUnit, layout.storeUnit]).pipe(
        Effect.andThen(
          Effect.fail(
            refuse(`Startup listener contract violated; instance units stopped.\n${receipt}`),
          ),
        ),
      ),
    ),
  );
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
