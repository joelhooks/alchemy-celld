// @effect-diagnostics nodeBuiltinImport:off -- The CLI regression checks run the restart helper without contacting a host.
import { spawnSync } from "node:child_process";

import { it } from "@effect/vitest";
import {
  declaredListeners,
  InstancePortsSchema,
  renderUnits,
  validateInstance,
} from "alchemy-celld";
import type { InstancePorts } from "alchemy-celld";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

const host = {
  dataRoot: "/srv/example/cells",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};
const props = {
  instance: "example",
  portBase: 33_000,
  restartGate: true,
  maintenanceGuard: { refuses: [] as const },
};
// Fictional, deliberately non-uniform ports. No deployment topology belongs here.
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

it.effect("an explicit complete map replaces all ten derived ports without merging", () =>
  Effect.gen(function* explicitMap() {
    const layout = yield* validateInstance(host, { ...props, ports });
    expect(layout.ports).toBe(ports);
    expect(layout.portBase).toBe(props.portBase);
    expect(
      declaredListeners(host.tailnetIPv4, true, layout)
        .map(({ port }) => port)
        .sort(),
    ).toEqual(Object.values(ports).sort());

    const units = renderUnits(host, { ...props, ports });
    const node = units.find(({ path }) => path.endsWith("-celld.service"))?.text;
    const store = units.find(({ path }) => path.endsWith("-seaweedfs.service"))?.text;
    expect(node).toContain(`--listen ${host.tailnetIPv4}:${ports.public}`);
    expect(node).toContain(`--internal-listen 127.0.0.1:${ports.internal}`);
    for (const [flag, port] of [
      ["filer.port", ports.filer],
      ["filer.port.grpc", ports.filerGrpc],
      ["master.port", ports.master],
      ["master.port.grpc", ports.masterGrpc],
      ["s3.port", ports.s3],
      ["s3.port.grpc", ports.s3Grpc],
      ["volume.port", ports.volume],
      ["volume.port.grpc", ports.volumeGrpc],
    ] as const) {
      expect(store).toContain(`-${flag}=${port}`);
    }
    const maintenance = units.find(({ path }) => path.endsWith("-storage-retention.service"))?.text;
    expect(maintenance).toContain(`--master http://127.0.0.1:${ports.master}`);
    expect(maintenance).toContain(`--filer http://127.0.0.1:${ports.filer}`);

    const gates = units
      .flatMap(({ text }) => text.split("\n"))
      .filter((line) => line.includes("/restart-gate.mjs"));
    expect(gates).toHaveLength(3);
    for (const line of gates) {
      // Decode the systemd-quoted JSON argument, then the complete map it carries.
      const argument = line.slice(line.lastIndexOf(' "{') + 1);
      expect(JSON.parse(JSON.parse(argument))).toEqual({ ports });
    }
  }),
);

it.effect("omitting the override preserves the uniform block and every rendered byte", () =>
  Effect.gen(function* uniformMap() {
    const layout = yield* validateInstance(host, props);
    expect(layout.ports).toEqual({
      public: 33_000,
      internal: 33_001,
      filer: 33_002,
      filerGrpc: 33_003,
      master: 33_004,
      masterGrpc: 33_005,
      s3: 33_006,
      s3Grpc: 33_007,
      volume: 33_008,
      volumeGrpc: 33_009,
    });
    expect(renderUnits(host, { ...props, ports: layout.ports })).toEqual(renderUnits(host, props));
    expect(renderUnits(host, props).some(({ text }) => text.includes(' "{'))).toBe(false);
  }),
);

it.effect("partial, malformed, extra-key and out-of-range maps fail instead of falling back", () =>
  Effect.gen(function* invalidMaps() {
    const partials = Object.keys(ports).map((missing) =>
      Object.fromEntries(Object.entries(ports).filter(([name]) => name !== missing)),
    );
    const invalid: readonly unknown[] = [
      ...partials,
      null,
      {},
      { ...ports, public: 0 },
      { ...ports, public: -1 },
      { ...ports, public: 65_536 },
      { ...ports, public: 41_011.5 },
      { ...ports, public: "41011" },
      { ...ports, public: Number.NaN },
      { ...ports, public: Number.POSITIVE_INFINITY },
      { ...ports, surprise: 42_000 },
    ];
    for (const input of invalid) {
      // @ts-expect-error Deliberately simulate an untyped consumer crossing the runtime boundary.
      const malformed: InstancePorts = input;
      const result = yield* Effect.isFailure(
        validateInstance(host, { ...props, ports: malformed }),
      );
      expect(result).toBe(true);
      expect(() => renderUnits(host, { ...props, ports: malformed })).toThrow();
    }
    const boundary = yield* Schema.decodeUnknownEffect(InstancePortsSchema)({
      ...ports,
      public: 1,
      internal: 65_535,
    });
    expect(boundary.public).toBe(1);
    expect(boundary.internal).toBe(65_535);
  }),
);

it("restart-gate rejects partial JSON before any shell command", () => {
  const result = spawnSync(
    process.execPath,
    [
      new URL("../src/instance-restart-gate.ts", import.meta.url).pathname,
      host.tailnetIPv4,
      "node",
      props.instance,
      String(props.portBase),
      host.dataRoot,
      JSON.stringify({ ports: { public: ports.public } }),
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("Invalid restart-gate context.");
});
