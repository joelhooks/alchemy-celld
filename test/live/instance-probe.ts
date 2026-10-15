import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, FileSystem, Path, Schema } from "effect";

import { refuse } from "../../src/files.ts";
import { runInstanceProbe } from "../../src/instance-probe-runtime.ts";
import { probeTeardown } from "../../src/probe-receipts.ts";

const Actions = Schema.Literals([
  "plan",
  "deploy",
  "health",
  "destroy-plan",
  "destroy",
  "verify-gone",
  "render-units",
]);

const program = Effect.gen(function* launcher() {
  if ((yield* Config.String("ALCHEMY_TELEMETRY_DISABLED")) !== "1") {
    return yield* refuse("Alchemy telemetry must be disabled.");
  }

  const action = yield* Schema.decodeUnknownEffect(Actions)(process.argv[2]);
  yield* Config.String("FLEET_LIVE_NODE");
  yield* Config.String("FLEET_PROBE_DATA_ROOT");

  if (action === "render-units") {
    return yield* runInstanceProbe(action);
  }

  const directory = yield* Config.String("FLEET_STATE_DIR");
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const root = yield* fs.realPath(path.resolve(import.meta.dirname, "../.."));

  const resolved = path.resolve(directory);

  if (resolved === root || resolved.startsWith(`${root}/`)) {
    return yield* refuse("Probe state must be outside the repository.");
  }

  yield* fs.makeDirectory(resolved, { mode: 0o700, recursive: true });
  const canonical = yield* fs.realPath(resolved);

  if (canonical === root || canonical.startsWith(`${root}/`)) {
    return yield* refuse("Probe state resolves inside the repository.");
  }

  yield* fs.chmod(canonical, 0o700);
  process.chdir(canonical);

  return yield* runInstanceProbe(action);
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)), {
  teardown: probeTeardown,
});
