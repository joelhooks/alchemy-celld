/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- esbuild is an operator-machine Promise adapter. */
import { Effect } from "effect";
import { build } from "esbuild";

import { bundleDefines, DeploymentError, wranglerConfiguration } from "./deployment-config.ts";
import type { DeploymentBuild, Declaration } from "./deployment-config.ts";

export const prepareDeployment = Effect.fn("Celld.Deployment.build")(function* prepareDeployment(
  entrypoint: string,
  declaration: typeof Declaration.Type,
  input: Omit<DeploymentBuild, "main">,
) {
  const config = yield* wranglerConfiguration(declaration, {
    ...input,
    main: "worker.mjs",
  });

  const output = yield* Effect.tryPromise({
    catch: () => new DeploymentError({ reason: "Operator bundle build failed" }),
    try: () =>
      build({
        bundle: true,
        conditions: ["workerd", "worker", "browser"],
        define: bundleDefines(input),
        entryPoints: [entrypoint],
        external: ["cloudflare:workers", "node:*"],
        format: "esm",
        outfile: "worker.mjs",
        platform: "browser",
        target: "es2022",
        write: false,
      }),
  });

  const bundle = output.outputFiles?.find((file) => file.path.endsWith("worker.mjs"));

  if (bundle === undefined) {
    return yield* new DeploymentError({
      reason: "Build produced no Worker module",
    });
  }

  return {
    bundle: bundle.text,
    commit: input.commit,
    configuration: JSON.stringify(config),
    version: input.version,
  };
});
