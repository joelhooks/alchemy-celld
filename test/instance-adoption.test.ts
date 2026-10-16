// @effect-diagnostics nodeBuiltinImport:off -- Executable boundary test refuses the fake bucket before it can run any shell command.
import { spawnSync } from "node:child_process";

import { NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Celld,
  InstanceNameSchema,
  InstanceAdoptionSchema,
  ObjectStore,
  RestartGateCommandsSchema,
  renderUnits,
  validateInstance,
} from "alchemy-celld";
import type { InstanceAdoption, InstancePorts, RestartGateCommands } from "alchemy-celld";
import * as Test from "alchemy/Test/Vitest";
import { Effect, Layer, Schema } from "effect";
import { expect } from "vitest";

import { checkedStack } from "./checked-stack.ts";
import { Rendered, renderProviders } from "./instance-render.ts";

const host = {
  dataRoot: "/srv/example/cells",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};
const props = {
  instance: "example-old",
  portBase: 33_000,
  restartGate: true,
  maintenanceGuard: { refuses: [] as const },
};
const adopt: InstanceAdoption = { name: props.instance, acceptsNestedSlice: true };
const pinnedBundle =
  '// Fictional consumer-supplied gate implementation.\nexport const example = "preserve bytes";\n';
const commands: RestartGateCommands = {
  beforeNode: '/usr/local/bin/node "/srv/example/gate.mjs" before',
  node: '/usr/local/bin/node "/srv/example/gate.mjs" node',
  store: '/usr/local/bin/node "/srv/example/gate.mjs" store',
};

it.effect(
  "existing hyphenated names require separate explicit adoption without relaxing new names",
  () =>
    Effect.gen(function* adoptedName() {
      expect(Schema.is(InstanceNameSchema)(props.instance)).toBe(false);
      expect(yield* Effect.isFailure(validateInstance(host, props))).toBe(true);
      const layout = yield* validateInstance(host, { ...props, adopt });
      expect(layout.instance).toBe(adopt.name);
      expect(layout.slice).toBe("example-old.slice");
      expect(layout.adopt).toEqual(adopt);
      expect(Schema.is(InstanceAdoptionSchema)(adopt)).toBe(true);
      const gates = renderUnits(host, { ...props, adopt })
        .flatMap(({ text }) => text.split("\n"))
        .filter((line) => line.includes("/restart-gate.mjs"));
      expect(gates).toHaveLength(3);
      for (const line of gates) {
        expect(JSON.parse(JSON.parse(line.slice(line.lastIndexOf(' "{') + 1)))).toEqual({ adopt });
      }
    }),
);

it.effect(
  "adoption rejects missing/false acknowledgement, unsafe names and mismatched identity",
  () =>
    Effect.gen(function* invalidAdoption() {
      const invalid: readonly unknown[] = [
        { name: props.instance },
        { name: props.instance, acceptsNestedSlice: false },
        { name: "other-old", acceptsNestedSlice: true },
        ...[
          "../example",
          "example/old",
          "Example-old",
          "-example",
          "example-",
          "example--old",
          "example\nold",
          "a".repeat(17),
        ].map((name) => ({ name, acceptsNestedSlice: true })),
        { ...adopt, extra: true },
        null,
      ];
      for (const input of invalid) {
        // @ts-expect-error Deliberately exercise untyped adoption inputs at the validation boundary.
        expect(yield* Effect.isFailure(validateInstance(host, { ...props, adopt: input }))).toBe(
          true,
        );
      }
    }),
);

it.effect("custom commands render byte-for-byte only as a complete validated set", () =>
  Effect.gen(function* customCommands() {
    const selected = { ...props, adopt, restartGateCommands: commands };
    yield* validateInstance(host, selected);
    expect(Schema.is(RestartGateCommandsSchema)(commands)).toBe(true);
    const units = renderUnits(host, selected);
    const node = units.find(({ path }) => path.endsWith("-celld.service"))?.text;
    const store = units.find(({ path }) => path.endsWith("-seaweedfs.service"))?.text;
    expect(node).toContain(`ExecStartPre=${commands.beforeNode}\n`);
    expect(node).toContain(`ExecStartPost=${commands.node}\n`);
    expect(store).toContain(`ExecStartPost=${commands.store}\n`);
    expect(node).not.toContain("restart-gate.mjs");
    expect(store).not.toContain("restart-gate.mjs");
    expect(() => renderUnits(host, selected, { celld: { restartGate: false } })).toThrow();
    expect(() => renderUnits(host, selected, { seaweed: { restartGate: false } })).toThrow();
    const invalid: readonly unknown[] = [
      {},
      { node: commands.node },
      { ...commands, node: "" },
      { ...commands, node: "  " },
      { ...commands, node: "true\nUser=root" },
      { ...commands, node: "true\rUser=root" },
      { ...commands, node: "true\0ignored" },
      { ...commands, extra: "true" },
      null,
    ];
    for (const input of invalid) {
      // @ts-expect-error Deliberately simulate malformed untyped command input.
      const malformed: RestartGateCommands = input;
      expect(
        yield* Effect.isFailure(
          validateInstance(host, { ...props, adopt, restartGateCommands: malformed }),
        ),
      ).toBe(true);
      expect(() =>
        renderUnits(host, { ...props, adopt, restartGateCommands: malformed }),
      ).toThrow();
    }
    expect(
      yield* Effect.isFailure(validateInstance(host, { ...selected, restartGate: false })),
    ).toBe(true);
  }),
);

