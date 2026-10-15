import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, FileSystem, Schema } from "effect";
import { expect } from "vitest";

import { renderUnits } from "../src/index.ts";
import { probeUnitLimits } from "../src/instance-probe-stack.ts";
import {
  instanceLayout,
  fixtureProps,
  nodeUnit,
  sliceUnit,
  storeUnit,
  storageRetentionTimer,
  storageRetentionUnit,
} from "./fixture.ts";
import { localExec } from "../src/local-exec.ts";
import type { ServiceLimits } from "../src/service-units.ts";
import { renderUnit, unitPath } from "../src/systemd.ts";

const host = {
  dataRoot: "/srv/example/mailbox",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

it.prop(
  "pure rendering preserves all five default unit byte strings, including gated and customized units",
  {
    cpu: Arbitrary.schema(Schema.Literals(["50%", "100%", "300%"])),
    gate: Arbitrary.schema(Schema.Boolean),
    memory: Arbitrary.schema(Schema.Literals(["512M", "1.5G", "4G"])),
    volume: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum: 256, minimum: 1 }))),
  },
  ({ cpu, gate, memory, volume }) => {
    const layout = instanceLayout(host, {});

    const restartGate = gate
      ? { address: host.tailnetIPv4, path: `${layout.bin}/restart-gate.mjs` }
      : undefined;

    const limits = {
      cpuQuota: cpu,
      memoryMax: memory,
      oomPolicy: "continue",
    } satisfies ServiceLimits;

    const legacy = [
      sliceUnit(host.home, memory, cpu, { memoryHigh: memory }),
      nodeUnit({
        ...limits,
        binary: `${layout.bin}/celld`,
        data: `${host.dataRoot}/celld`,
        environment: `${layout.configuration}/celld.env`,
        host,
        restartGate,
        restartOn: [],
        storageDiagnostic: `${layout.bin}/storage-maintenance.py`,
      }),
      storeUnit({
        ...limits,
        binary: `${layout.bin}/weed`,
        config: `${layout.configuration}/s3.json`,
        data: `${host.dataRoot}/seaweedfs`,
        home: host.home,
        restartGate,
        restartOn: [],
        volumeMax: volume,
      }),
      storageRetentionUnit(host.home, `${layout.bin}/storage-maintenance.py`, []),
      storageRetentionTimer(host.home, []),
    ].map((unit) => ({ path: unitPath(unit), text: renderUnit(unit) }));

    expect(
      renderUnits(host, fixtureProps, {
        celld: { ...limits, restartGate: gate },
        seaweed: { ...limits, restartGate: gate, volumeMax: volume },
        slice: { cpuQuota: cpu, memoryHigh: memory, memoryMax: memory },
      }),
    ).toEqual(legacy);
    expect(renderUnits(host, fixtureProps)).toHaveLength(5);
  },
);

it.effect(
  "render-units launcher is offline and needs no state directory, baseline or approval",
  () =>
    Effect.gen(function* launcher() {
      const fs = yield* FileSystem.FileSystem;

      const temporary = yield* fs.makeTempDirectoryScoped({
        prefix: "instance-unit-render",
      });

      const inventory = `${temporary}/instance.json`;
      const ssh = `${temporary}/ssh`;
      const marker = `${temporary}/ssh-called`;

      yield* fs.writeFileString(
        inventory,
        JSON.stringify({
          domains: ["example.invalid"],
          hosts: ["example"],
          ips: ["203.0.113.10"],
          nodes: { example: host },
          secretNames: ["example_credential"],
          sites: ["example"],
        }),
        { mode: 0o600 },
      );
      yield* fs.writeFileString(ssh, `#!/bin/sh\nprintf 'called' > '${marker}'\nexit 1\n`, {
        mode: 0o755,
      });

      const executor = yield* localExec;

      const result = yield* executor.exec([
        "env",
        "-u",
        "FLEET_STATE_DIR",
        "-u",
        "FLEET_START_APPROVED",
        "-u",
        "FLEET_DESTROY_APPROVED",
        "ALCHEMY_TELEMETRY_DISABLED=1",
        `PATH=${temporary}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        `FLEET_INVENTORY=${inventory}`,
        "FLEET_LIVE_NODE=example",
        "FLEET_PROBE_DATA_ROOT=/srv/example/mischiefrb",
        process.execPath,
        new URL("live/instance-probe.ts", import.meta.url).pathname,
        "render-units",
      ]);

      const Units = Schema.Array(Schema.Struct({ path: Schema.String, text: Schema.String }));

      const units = yield* Schema.decodeEffect(Schema.fromJsonString(Units))(result.stdout);

      expect(result.code).toBe(0);
      expect(units).toEqual(
        renderUnits(
          { ...host, tailnetIPv4: "127.0.0.1" },
          {
            dataRoot: "/srv/example/mischiefrb",
            instance: "mischiefrb",
            portBase: 28_010,
            restartGate: true,
          },
          probeUnitLimits,
        ),
      );
      expect(yield* fs.exists(marker)).toBe(false);
      expect((yield* fs.readDirectory(temporary)).toSorted()).toEqual(["instance.json", "ssh"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
