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
          field: "FLEET_INVENTORY",
          expectedShape: "A readable regular JSON file with mode 0600",
          action:
            "Correct the private inventory file type and mode without logging its path or contents.",
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
            field: "FLEET_INVENTORY",
            expectedShape:
              "A mode-0600 regular JSON file matching Instance, with nonempty domains/hosts/ips/secretNames/sites and valid optional nodes",
            action:
              "Check file permissions and private inventory schema locally; do not log inventory values.",
          }),
      ),
    );

    return Host.of({
      node: Effect.fn("HostInventory.Host.node")(function* operation(alias) {
        const node = inventory.nodes?.[alias];

        if (node === undefined) {
          return yield* new InventoryError({
            reason: "Requested node is absent from private inventory.",
            field: "nodes[alias]",
            expectedShape: "An existing node entry for the requested alias; alias value redacted",
            action: "Select an existing inventory alias or add its complete private node entry.",
          });
        }

        return node;
      }),
    });
  }),
);

export const HostInventory = { Host, layer };
