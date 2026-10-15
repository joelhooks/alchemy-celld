import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, ConfigProvider, Effect, FileSystem, Layer, Schema } from "effect";
import { expect } from "vitest";

import { Host, layer as inventoryLayer } from "../src/host.ts";
import { instanceNodeUnit, instanceStoreUnit } from "../src/instance-units.ts";
import { InstanceNameSchema, validateInstance } from "../src/instance.ts";
import { renderUnit } from "../src/systemd.ts";

const host = {
  dataRoot: "/srv/example/cells",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

it.effect.prop(
  "instance identity never chooses restart gating; explicit choice and overrides control both units",
  {
    instance: Arbitrary.schema(InstanceNameSchema),
    portBase: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 65_526, minimum: 1024 })),
    ),
    restartGate: Arbitrary.schema(Schema.Boolean),
  },
  ({ instance, restartGate, portBase }) =>
    Effect.gen(function* gateChoice() {
      const layout = yield* validateInstance(host, { instance, portBase, restartGate });
      const peer = yield* validateInstance(host, { instance: "celld", portBase, restartGate });

      for (const selected of [layout, peer]) {
        for (const render of [instanceNodeUnit, instanceStoreUnit]) {
          expect(renderUnit(render(host, selected)).includes("ExecStartPost=")).toBe(restartGate);
          expect(
            renderUnit(render(host, selected, { restartGate: !restartGate })).includes(
              "ExecStartPost=",
            ),
          ).toBe(!restartGate);
        }
      }
    }),
);

it.effect.prop(
  "host inventory reads injected host facts from an explicitly selected private file",
  {
    dataRoot: Arbitrary.schema(Schema.Literals(["/srv/example/cells", "/opt/example/data"])),
    home: Arbitrary.schema(Schema.Literals(["/home/example", "/srv/example/user"])),
    ssh: Arbitrary.schema(Schema.Literals(["example", "user@example.invalid"])),
    tailnetIPv4: Arbitrary.schema(Schema.Literals(["203.0.113.10", "192.0.2.20"])),
  },
  (node) =>
    Effect.gen(function* injectedInventory() {
      const fs = yield* FileSystem.FileSystem;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "celld-inventory-" });
      const path = `${temporary}/inventory.json`;
      yield* fs.writeFileString(
        path,
        JSON.stringify({
          domains: ["example.invalid"],
          hosts: ["example"],
          ips: [node.tailnetIPv4],
          nodes: { example: node },
          secretNames: ["example_credential"],
          sites: ["example"],
        }),
        { mode: 0o600 },
      );

      const loaded = yield* Effect.gen(function* readNode() {
        return yield* (yield* Host).node("example");
      }).pipe(
        Effect.provide(
          inventoryLayer.pipe(
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ FLEET_INVENTORY: path })),
            ),
          ),
        ),
      );

      expect(loaded).toEqual(node);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 8 } },
);
