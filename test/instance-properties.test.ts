import { it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";
import { expect } from "vitest";

import {
  deploymentStageLayout,
  declaredListeners,
  assessListeners,
  InstanceNameSchema,
  instanceLayout,
  nodeUnit,
  sliceUnit,
  storeUnit,
  storageRetentionTimer,
  storageRetentionUnit,
} from "./fixture.ts";
import type { InstanceLayout } from "../src/instance.ts";
import { renderUnit, unitPath } from "../src/systemd.ts";

const host = {
  dataRoot: "/srv/example/mailbox",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

const cgroup = (name: string, slice: string) =>
  `/user.slice/example-user.slice/example-user.service/${slice}/${name}`;

const ancestors = (slice: string) =>
  slice
    .slice(0, -".slice".length)
    .split("-")
    .slice(0, -1)
    .map((_, index, parts) => `${parts.slice(0, index + 1).join("-")}.slice`);

const surface = (layout: InstanceLayout) => {
  const stage = deploymentStageLayout(host.home, layout);

  const units = [
    nodeUnit({
      binary: `${layout.bin}/celld`,
      data: `${layout.dataRoot}/celld`,
      environment: `${layout.configuration}/celld.env`,
      host,
      layout,
      restartOn: [],
      storageDiagnostic: `${layout.bin}/storage-maintenance.py`,
    }),
    storeUnit({
      binary: `${layout.bin}/weed`,
      config: `${layout.configuration}/s3.json`,
      data: `${layout.dataRoot}/seaweedfs`,
      home: host.home,
      layout,
      restartOn: [],
    }),
    sliceUnit(host.home, "3G", "100%", { instance: layout.instance }),
    storageRetentionUnit(host.home, `${layout.bin}/storage-maintenance.py`, [], layout),
    storageRetentionTimer(host.home, [], layout),
  ];

  const text = units.map(renderUnit).join("\n");

  return {
    names: [
      ...units.map(({ name }) => name),
      ...["directory", "worker", "configuration"].map((kind) => `${stage.idPrefix}-${kind}`),
    ],
    paths: [
      ...units.map(unitPath),
      layout.binaryRoot,
      layout.bin,
      layout.configuration,
      stage.directory,
      `${stage.directory}/worker.mjs`,
      `${stage.directory}/wrangler.json`,
      `${stage.directory}/wrangler.public.json`,
      layout.dataRoot,
      `${layout.dataRoot}/celld`,
      `${layout.dataRoot}/seaweedfs`,
      `${layout.bin}/celld`,
      `${layout.bin}/weed`,
      `${layout.bin}/restart-gate.mjs`,
      `${layout.bin}/storage-maintenance.py`,
      `${layout.configuration}/s3.json`,
      `${layout.configuration}/celld.env`,
      `/tmp/seaweedfs-s3-${layout.ports.s3}.sock`,
      `/tmp/seaweedfs-s3-grpc-${layout.ports.s3Grpc}.sock`,
    ],
    ports: [
      ...text.matchAll(
        /(?:--listen \S+:|--internal-listen \S+:|-\S*port(?:\.grpc)?=)(?<port>\d+)/gu,
      ),
    ].map((match) => Number(match.groups?.port)),
    slices: [...text.matchAll(/^Slice=(?<slice>.+)$/gmu)].map((match) => match.groups?.slice),
  };
};

it.prop(
  "distinct instances have disjoint rendered units, ports, paths, slices and data",
  {
    names: Arbitrary.schema(
      Schema.Tuple([
        Schema.Union([InstanceNameSchema, Schema.Literal("mailbox")]),
        InstanceNameSchema,
      ]),
    ).pipe(Arbitrary.filter(([a, b]) => a !== b && a !== "celld" && b !== "celld")),
    slot: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum: 150, minimum: 0 }))),
    withDefault: Arbitrary.schema(Schema.Boolean),
  },
  ({ names: [a, b], slot, withDefault }) => {
    const first = instanceLayout(host, {
      dataRoot: `/srv/example/named/${a}`,
      instance: a,
      portBase: 33_000 + slot * 100,
    });

    const second = withDefault
      ? instanceLayout(host, {})
      : instanceLayout(host, {
          dataRoot: `/srv/example/named/${b}`,
          instance: b,
          portBase: 50_000 + slot * 100,
        });

    const left = surface(first);
    const right = surface(second);
    expect(left.ports).toHaveLength(10);
    expect(right.ports).toHaveLength(10);

    for (const key of ["names", "paths", "ports", "slices"] as const) {
      const other = new Set<string | number | undefined>(right[key]);
      expect(left[key].filter((value) => other.has(value))).toEqual([]);
    }

    expect(first.dataRoot).not.toBe(second.dataRoot);
    expect(first.slice).not.toBe(second.slice);

    expect(ancestors(first.slice)).not.toContain(second.slice);
    expect(ancestors(second.slice)).not.toContain(first.slice);
    const defaults = instanceLayout(host, {});
    expect(ancestors(first.slice)).not.toContain(defaults.slice);
    expect(ancestors(defaults.slice)).not.toContain(first.slice);
  },
);

it.prop(
  "instance listener checks isolate neighbours and reject exposure on any of their ten ports",
  {
    instance: Arbitrary.schema(InstanceNameSchema).pipe(
      Arbitrary.filter((name) => name !== "celld"),
    ),
    port: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 0 }))),
  },
  ({ instance, port }) => {
    const layout = instanceLayout(host, {
      dataRoot: `/srv/example/${instance}`,
      instance,
      portBase: 30_000,
    });

    const listeners = declaredListeners(host.tailnetIPv4, true, false, layout);

    const cgroups = new Map(
      [layout.storeUnit, layout.nodeUnit].map((unit) => [unit, cgroup(unit, layout.slice)]),
    );

    const line = (address: string, number: number, unit: string, slice: string) =>
      `LISTEN 0 4096 ${address}:${number} 0.0.0.0:* users:(("process",pid=1,fd=3)) cgroup:${cgroup(unit, slice)}`;

    const neighbour = declaredListeners(host.tailnetIPv4, true, false)
      .map(({ address, port: number, unit }) => line(address, number, unit, "celld.slice"))
      .join("\n");

    const text = listeners
      .map(({ address, port: number, unit }) => line(address, number, unit, layout.slice))
      .join("\n");

    expect(
      assessListeners(`${text}\n${neighbour}`, host.tailnetIPv4, true, false, cgroups, layout)._tag,
    ).toBe("Ready");

    const bad = listeners
      .map(({ address, port: number, unit }, index) =>
        line(index === port ? "0.0.0.0" : address, number, unit, layout.slice),
      )
      .join("\n");

    expect(assessListeners(bad, host.tailnetIPv4, true, false, cgroups, layout)._tag).toBe(
      "Violation",
    );

    const defaults = new Map(
      ["celld-celld.service", "celld-seaweedfs.service"].map((unit) => [
        unit,
        cgroup(unit, "celld.slice"),
      ]),
    );

    expect(
      assessListeners(`${neighbour}\n${text}`, host.tailnetIPv4, true, false, defaults)._tag,
    ).toBe("Ready");
  },
);

it.prop(
  "instance names exclude hyphens, paths and systemd slice ancestors",
  {
    name: Arbitrary.schema(
      Schema.Literals(["", "a-b", "a/b", "../service", "Example", "1example"]),
    ),
  },
  ({ name }) => {
    expect(Schema.is(InstanceNameSchema)(name)).toBe(false);
  },
);
