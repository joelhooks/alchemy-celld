/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- esbuild Promise adapter. */
import { Effect, Option, Path } from "effect";
import { build } from "esbuild";

import { buildDiagnostics, redactedEntrypoint } from "./build-diagnostics.ts";
import { HostError } from "./host-error.ts";

export const operatorBundle = Effect.fn("Nest.operatorBundle")(function* operatorBundle(
  entrypoint: string,
) {
  const path = yield* Path.Path;

  const output = yield* Effect.tryPromise({
    catch: (cause) =>
      new HostError({
        operation: "build-operator",
        reason: "Operator bundle build failed",
        field: "entrypoint",
        expectedShape: "A readable Node source entrypoint with valid syntax and resolvable imports",
        action: "Correct the reported build diagnostic and regenerate the operator bundle.",
        entrypoint: redactedEntrypoint(entrypoint),
        diagnostics: buildDiagnostics(cause),
      }),
    try: () =>
      build({
        absWorkingDir: path.dirname(entrypoint),
        banner: {
          js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
        },
        bundle: true,
        entryPoints: [entrypoint],
        format: "esm",
        logLevel: "silent",
        outfile: "operator.mjs",
        platform: "node",
        target: "es2022",
        write: false,
      }),
  });

  const bundle = output.outputFiles?.find((file) => file.path.endsWith("operator.mjs"));

  if (bundle === undefined) {
    return yield* new HostError({
      operation: "build-operator",
      reason: "Operator build produced no bundle",
      field: "outputFiles",
      expectedShape: "An output file named operator.mjs",
      action: "Check the build output configuration and regenerate the operator module.",
      entrypoint: redactedEntrypoint(entrypoint),
      diagnostics: [
        {
          code: "missing-output",
          severity: "error",
          field: "outputFiles",
          text: "Operator build produced no bundle",
        },
        ...buildDiagnostics({ warnings: output.warnings }),
      ],
    });
  }

  return bundle.text;
});

export const optionalOperatorBundle = Effect.fn("Nest.optionalOperatorBundle")(
  function* optionalOperatorBundle(enabled: boolean, entrypoint: string) {
    if (enabled) {
      return Option.some(yield* operatorBundle(entrypoint));
    }

    return Option.none<string>();
  },
);
