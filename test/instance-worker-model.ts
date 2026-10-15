import type { Effect } from "effect";
import { Context, Schema } from "effect";

export const WorkerMode = Schema.Literals([
  "bootstrap",
  "installed",
  "wrong",
  "unavailable",
  "transport",
  "invalid-schema",
]);

export const isWorkerInstall = (argv: readonly string[]) =>
  argv[0] === "sh" && argv.some((argument) => argument.includes(" deploy "));

export class WorkerFixture extends Context.Service<
  WorkerFixture,
  {
    readonly installs: Effect.Effect<number>;
    readonly set: (mode: typeof WorkerMode.Type) => Effect.Effect<void>;
  }
>()("Test/InstanceWorkerFixture") {}
