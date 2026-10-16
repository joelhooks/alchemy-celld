/* oxlint-disable typescript/promise-function-async -- esbuild is a Promise-based operator adapter. */
import { Effect, Schema } from "effect";
import { build } from "esbuild";

import {
  BuildDiagnostic,
  RedactedEntrypoint,
  buildDiagnostics,
  redactedEntrypoint,
} from "./build-diagnostics.ts";
import { ErrorDetails, errorMessage } from "./error-details.ts";

export class WorkerBundleFailure extends Schema.TaggedError<WorkerBundleFailure>()(
  "WorkerBundleFailure",
  {
    operation: Schema.tag("build-worker"),
    reason: Schema.String,
    ...ErrorDetails,
    entrypoint: RedactedEntrypoint,
    diagnostics: Schema.Array(BuildDiagnostic),
  },
) {
  override get message(): string {
    return errorMessage(this);
  }
}

export const workerBundle = Effect.fn("Alchemy.Worker.bundle")(function* workerBundle(
  entrypoint: string,
) {
  const output = yield* Effect.tryPromise({
    catch: (cause) =>
      new WorkerBundleFailure({
        reason: "Worker bundle build failed",
        field: "entrypoint",
        expectedShape: "A readable source entrypoint with valid syntax and resolvable imports",
        action:
          "Correct the reported diagnostic at its line/column and rebuild; input values are redacted.",
        entrypoint: redactedEntrypoint(entrypoint),
        diagnostics: buildDiagnostics(cause),
      }),
    try: () =>
      build({
        bundle: true,
        conditions: ["workerd", "worker", "browser"],
        entryPoints: [entrypoint],
        external: ["cloudflare:workers", "node:*"],
        format: "esm",
        logLevel: "silent",
        outfile: "worker.mjs",
        platform: "browser",
        target: "es2022",
        write: false,
      }),
  });

  const module = output.outputFiles?.find((file) => file.path.endsWith("worker.mjs"));

  if (module === undefined) {
    return yield* Effect.fail(
      new WorkerBundleFailure({
        reason: "Build produced no Worker module",
        field: "outputFiles",
        expectedShape: "An output file named worker.mjs",
        action: "Check the build output configuration and regenerate the Worker module.",
        entrypoint: redactedEntrypoint(entrypoint),
        diagnostics: [
          {
            code: "missing-output",
            severity: "error",
            field: "outputFiles",
            text: "Build produced no Worker module",
          },
          ...buildDiagnostics({ warnings: output.warnings }),
        ],
      }),
    );
  }

  return module.text;
});
