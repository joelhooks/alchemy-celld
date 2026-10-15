import { Config, Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

import { InventoryError } from "./inventory-error.ts";
import { Instance } from "./inventory-schema.ts";
import type { Node } from "./inventory-schema.ts";

export { InventoryError } from "./inventory-error.ts";

export class Host extends Context.Service<
  Host,
  {
    readonly node: (alias: string) => Effect.Effect<Node, InventoryError>;
  }
>()("@alchemy-celld/HostInventory.Host") {}

export const layer = Layer.effect(
  Host,
  Effect.gen(function* layer() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const location = yield* Config.String("FLEET_INVENTORY").pipe(
      Config.map((selected) => path.resolve(selected)),
    );

    const inventory = yield* Effect.gen(function* inventory() {
      const stat = yield* fs.stat(location);

      if (stat.type !== "File" || stat.mode % 0o1000 !== 0o600) {
        return yield* new InventoryError({
          reason: "Private inventory must be a regular file with mode 600.",
        });
      }

      return yield* Schema.decodeEffect(Schema.fromJsonString(Instance), {
        onExcessProperty: "error",
      })(yield* fs.readFileString(location));
    }).pipe(
      Effect.mapError(
        () =>
          new InventoryError({
            reason: "Private inventory is unreadable or malformed; values redacted.",
          }),
      ),
    );

    return Host.of({
      node: Effect.fn("HostInventory.Host.node")(function* operation(alias) {
        const node = inventory.nodes?.[alias];

        if (node === undefined) {
          return yield* new InventoryError({
            reason: "Requested node is absent from private inventory.",
          });
        }

        return node;
      }),
    });
  }),
);

export const HostInventory = { Host, layer };
