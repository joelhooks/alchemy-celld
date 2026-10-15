// @effect-diagnostics asyncFunction:off -- The launcher delays dynamic module loading until after selecting the external state directory.
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, FileSystem, Path, Schema } from "effect";

import { refuse } from "../src/files.ts";

const Actions = Schema.Literals([
  "deploy",
  "plan",
  "diagnose",
  "race",
  "listeners",
  "health",
  "bootstrap",
  "preflight",
  "store-listeners",
  "status",
  "uid-probe",
  "bootstrap-check",
]);

const program = Effect.gen(function* launcher() {
  const disabled = yield* Config.String("ALCHEMY_TELEMETRY_DISABLED");

  if (disabled !== "1") {
    return yield* refuse("Alchemy telemetry must be disabled.");
  }

  yield* Config.String("FLEET_LIVE_NODE");
  const action = yield* Schema.decodeUnknownEffect(Actions)(process.argv[2]);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* Config.String("FLEET_STATE_DIR");
  const root = path.resolve(import.meta.dirname, "..");
  const resolved = path.resolve(directory);

  if (resolved === root || resolved.startsWith(`${root}/`)) {
    return yield* refuse("Alchemy state must be outside the repository.");
  }

  yield* fs.makeDirectory(resolved, { mode: 0o700, recursive: true });
  const canonical = yield* fs.realPath(resolved);

  if (canonical === root || canonical.startsWith(`${root}/`)) {
    return yield* refuse("Alchemy state resolves inside the repository.");
  }

  yield* fs.chmod(canonical, 0o700);
  process.chdir(canonical);

  const runtime = yield* Effect.tryPromise({
    catch: () => refuse("Example runtime import failed."),
    try: async () => await import("./runtime.ts"),
  });

  return yield* runtime.run(action);
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
