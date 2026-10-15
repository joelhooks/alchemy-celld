import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { expect } from "vitest";

import { operatorBundle } from "../src/operator-build.ts";

it.live.prop(
  "operator bytes do not depend on the candidate clone root",
  [Schema.String.check(Schema.isMaxLength(40))],
  ([value]) =>
    Effect.scoped(
      Effect.gen(function* invariant() {
        const fs = yield* FileSystem.FileSystem;

        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "bundle.invalid-",
        });

        const entries = yield* Effect.forEach(["one", "two"], (folder) =>
          Effect.gen(function* source() {
            const path = `${directory}/${folder}`;
            yield* fs.makeDirectory(path);
            yield* fs.writeFileString(
              `${path}/entry.ts`,
              `export const value = ${JSON.stringify(value)};`,
            );

            return `${path}/entry.ts`;
          }),
        );

        const bundles: string[] = [];

        for (const entry of entries) {
          bundles.push(yield* operatorBundle(entry));
        }

        expect(bundles[0]).toBe(bundles[1]);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
  { arbitrary: { runs: 12 } },
);
