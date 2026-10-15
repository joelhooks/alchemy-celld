import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { expect } from "vitest";

import { makeFakeShell } from "../src/fake-shell.ts";
import { HostError, HostShell } from "../src/host-shell.ts";
import { NodeProvider, NodeResource } from "../src/node-provider.ts";
import type { NodeProps } from "../src/node-provider.ts";
import { nodeUnit } from "./fixture.ts";
import { reconcileUnit, withoutLegacyHelperInputs } from "../src/systemd.ts";

it.effect.prop(
  "staged bundle/helper readiness changes do not classify an unchanged process as restarting",
  [
    Schema.Struct({
      changed: Schema.Boolean,
      legacy: Schema.Boolean,
      seed: Schema.Int,
    }),
  ],
  ([sample]) =>
    Effect.gen(function* classification() {
      const fake = yield* makeFakeShell();

      const props: NodeProps = {
        ...nodeUnit({
          binary: "/opt/example/celld",
          data: "/srv/example/cells",
          environment: "/opt/example/celld.env",
          host: {
            dataRoot: "/srv/example",
            home: "/home/example",
            ssh: "fixture.invalid",
            tailnetIPv4: "203.0.113.10",
          },
          restartOn: ["environment.invalid", "binary.invalid"],
        }),
        internalUrl: "http://127.0.0.1:31001",
        publicUrl: "http://fixture.invalid:31000",
        version: "v0.6.1",
      };

      const olds: NodeProps = sample.legacy
        ? {
            ...props,
            restartOn: [...(props.restartOn ?? []), "gate.invalid", "diagnostic.invalid"],
          }
        : props;

      const news: NodeProps = {
        ...props,
        prepared: [String(sample.seed)],
        restartOn: [sample.changed ? "changed.invalid" : "environment.invalid", "binary.invalid"],
      };

      const unit = yield* reconcileUnit(fake.shell, olds, undefined, false);

      const output = {
        ...unit,
        internalUrl: props.internalUrl,
        publicUrl: props.publicUrl,
        version: props.version,
      };

      const provider = yield* NodeResource.Provider.pipe(
        Effect.provide(NodeProvider().pipe(Layer.provide(Layer.succeed(HostShell, fake.shell)))),
      );

      if (provider.diff === undefined) {
        throw new Error("Node diff port missing");
      }

      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Alchemy provider.diff declares any; the immediate adapter maps it to HostError.
      const result = yield* provider
        .diff({
          fqn: "node.invalid",
          id: "node.invalid",
          instanceId: "fixture.invalid",
          newBindings: [],
          news,
          oldBindings: [],
          olds,
          output,
        })
        .pipe(
          Effect.mapError(() => new HostError({ operation: "test", reason: "Node diff failed" })),
        );

      expect(result?.action).toBe(sample.changed ? "update" : "noop");
      const before = (yield* fake.calls()).length;
      yield* reconcileUnit(
        fake.shell,
        news,
        withoutLegacyHelperInputs(olds, news, output, true),
        false,
      );
      expect(
        (yield* fake.calls()).slice(before).some((call) => call.argv.includes("restart")),
      ).toBe(sample.changed);
    }),
);