it("the default restart helper accepts adoption context before refusing a deliberately invalid bucket", () => {
  const result = spawnSync(
    process.execPath,
    [
      new URL("../src/instance-restart-gate.ts", import.meta.url).pathname,
      host.tailnetIPv4,
      "before-node",
      props.instance,
      String(props.portBase),
      host.dataRoot,
      JSON.stringify({ adopt }),
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, HOME: host.home, CELLD_BUCKET: "deliberately-not-a-bucket" },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("Storage bucket is not configured");
  expect(result.stdout + result.stderr).not.toContain("Invalid instance name");
});

const { test } = Test.make({
  providers: renderProviders.pipe(Layer.provide(NodePath.layer)),
  stage: "adoption-tests",
});

test.provider(
  "adoption and custom commands propagate through Slice, Bucket and Celld without live providers",
  (scratch) =>
    Effect.gen(function* providerSeams() {
      yield* checkedStack(scratch).deploy(
        Effect.gen(function* stack() {
          const ports: InstancePorts = {
            public: 41_011,
            internal: 42_022,
            filer: 43_033,
            filerGrpc: 44_044,
            master: 45_055,
            masterGrpc: 46_066,
            s3: 47_077,
            s3Grpc: 48_088,
            volume: 49_099,
            volumeGrpc: 50_110,
          };
          const selected = { ...props, ports, adopt, restartGateCommands: commands };
          const slice = yield* ObjectStore.Slice({
            home: host.home,
            instance: props.instance,
            adopt,
          });
          for (const input of ["", "  ", 17, null] as readonly unknown[]) {
            // @ts-expect-error Deliberately simulate invalid artifacts from an untyped consumer.
            const invalidBundle: string = input;
            const invalid = yield* Effect.result(
              ObjectStore.Bucket("invalid-bundle", {
                ...selected,
                host,
                name: "example-cells",
                slice: slice.sha256,
                restartGateBundle: invalidBundle,
              }),
            );
            expect(invalid).toMatchObject({
              _tag: "Failure",
              failure: {
                reason: "A restart-gate bundle must be nonblank and requires restartGate: true.",
              },
            });
          }
          const disabled = yield* Effect.result(
            ObjectStore.Bucket("disabled-bundle", {
              maintenanceGuard: { refuses: [] },
              instance: "example",
              portBase: props.portBase,
              restartGate: false,
              host,
              name: "example-cells",
              slice: slice.sha256,
              restartGateBundle: pinnedBundle,
            }),
          );
          expect(disabled).toMatchObject({ _tag: "Failure" });
          const missingBundle = yield* Effect.result(
            ObjectStore.Bucket("incomplete", {
              ...selected,
              host,
              name: "example-cells",
              slice: slice.sha256,
            }),
          );
          expect(missingBundle).toMatchObject({
            _tag: "Failure",
            failure: {
              reason: "Custom restart-gate commands require an explicit restart-gate bundle.",
            },
          });
          const bucket = yield* ObjectStore.Bucket("store", {
            ...selected,
            host,
            name: "example-cells",
            slice: slice.sha256,
            restartGateBundle: pinnedBundle,
            volumeMax: 64,
            volumePreStopSeconds: 0,
          });
          const wrongPorts = yield* Effect.result(
            Celld.Node("wrong-ports", {
              ...selected,
              ports: { ...ports, public: 41_012 },
              host,
              bucket,
            }),
          );
          expect(wrongPorts).toMatchObject({
            _tag: "Failure",
            failure: { reason: "Node ports must match its bucket." },
          });
          const wrongCommands = yield* Effect.result(
            Celld.Node("wrong-commands", {
              ...selected,
              restartGateCommands: { ...commands, node: "different-command" },
              host,
              bucket,
            }),
          );
          expect(wrongCommands).toMatchObject({
            _tag: "Failure",
            failure: { reason: "Node restart-gate commands must match its bucket." },
          });
          const cells = yield* Celld.Node("node", { ...selected, host, bucket });
          expect(cells.layout.adopt).toEqual(adopt);
          return cells;
        }),
      );
      const rendered = yield* Rendered;
      expect(rendered.files.get(`${host.home}/.config/example-old/celld.env`)).toContain(
        'S3_ENDPOINT="http://127.0.0.1:47077"',
      );
      expect(
        rendered.files.get(`${host.home}/.config/systemd/user/example-old-celld.service`),
      ).toContain("--listen 203.0.113.10:41011 --internal-listen 127.0.0.1:42022");
      expect(
        rendered.files.get(`${host.home}/.config/systemd/user/example-old-celld.service`),
      ).toContain(`ExecStartPost=${commands.node}\n`);
      expect(
        rendered.files.get(`${host.home}/.config/systemd/user/example-old-seaweedfs.service`),
      ).toContain(`ExecStartPost=${commands.store}\n`);
      expect(
        rendered.files.get(`${host.home}/.config/systemd/user/example-old-seaweedfs.service`),
      ).toContain(" -volume.max=64 -volume.preStopSeconds=0");
      expect(rendered.files.get(`${host.home}/.local/share/example-old/bin/restart-gate.mjs`)).toBe(
        pinnedBundle,
      );
    }),
);
