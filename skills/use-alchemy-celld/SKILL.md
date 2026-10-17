---
name: use-alchemy-celld
description: Declare celld and its object store in a consumer Alchemy stack. Use when installing the provider, wiring host inventory or providers, composing resources, or reviewing a consumer plan.
---

# Use alchemy-celld

Read `AGENTS.md` and `README.facts.md` first. Supply compatible Alchemy and Effect peers from the consumer. Installed packages need a TypeScript-aware loader or bundler. Workspace-linked Node proof does not establish plain Node support inside node_modules.

## One resource program

This example is the program passed to a Stack, not an executable deployment command. The consumer supplies `Host` from private inventory. All resource names and values below are invented.

```ts
import { Effect } from "effect";
import { Celld, Host, ObjectStore } from "alchemy-celld";

export const resources = Effect.gen(function* resources() {
  const inventory = yield* Host;
  const host = yield* inventory.node("example");
  const props = {
    instance: "example",
    portBase: 33000,
    restartGate: true,
    maintenanceGuard: { refuses: [] as const },
  };
  const slice = yield* ObjectStore.Slice({
    home: host.home,
    instance: props.instance,
    memoryMax: "3G",
  });
  const bucket = yield* ObjectStore.Bucket("store", {
    ...props,
    host,
    name: "example-cells",
    purgeOnDelete: false,
    slice: slice.sha256,
  });
  const cell = yield* Celld.Node("cell", {
    ...props,
    host,
    bucket,
    purgeOnDelete: false,
  });
  return { publicUrl: cell.publicUrl, internalUrl: cell.internalUrl };
});
```

`maintenanceGuard: { refuses: [] }` explicitly declares no protected maintenance ports. A real consumer must choose its protection policy; omission is not a default. `portBase` derives ten listener ports. A custom `ports` map must provide all ten fields; partial maps fail. Do not put real host facts in this program.

## Supply the stack services

Use `examples/stack.ts` as the complete composition reference:

1. Load mode-0600 private inventory with `hostLayer`. Select a node and validate its instance layout.
2. Build `sshLayer(node, props)` with that same layout input. Provide Node platform services at the runtime boundary.
3. Build `startupContractLayer(node.tailnetIPv4, layout)` with the inventory and shell. This supplies startup checks; rendering alone does not.
4. Merge `ObjectStore.providers()` and `Celld.providers()`. Supply the shell, startup layer, and pinned release `sourceLayer`.
5. Pass those providers, consumer-owned state, and the resource program to Alchemy `Stack`. Supply `Host` to the program. Keep state outside the public repository.

The example CLI also requires the environment names listed in `AGENTS.md`. Review a plan before an approved deploy. Stop on replacement or unexpected deletion. Keep resource identities stable; changing a name is not a harmless refactor.

Check the consumer program with its own typecheck, then run this repo's `pnpm check` and `pnpm test` for provider changes. Use approved real probes for live claims. Do not infer healthy storage or worker identity from a successful plan.
