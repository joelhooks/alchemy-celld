import { Effect } from "effect";

import { Celld } from "./celld.ts";
import { deploymentStageLayout, stageDeploymentFiles } from "./deployment-stage.ts";
import type { UnitRenderLimits } from "./instance-units.ts";
import type { Node } from "./inventory-schema.ts";
import { ObjectStore } from "./object-store.ts";

export const probeInstance = "mischiefrb";

export const probePortBase = 28_010;

export const probeUnitLimits = {
  celld: {
    cpuQuota: "100%",
    memoryMax: "1.5G",
    oomPolicy: "continue",
    workerIPv4: "127.0.0.1",
  },
  seaweed: {
    cpuQuota: "100%",
    memoryMax: "1.5G",
    oomPolicy: "continue",
    volumeMax: 32,
  },
  slice: { cpuQuota: "100%", memoryHigh: "2.5G", memoryMax: "3G" },
} satisfies UnitRenderLimits;

export const probeIdentity = {
  commit: "rollback-proof",
  version: "rollback-proof",
};

export const instanceProbeProgram = (host: Node, dataRoot: string, purgeOnDelete = true) =>
  Effect.gen(function* probeStack() {
    const slice = yield* ObjectStore.Slice({
      ...probeUnitLimits.slice,
      home: host.home,
      instance: probeInstance,
    });

    const bucket = yield* ObjectStore.Bucket("store", {
      maintenanceGuard: { refuses: [] },
      ...probeUnitLimits.seaweed,
      dataRoot,
      host: { ...host, tailnetIPv4: "127.0.0.1" },
      instance: probeInstance,
      name: "mischiefrb-cells",
      portBase: probePortBase,
      purgeOnDelete,
      restartGate: true,
      slice: slice.sha256,
    });

    const prepared = {
      bundle: `export default { fetch() { return Response.json(${JSON.stringify(probeIdentity)}); } };`,
      configuration: JSON.stringify({
        compatibility_date: "2026-10-04",
        compatibility_flags: [],
        durable_objects: { bindings: [] },
        main: "worker.mjs",
        migrations: [],
        name: probeInstance,
        no_bundle: true,
        vars: {},
      }),
    };

    const staged = yield* stageDeploymentFiles(
      host.home,
      prepared,
      true,
      bucket.layout,
      bucket.configuration,
    );

    const node = yield* Celld.Node("celld", {
      ...probeUnitLimits.celld,
      bucket,
      host,
      instance: probeInstance,
      portBase: probePortBase,
      prepared: staged,
      purgeOnDelete,
      restartGate: true,
    });

    return yield* Celld.Deployment("worker", {
      ...prepared,
      ...probeIdentity,
      binary: `${bucket.layout.bin}/celld`,
      directory: deploymentStageLayout(host.home, bucket.layout).directory,
      environmentFile: `${bucket.layout.configuration}/celld.env`,
      internalUrl: node.internalUrl,
      workerUrl: node.publicUrl,
    });
  });
