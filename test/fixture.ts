import type { InstanceLayout, InstanceProps } from "../src/instance.ts";
import { instanceLayout as layoutFor } from "../src/instance.ts";
import type { Node } from "../src/inventory-schema.ts";
import * as Units from "../src/service-units.ts";
import * as Retention from "../src/storage-maintenance.ts";
import * as Listeners from "../src/instance-listeners.ts";
import { declaredListeners as declared } from "../src/instance-listener-contract.ts";
import { startupLayer as startup } from "../src/instance-startup-contract.ts";
import { probeCommand as command } from "../src/instance-probes.ts";
import * as Stage from "../src/deployment-stage.ts";

export { InstanceNameSchema, PortBaseSchema, validateInstance } from "../src/instance.ts";

export type { InstanceLayout, InstanceProps, InstanceName, PortBase } from "../src/instance.ts";

export type { ServiceLimits } from "../src/service-units.ts";

export { stopUnit, stopUnits } from "../src/instance-startup-contract.ts";

export { serviceCapGuard } from "../src/instance-probes.ts";

export const fixtureHost: Node = {
  dataRoot: "/srv/example/mailbox",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

export const fixtureProps = { instance: "celld", portBase: 31_000, restartGate: false };

export const instanceLayout = (host: Node, props: Partial<InstanceProps> & { dataRoot?: string }) =>
  layoutFor(host, {
    ...fixtureProps,
    ...props,
    restartGate: props.restartGate ?? props.instance !== undefined,
  });

export const fixtureLayout = layoutFor(fixtureHost, fixtureProps);

export const nodeUnit = (
  input: Omit<Parameters<typeof Units.nodeUnit>[0], "layout"> & { layout?: InstanceLayout },
) => Units.nodeUnit({ layout: fixtureLayout, ...input });

export const storeUnit = (
  input: Omit<Parameters<typeof Units.storeUnit>[0], "layout"> & { layout?: InstanceLayout },
) => Units.storeUnit({ layout: fixtureLayout, ...input });

export const sliceUnit = (
  home: string,
  memoryMax?: string,
  cpuQuota?: string,
  props: { instance?: string; memoryHigh?: string } = {},
) => Units.sliceUnit(home, memoryMax, cpuQuota, { instance: fixtureProps.instance, ...props });

export const storageRetentionUnit = (
  home: string,
  script: string,
  ready: readonly string[],
  layout = fixtureLayout,
) => Retention.storageRetentionUnit(home, script, ready, layout);

export const storageRetentionTimer = (
  home: string,
  ready: readonly string[],
  layout = fixtureLayout,
) => Retention.storageRetentionTimer(home, ready, layout);

export const declaredListeners = (
  address: string,
  node: boolean,
  _removedSurface = false,
  layout = fixtureLayout,
) => declared(address, node, layout);

export const assessListeners = (
  text: string,
  address: string,
  node: boolean,
  _removedSurface = false,
  cgroups = new Map<string, string>(),
  layout = fixtureLayout,
) => Listeners.assessListeners(text, address, node, cgroups, layout);

export const readListeners = (
  shell: Parameters<typeof Listeners.readListeners>[0],
  layout = fixtureLayout,
) => Listeners.readListeners(shell, layout);

export const startupLayer = (
  address: string,
  mode: Parameters<typeof startup>[2] = "scope",
  archive?: string,
  restore?: Parameters<typeof startup>[4],
  layout = fixtureLayout,
) => startup(address, layout, mode, archive, restore);

export const probeCommand = (
  name: string,
  args: readonly string[],
  mode: Parameters<typeof command>[3] = "scope",
) => command(name, args, fixtureLayout, mode);

export const deploymentStageLayout = (home: string, layout = fixtureLayout) =>
  Stage.deploymentStageLayout(home, layout);

export const stageDeploymentFiles = (
  home: string,
  prepared: Parameters<typeof Stage.stageDeploymentFiles>[1],
  publicConfiguration: boolean,
  layout = fixtureLayout,
  root?: Parameters<typeof Stage.stageDeploymentFiles>[4],
) => Stage.stageDeploymentFiles(home, prepared, publicConfiguration, layout, root);
