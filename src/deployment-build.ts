/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- esbuild is an operator-machine Promise adapter. */
import { Effect } from "effect";
import { build } from "esbuild";

import { buildDiagnostics, redactedEntrypoint } from "./build-diagnostics.ts";

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
    catch: (cause) =>
      new DeploymentError({
        reason: "Operator bundle build failed",
        field: "entrypoint",
        expectedShape: "A readable source entrypoint with valid syntax and resolvable imports",
        action: "Correct the reported build diagnostic and regenerate the deployment bundle.",
        entrypoint: redactedEntrypoint(entrypoint),
        diagnostics: buildDiagnostics(cause),
      }),
    try: () =>
      build({
        bundle: true,
        conditions: ["workerd", "worker", "browser"],
        define: bundleDefines(input),
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

  const bundle = output.outputFiles?.find((file) => file.path.endsWith("worker.mjs"));

  if (bundle === undefined) {
    return yield* new DeploymentError({
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
    });
  }

  return {
    bundle: bundle.text,
    commit: input.commit,
    configuration: JSON.stringify(config),
    version: input.version,
  };
});
