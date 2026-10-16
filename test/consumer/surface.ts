// @effect-diagnostics nodeBuiltinImport:off -- This external consumer uses Node assertions at its executable boundary.
import assert from "node:assert/strict";

import {
  BindingName,
  cacheIoScript,
  Celld,
  Declaration,
  declaredListeners,
  deleteDeclaredUnit,
  deleteDirectory,
  Deployment,
  DeploymentProvider,
  deploymentStageLayout,
  digest,
  GeneratedConfiguration,
  Host,
  HostError,
  HostInventory,
  hostLayer,
  HostShell,
  InstanceNameSchema,
  listenerProbe,
  localExec,
  must,
  objectArchiveScript,
  ObjectStore,
  operatorBundle,
  optionalOperatorBundle,
  prepareDeployment,
  probeUnitLimits,
  readListeners,
  reconcileDirectory,
  refuse,
  RemoteFile,
  removeStoreSockets,
  renderUnit,
  renderUnits,
  shellQuote,
  sourceLayer,
  Ssh,
  sshLayer,
  stackListeners,
  stageDeploymentFiles,
  startupContractLayer,
  startupLayer,
  assertStarted,
  StateRecovery,
  stopUnits,
  SystemdUnit,
  textDigest,
  UnitSchema,
  unitPath,
  validateInstance,
  waitForStorage,
  withDestroyReceipt,
  workerBundle,
  wranglerConfiguration,
} from "alchemy-celld";
import type {
  Declaration as DeclarationSchema,
  DeploymentProps,
  InstanceLayout,
  Interface,
  Node,
  UnitProps,
} from "alchemy-celld";
import { Host as InventoryHost, layer as legacyHostLayer } from "alchemy-celld/HostInventory";
import { offlineLayer } from "alchemy-celld/offline";
import { Effect, Layer } from "effect";

// Every runtime occurrence in the 30-module/57-symbol contract is pinned here.
// The six erased type imports above are checked by pnpm typecheck.
const surface = {
  adoption: [StateRecovery],
  "cache-io-script": [cacheIoScript],
  celld: [Celld],
  deployment: [Deployment, DeploymentProvider],
  "deployment-build": [prepareDeployment],
  "deployment-config": [BindingName, Declaration, GeneratedConfiguration, wranglerConfiguration],
  "deployment-stage": [deploymentStageLayout, stageDeploymentFiles],
  files: [deleteDirectory, digest, reconcileDirectory, refuse, textDigest],
  host: [Host, hostLayer],
  "host-shell": [HostError, HostShell, must],
  instance: [InstanceNameSchema, validateInstance],
  "instance-probe-stack": [probeUnitLimits],
  "instance-startup-contract": [startupLayer],
  "inventory-schema": [],
  "listener-contract": [declaredListeners],
  listeners: [readListeners, stackListeners],
  "local-exec": [localExec],
  "object-archive-script": [objectArchiveScript],
  "object-store": [ObjectStore],
  "operator-build": [operatorBundle, optionalOperatorBundle],
  "probe-receipts": [withDestroyReceipt],
  probes: [listenerProbe],
  providers: [RemoteFile, SystemdUnit],
  release: [sourceLayer],
  ssh: [sshLayer, shellQuote],
  "startup-contract": [assertStarted, startupContractLayer, stopUnits],
  "storage-readiness": [waitForStorage],
  systemd: [UnitSchema, deleteDeclaredUnit, renderUnit, unitPath],
  "unit-cleanup": [removeStoreSockets],
  "worker-bundle": [workerBundle],
};
assert.equal(Object.keys(surface).length, 30);
assert.equal(Object.values(surface).flat().length, 51);
for (const [module, symbols] of Object.entries(surface)) {
  for (const symbol of symbols) assert.notEqual(symbol, undefined, module);
}
assert.equal(Host, InventoryHost);
assert.equal(hostLayer, legacyHostLayer);
assert.equal(hostLayer, HostInventory.layer);
assert.equal(sshLayer, Ssh.layer);
assert.equal(startupContractLayer, startupLayer);
assert.ok(Layer.isLayer(hostLayer));
assert.ok(Layer.isLayer(offlineLayer));

const host: Node = {
  dataRoot: "/srv/example/cells",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};
const props = { instance: "example", portBase: 33_000, restartGate: true };
const layout: InstanceLayout = await Effect.runPromise(validateInstance(host, props));
assert.equal(layout.nodeUnit, "example-celld.service");
assert.equal(layout.ports.s3, 33_006);
const store = renderUnits(host, props).find((unit) => unit.path.endsWith("-seaweedfs.service"));
const storeExec = store?.text.split("\n").find((line) => line.startsWith("ExecStart="));
assert.ok(storeExec?.endsWith(" -volume.max=512 -volume.preStopSeconds=0"));
assert.equal(
  deploymentStageLayout(host.home, layout).directory,
  `${layout.configuration}/deployment`,
);
// Construct both layer families without acquiring resources or contacting a host.
assert.ok(Layer.isLayer(sshLayer(host, props)));
assert.ok(Layer.isLayer(startupLayer(host.tailnetIPv4, layout)));
assert.ok(Layer.isLayer(startupContractLayer(host.tailnetIPv4, layout)));
assert.equal(
  await Effect.runPromise(
    Effect.isFailure(validateInstance(host, { ...props, instance: "INVALID" })),
  ),
  true,
);

const unit: UnitProps = {
  home: host.home,
  name: layout.nodeUnit,
  scope: "user",
  sections: [{ name: "Service", lines: [["ExecStart", "/usr/bin/true"]] }],
};
assert.equal(renderUnit(unit), "[Service]\nExecStart=/usr/bin/true\n");
assert.equal(unitPath(unit), `${host.home}/.config/systemd/user/${layout.nodeUnit}`);
assert.equal(textDigest("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.equal(digest(new TextEncoder().encode("abc")), textDigest("abc"));
assert.equal(shellQuote("it's"), "'it'\\''s'");

const shell: Pick<Interface, "exec"> = { exec: () => Effect.succeed({ code: 0, stdout: "ok" }) };
assert.equal(await Effect.runPromise(must(shell, ["true"])), "ok");
const declaration: typeof DeclarationSchema.Type = {
  compatibility_date: "2026-10-04",
  compatibility_flags: [],
  durable_objects: { bindings: [] },
  migrations: [],
  name: "example",
};
const identity: Pick<DeploymentProps, "version" | "commit"> = { version: "test", commit: "local" };
const configuration = await Effect.runPromise(
  wranglerConfiguration(declaration, { ...identity, main: "worker.mjs", vars: {} }),
);
assert.equal(configuration.main, "worker.mjs");
assert.equal(configuration.no_bundle, true);
process.stdout.write("CONSUMER_SURFACE_OK 30 modules 57 symbols\n");
