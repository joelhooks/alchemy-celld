import { it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";
import { expect } from "vitest";

import { renderUnits } from "alchemy-celld";

const Instance = Schema.Struct({
  gate: Schema.Boolean,
  volume: Schema.Int.check(Schema.isBetween({ maximum: 256, minimum: 1 })),
});

it.prop(
  "store preStopSeconds is absent by default and rendered only for explicit opt-in",
  [Arbitrary.schema(Instance)],
  ([{ gate, volume }]) => {
    const host = {
      dataRoot: "/srv/example/mailbox",
      home: "/home/example",
      ssh: "example",
      tailnetIPv4: "203.0.113.10",
    };

    const store = renderUnits(
      host,
      {
        instance: "example",
        portBase: 33_000,
        restartGate: gate,
        maintenanceGuard: { refuses: [] },
      },
      { seaweed: { restartGate: gate, volumeMax: volume, volumePreStopSeconds: 0 } },
    ).find((unit) => unit.path.endsWith("-seaweedfs.service"));

    const exec = store?.text.split("\n").find((line) => line.startsWith("ExecStart="));

    expect(exec).toContain(` -volume.max=${volume} -volume.preStopSeconds=0`);

    const baseline = renderUnits(
      host,
      {
        instance: "example",
        portBase: 33_000,
        restartGate: gate,
        maintenanceGuard: { refuses: [] },
      },
      { seaweed: { restartGate: gate, volumeMax: volume } },
    ).find((unit) => unit.path.endsWith("-seaweedfs.service"));
    expect(baseline?.text).not.toContain("preStopSeconds");
    expect(baseline?.text).toContain(` -volume.max=${volume}`);
  },
);
