import { NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { expect, vi } from "vitest";

vi.mock("esbuild", () => ({
  build: vi.fn().mockResolvedValue({
    errors: [],
    warnings: [{ text: "EXAMPLE_PRIVATE_BUILD_WARNING", location: null }],
    outputFiles: [],
  }),
}));

import { prepareDeployment } from "../src/deployment-build.ts";
import type { DeploymentError } from "../src/deployment-config.ts";
import type { HostError } from "../src/host-error.ts";
import type { WorkerBundleFailure } from "../src/worker-bundle.ts";
import { operatorBundle } from "../src/operator-build.ts";
import { workerBundle } from "../src/worker-bundle.ts";

it.effect(
  "missing-output plants preserve error identities and identify the exact expected output",
  () =>
    Effect.gen(function* missingOutput() {
      const worker = yield* workerBundle("example-entry.ts").pipe(Effect.result);
      const operator = yield* operatorBundle("example-entry.ts").pipe(
        Effect.provide(NodePath.layer),
        Effect.result,
      );
      const deployment = yield* prepareDeployment(
        "example-entry.ts",
        {
          compatibility_date: "2026-10-04",
          compatibility_flags: [],
          durable_objects: { bindings: [] },
          migrations: [],
          name: "example-worker",
        },
        { commit: "example-commit", version: "example-version", vars: {} },
      ).pipe(Effect.result);
      const outcomes: readonly Result.Result<
        unknown,
        WorkerBundleFailure | HostError | DeploymentError
      >[] = [worker, operator, deployment];
      for (const result of outcomes) {
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.diagnostics?.[0]?.code).toBe("missing-output");
          expect(result.failure.diagnostics?.[1]?.severity).toBe("warning");
          expect(JSON.stringify(result.failure)).not.toContain("EXAMPLE_PRIVATE_BUILD_WARNING");
          expect(result.failure.field).toBe("outputFiles");
          expect(result.failure.entrypoint).toMatchObject({ redacted: true, extension: ".ts" });
          expect(result.failure.message).toContain("Action:");
        }
      }
      if (Result.isFailure(worker)) expect(worker.failure._tag).toBe("WorkerBundleFailure");
      if (Result.isFailure(operator)) expect(operator.failure._tag).toBe("HostError");
      if (Result.isFailure(deployment)) expect(deployment.failure._tag).toBe("DeploymentError");
    }),
);
