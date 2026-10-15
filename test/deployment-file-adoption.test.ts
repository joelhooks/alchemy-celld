// @effect-diagnostics anyUnknownInErrorContext:off -- Alchemy provider.read declares any errors; the immediate mapper narrows to HostError.
import { it } from "@effect/vitest";
import { Stack } from "alchemy/Stack";
import { inMemoryState } from "alchemy/State/InMemoryState";
import { Effect, Layer, Result, Schema } from "effect";
import { expect } from "vitest";

import { makeFakeShell } from "../src/fake-shell.ts";
import { reconcileFile } from "../src/files.ts";
import { HostShell, HostError } from "../src/host-shell.ts";
import { RemoteFile, RemoteFileProvider } from "../src/providers.ts";

it.effect.prop(
  "interrupted staging may take over only an exact prior Deployment-owned file; drift, wrong role/path/mode and redirected ownership refuse",
  [Schema.Literals(["none", "content", "mode", "path", "owner", "parent", "role"]), Schema.Boolean],
  ([fault, configuration]) =>
    Effect.gen(function* migration() {
      const fake = yield* makeFakeShell();
      const directory = "/home/example/.config/celld/mailbox-deployment";
      yield* fake.shell.mkdir({
        mode: fault === "parent" ? 0o755 : 0o700,
        path: directory,
      });
      const filename = configuration ? "wrangler.json" : "worker.mjs";

      const previous = configuration ? "prior config" : "prior worker";

      const role = configuration ? "mailbox-stage-configuration" : "mailbox-stage-worker";

      const path = `${directory}/${fault === "path" ? "foreign.invalid.mjs" : filename}`;
      yield* fake.shell.write({
        bytes: new TextEncoder().encode(fault === "content" ? "foreign bytes" : previous),
        mode: fault === "mode" ? 0o644 : 0o600,
        path,
      });
      const original = fault === "content" ? "foreign bytes" : previous;

      const provider = yield* RemoteFile.Provider.pipe(
        Effect.provide(
          RemoteFileProvider().pipe(Layer.provide(Layer.succeed(HostShell, fake.shell))),
        ),
      );

      if (provider.read === undefined) {
        throw new Error("File read port missing");
      }

      const owner = {
        attr: {
          bundle: "prior worker",
          configuration: "prior config",
          directory,
        },
        bindings: [],
        downstream: [],
        fqn: "mailbox",
        instanceId: "fixture.invalid",
        logicalId: "mailbox",
        namespace: undefined,
        props: {},
        providerVersion: 0,
        resourceType: fault === "owner" ? "Foreign.invalid" : "Celld.Deployment",
        status: "updated" as const,
      };

      const props = { content: "new worker", mode: 0o600, path };

      const result = yield* provider
        .read({
          fqn: fault === "role" ? "foreign.invalid" : role,
          id: "mailbox-stage-worker",
          instanceId: "fixture.invalid",
          olds: props,
          output: undefined,
        })
        .pipe(
          Effect.mapError(() => new HostError({ operation: "test", reason: "Adoption refused" })),
          Effect.provide(inMemoryState({ "fixture.invalid": { fleet: { mailbox: owner } } })),
          Effect.provideService(
            Stack,
            Stack.of({
              actions: {},
              bindings: {},
              name: "fixture.invalid",
              resources: {},
              stage: "fleet",
            }),
          ),
          Effect.result,
        );

      expect(Result.isSuccess(result)).toBe(fault === "none");

      if (Result.isSuccess(result)) {
        yield* reconcileFile(fake.shell, props, result.success, false);
      }

      expect(new TextDecoder().decode(yield* fake.shell.read(path))).toBe(
        fault === "none" ? "new worker" : original,
      );
    }),
);
