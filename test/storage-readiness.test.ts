import { it } from "@effect/vitest";
import { Effect, Fiber, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { nodeUnit } from "./fixture.ts";
import { waitForStorage } from "../src/storage-readiness.ts";

it.effect.prop(
  "node starts only after authenticated bucket readiness, not a running service or open port",
  [
    Schema.Struct({
      pending: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 0 })),
      ready: Schema.Boolean,
    }),
  ],
  ([input]) =>
    Effect.gen(function* readiness() {
      let calls = 0;

      const child = yield* Effect.forkChild(
        waitForStorage(
          {
            exec: (argv) =>
              Effect.sync(() => {
                expect(argv.at(-1)).toBe("writable");
                calls += 1;

                return {
                  code: 0,
                  stdout: JSON.stringify({
                    status: input.ready && calls > input.pending ? 200 : 503,
                  }),
                };
              }),
          },
          {
            bucket: "fixture.invalid",
            endpoint: "http://127.0.0.1:8333",
            home: "/home/example",
          },
        ).pipe(Effect.result),
      );

      yield* TestClock.adjust("31 seconds");
      const result = yield* Fiber.join(child);
      expect(Result.isSuccess(result)).toBe(input.ready);

      if (input.ready) {
        expect(calls).toBe(input.pending + 1);
      } else {
        expect(calls).toBeLessThanOrEqual(120);
      }
    }),
);

it.effect.prop(
  "restart-gated declarations include storage readiness before node ExecStart",
  [Schema.Int.check(Schema.isBetween({ maximum: 255, minimum: 0 }))],
  ([octet]) =>
    Effect.sync(() => {
      const host = {
        dataRoot: "/data/example",
        home: "/home/example",
        ssh: "host.invalid",
        tailnetIPv4: `192.0.2.${octet}`,
      };

      const unit = nodeUnit({
        binary: "/opt/celld",
        data: "/data",
        environment: "/env",
        host,
        restartGate: { address: host.tailnetIPv4, path: "/gate" },
        restartOn: [],
      });

      expect(
        unit.sections
          .flatMap((section) => section.lines)
          .filter(([name]) => name === "ExecStartPre"),
      ).toEqual([["ExecStartPre", expect.stringContaining("before-node")]]);
    }),
);
