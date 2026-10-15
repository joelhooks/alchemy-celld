import { it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";
import { expect } from "vitest";

import { InstanceNameSchema, instanceLayout, nodeUnit, sliceUnit, storeUnit } from "./fixture.ts";

const host = {
  dataRoot: "/srv/example/mailbox",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

it.prop(
  "named service limits and OOM policy belong to services, never the slice",
  {
    cpu: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 }))),
    instance: Arbitrary.schema(InstanceNameSchema),
    memory: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum: 1536, minimum: 1 }))),
    oomPolicy: Arbitrary.schema(Schema.Literals(["continue", "stop", "kill"])),
  },
  ({ cpu, instance, memory, oomPolicy }) => {
    const layout = instanceLayout(host, {
      dataRoot: `/srv/example/named/${instance}`,
      instance,
      portBase: 30_000,
    });

    const limits = [
      { cpuQuota: `${cpu}%`, memoryMax: `${memory}M`, oomPolicy },
      { cpuQuota: `${101 - cpu}%`, memoryMax: `${memory + 1}M`, oomPolicy },
    ] as const;

    const units = [
      nodeUnit({
        ...limits[0],
        binary: `${layout.bin}/celld`,
        data: `${layout.dataRoot}/celld`,
        environment: `${layout.configuration}/celld.env`,
        host,
        layout,
        restartOn: [],
      }),
      storeUnit({
        ...limits[1],
        binary: `${layout.bin}/weed`,
        config: `${layout.configuration}/s3.json`,
        data: `${layout.dataRoot}/seaweedfs`,
        home: host.home,
        layout,
        restartOn: [],
      }),
    ];

    for (const [index, unit] of units.entries()) {
      const service = new Map(unit.sections.find(({ name }) => name === "Service")?.lines);

      expect(service.get("OOMPolicy")).toBe(oomPolicy);
      expect(service.get("MemoryMax")).toBe(limits[index]?.memoryMax);
      expect(service.get("CPUQuota")).toBe(limits[index]?.cpuQuota);
      expect(
        unit.sections
          .filter(({ name }) => name !== "Service")
          .flatMap(({ lines }) => lines)
          .some(([key]) => key === "OOMPolicy"),
      ).toBe(false);
    }

    const slice = sliceUnit(host.home, "3G", "100%", { instance });
    expect(slice.sections.flatMap(({ lines }) => lines).some(([key]) => key === "OOMPolicy")).toBe(
      false,
    );
  },
);
