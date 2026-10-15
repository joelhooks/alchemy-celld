import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema, Exit } from "effect";
import { expect } from "vitest";

import { makeFakeShell } from "../src/fake-shell.ts";
import { instanceGoneScript } from "../src/instance-probe-scripts.ts";
import { localExec } from "../src/local-exec.ts";
import { probeTeardown, verifyInstanceGone } from "../src/probe-receipts.ts";
import { goneFixture } from "./instance-teardown-model.ts";

const leftovers = [
  "commands",
  "directory",
  "inactive",
  "link",
  "listener",
  "listingError",
  "listingOneOutput",
  "loaded",
  "otherExitOne",
  "pid",
  "slice",
  "socket",
  "units",
] as const;

it.effect.prop(
  "verify-gone fails for every modeled leftover or mailbox regression and succeeds only for a clean world",
  {
    scenario: Arbitrary.schema(Schema.Literals(["clean", "dirty", ...leftovers])),
  },
  ({ scenario }) =>
    Effect.gen(function* probeModel() {
      const modeled = Object.fromEntries(
        leftovers.map((key) => [
          key,
          key === scenario ||
            (scenario === "dirty" && ["units", "slice", "directory"].includes(key)),
        ]),
      );

      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        goneFixture,
        JSON.stringify(modeled),
        instanceGoneScript,
      ]);

      expect(result.code === 0).toBe(scenario === "clean");

      const fake = yield* makeFakeShell();

      const code = yield* verifyInstanceGone(
        { ...fake.shell, exec: () => Effect.succeed(result) },
        "/home/example",
        "/srv/example/mischiefrb",
        {},
      );

      const exits: number[] = [];
      probeTeardown(Exit.succeed(code), (status) => {
        exits.push(status);
      });
      expect(exits).toEqual([scenario === "clean" ? 0 : 1]);

      if (scenario === "dirty") {
        for (const label of [
          "FAIL instance units absent",
          "FAIL configuration and staging absent",
          "FAIL binary root absent",
          "FAIL data root absent",
        ]) {
          expect(result.stdout).toContain(label);
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
