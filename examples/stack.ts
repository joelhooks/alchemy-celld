import { Stack, localState } from "alchemy";
import { Config, Effect, Layer } from "effect";

import {
  Celld,
  Host,
  hostLayer as inventoryLayer,
  ObjectStore,
  sourceLayer,
  sshLayer,
  startupContractLayer as startupLayer,
  validateInstance,
} from "alchemy-celld";
import { settings } from "./config.ts";

const host = inventoryLayer.pipe(Layer.orDie);

const connection = Effect.gen(function* connection() {
  const inventory = yield* Host;
  const node = yield* inventory.node(yield* Config.String("FLEET_LIVE_NODE"));
  const props = yield* settings;
  const layout = yield* validateInstance(node, props);

  return { layout, node, props };
});

const shell = Layer.unwrap(
  connection.pipe(Effect.map(({ node, props }) => sshLayer(node, props))),
).pipe(Layer.provideMerge(host), Layer.orDie);

const startup = Layer.unwrap(
  connection.pipe(Effect.map(({ node, layout }) => startupLayer(node.tailnetIPv4, layout))),
).pipe(Layer.provide(host), Layer.provide(shell), Layer.orDie);

export const exampleStack = Stack(
  "celld-example",
  {
    providers: Layer.mergeAll(ObjectStore.providers(), Celld.providers()).pipe(
      Layer.provide(startup),
      Layer.provide(shell),
      Layer.provide(sourceLayer.pipe(Layer.orDie)),
    ),
    state: localState(),
  },
  Effect.gen(function* program() {
    const { node, props } = yield* connection;
    const slice = yield* ObjectStore.Slice({ home: node.home, instance: props.instance });

    const bucket = yield* ObjectStore.Bucket("store", {
      ...props,
      host: node,
      name: yield* Config.String("FLEET_BUCKET"),
      purgeOnDelete: false,
      slice: slice.sha256,
    });

    const cells = yield* Celld.Node("celld", {
      ...props,
      bucket,
      host: node,
      purgeOnDelete: false,
    });

    return {
      bucket: bucket.resource.name,
      internalUrl: cells.internalUrl,
      publicUrl: cells.publicUrl,
      unit: cells.unit.sha256,
      version: cells.version,
    };
  }).pipe(Effect.provide(host), Effect.orDie),
);
