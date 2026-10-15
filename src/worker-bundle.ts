/* oxlint-disable typescript/promise-function-async -- esbuild is a Promise-based operator adapter. */
import { Effect, Schema } from "effect";
import { build } from "esbuild";

export class WorkerBundleFailure extends Schema.TaggedError<WorkerBundleFailure>()(
  "WorkerBundleFailure",
  {},
) {}

export const workerBundle = Effect.fn("Alchemy.Worker.bundle")(function* workerBundle(
  entrypoint: string,
) {
  const output = yield* Effect.tryPromise({
    catch: () => new WorkerBundleFailure({}),
    try: () =>
      build({
        bundle: true,
        conditions: ["workerd", "worker", "browser"],
        entryPoints: [entrypoint],
        external: ["cloudflare:workers", "node:*"],
        format: "esm",
        outfile: "worker.mjs",
        platform: "browser",
        target: "es2022",
        write: false,
      }),
  });

  const module = output.outputFiles?.find((file) => file.path.endsWith("worker.mjs"));

  if (module === undefined) {
    return yield* Effect.fail(new WorkerBundleFailure({}));
  }

  return module.text;
});
