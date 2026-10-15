import { instanceLayout } from "./instance.ts";
import type { InstanceLayout, InstanceProps } from "./instance.ts";
import type { Node } from "./inventory-schema.ts";
import { renderMaintenanceScript } from "./maintenance-render.ts";
import { assertMaintenanceIsolation } from "./maintenance-targets.ts";
import { nodeUnit, sliceUnit, storeUnit } from "./service-units.ts";
import type { ServiceLimits } from "./service-units.ts";
import { storageRetentionTimer, storageRetentionUnit } from "./storage-maintenance.ts";
import { renderUnit, unitPath } from "./systemd.ts";

export interface NodeUnitLimits extends ServiceLimits {
  readonly restartGate?: boolean | undefined;
  readonly workerIPv4?: string | undefined;
}

export interface StoreUnitLimits extends ServiceLimits {
  readonly restartGate?: boolean | undefined;
  readonly volumeMax?: number | undefined;
}

export interface UnitRenderLimits {
  readonly celld?: NodeUnitLimits;
  readonly seaweed?: StoreUnitLimits;
  readonly slice?: {
    readonly cpuQuota?: string;
    readonly memoryHigh?: string;
    readonly memoryMax?: string;
  };
}

export const instanceNodeUnit = (
  host: Node,
  layout: InstanceLayout,
  limits: NodeUnitLimits = {},
) => {
  const address = limits.workerIPv4 ?? host.tailnetIPv4;

  return nodeUnit({
    binary: `${layout.bin}/celld`,
    cpuQuota: limits.cpuQuota,
    data: `${layout.dataRoot}/celld`,
    environment: `${layout.configuration}/celld.env`,
    host,
    layout,
    memoryMax: limits.memoryMax,
    oomPolicy: limits.oomPolicy,
    restartGate:
      (limits.restartGate ?? layout.restartGate)
        ? { address, path: `${layout.bin}/restart-gate.mjs` }
        : undefined,
    restartOn: [],
    storageDiagnostic: `${layout.bin}/storage-maintenance.py`,
    workerIPv4: address,
  });
};

export const instanceStoreUnit = (
  host: Node,
  layout: InstanceLayout,
  limits: StoreUnitLimits = {},
) =>
  storeUnit({
    binary: `${layout.bin}/weed`,
    config: `${layout.configuration}/s3.json`,
    cpuQuota: limits.cpuQuota,
    data: `${layout.dataRoot}/seaweedfs`,
    home: host.home,
    layout,
    memoryMax: limits.memoryMax,
    oomPolicy: limits.oomPolicy,
    restartGate:
      (limits.restartGate ?? layout.restartGate)
        ? { address: host.tailnetIPv4, path: `${layout.bin}/restart-gate.mjs` }
        : undefined,
    restartOn: [],
    volumeMax: limits.volumeMax,
  });

export const renderUnits = (
  host: Node,
  props: InstanceProps & { readonly dataRoot?: string },
  limits: UnitRenderLimits = {},
): readonly { readonly path: string; readonly text: string }[] => {
  const layout = instanceLayout(host, props);

  renderMaintenanceScript(host, props);

  const units = [
    sliceUnit(host.home, limits.slice?.memoryMax, limits.slice?.cpuQuota, {
      ...props,
      ...limits.slice,
    }),
    instanceNodeUnit(host, layout, limits.celld),
    instanceStoreUnit(host, layout, limits.seaweed),
    storageRetentionUnit(host.home, `${layout.bin}/storage-maintenance.py`, [], layout),
    storageRetentionTimer(host.home, [], layout),
  ];

  return units.map((unit) => {
    const text = renderUnit(unit);

    assertMaintenanceIsolation(layout, text);

    return { path: unitPath(unit), text };
  });
};
