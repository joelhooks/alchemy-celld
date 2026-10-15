/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- esbuild Promise adapter. */
import { Effect, Option, Path } from "effect";
import { build } from "esbuild";

import { refuse } from "./files.ts";

export const operatorBundle = Effect.fn("Nest.operatorBundle")(function* operatorBundle(
  entrypoint: string,
) {
  const path = yield* Path.Path;

  const output = yield* Effect.tryPromise({
    catch: () => refuse("Operator bundle build failed"),
    try: () =>
      build({
        absWorkingDir: path.dirname(entrypoint),
        banner: {
          js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
        },
        bundle: true,
        entryPoints: [entrypoint],
        format: "esm",
        outfile: "operator.mjs",
        platform: "node",
        target: "es2022",
        write: false,
      }),
  });

  const bundle = output.outputFiles?.find((file) => file.path.endsWith("operator.mjs"));

  if (bundle === undefined) {
    return yield* refuse("Operator build produced no bundle");
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
