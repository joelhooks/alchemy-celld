- Package name: `alchemy-celld`.
- Package version: `0.1.0`.
- License: MIT; `LICENSE` and `LICENSE-homeflare-kit` contain the notices.
- The Linux and release providers in `src/` adapt `taslabs-net/homeflare-kit` at `cf20298`; its MIT notice is retained in `LICENSE-homeflare-kit`.
- Runtime dependencies: `@effect/platform-node@4.0.0`, `alchemy@2.0.0-beta.81`, `effect@4.0.1`, `esbuild@0.28.2`.
- Development dependencies: `@effect/tsgo@0.45.0`, `@effect/vitest@4.0.1`, `@types/node@24.13.6`, `oxfmt@0.68.0`, `typescript@7.0.2`, `vitest@5.0.1`.
- Node.js requirement: `>=24.18.0`; package manager: `pnpm@11.28.2`.
- Target platform: Linux x86_64. The celld asset is `celld-x86_64-unknown-linux-gnu.gz`.
- celld pin: `v0.6.1`; compressed SHA-256: `79a8253cff5d4e8a4a9f7a2611e393390f7fe9025f00e88467875b007c44866b`; extracted SHA-256: `810b2a0b70e3420daee80f1d5378de5ba28651f0371ec7aa70b6c5de77e70d9e`.
- SeaweedFS pin: `4.48`; asset: `linux_amd64.tar.gz`; archive SHA-256: `4a7d108384d044d95212d1342cdda9533fa55842c1c9b41f606ca3c8a9561124`; `weed` SHA-256: `8c07a1ccc4ec058cd90989ac0533c30436832e41c63de2b26f37253d9f744c4d`.
- `examples/stack.ts` composes `ObjectStore.Slice`, `ObjectStore.Bucket`, and `Celld.Node` with injected host inventory and SSH transport. Delete-time data purging is disabled in that example.
- `examples/cli.ts` accepts `deploy`, `plan`, `diagnose`, `race`, `listeners`, `health`, `bootstrap`, `preflight`, `store-listeners`, `status`, `uid-probe`, and `bootstrap-check`.
- Host inventory is a mode-`0600` JSON file selected by `FLEET_INVENTORY`; `examples/inventory.example.json` contains invented input values.
- The example requires `FLEET_LIVE_NODE`, `FLEET_INSTANCE`, `FLEET_PORT_BASE`, `FLEET_RESTART_GATE`, `FLEET_BUCKET`, and an external `FLEET_STATE_DIR`.
- Example environment command: `export FLEET_INVENTORY=/srv/example/inventory.json FLEET_LIVE_NODE=example FLEET_INSTANCE=example FLEET_PORT_BASE=33000 FLEET_RESTART_GATE=true FLEET_BUCKET=example-cells FLEET_STATE_DIR=/srv/example/alchemy-state`.
- Install command from the package directory inside a parent workspace: `pnpm install --ignore-workspace`.
- Check commands from the package directory: `pnpm check` and `pnpm test`. Consumer-only proof: `ALCHEMY_TELEMETRY_DISABLED=1 pnpm exec vitest run --config vitest.config.ts test/consumer.test.ts`.
- Example read commands from the package directory: `pnpm example plan`, `pnpm example preflight`, `pnpm example diagnose`, `pnpm example health`, `pnpm example status`.
- Example deploy command after host approval: `FLEET_START_APPROVED=true pnpm example deploy`.
- Example bootstrap commands: `pnpm example bootstrap` and `pnpm example bootstrap-check`.
- The race action additionally requires `FLEET_RACE_APPROVED=true`.

## Package entry points

`alchemy-celld` exposes an explicit root API through `src/index.ts`. Examples use that package name through Node's package self-reference. No TypeScript `paths` alias is involved. The existing `alchemy-celld/HostInventory` and `alchemy-celld/offline` entry points remain unchanged.

The root keeps the existing exports and adds the consumer surface below. Explicit exports avoid exposing every helper in `src/` as supported API. `probeUnitLimits` is available without exporting the probe stack's fixed instance name, port base, or program. The low-level file, systemd, and cleanup operations remain Effect programs; callers still supply the shell and custody required by their signatures.

The two `layer` exports have distinct root names: `hostLayer` comes from `host.ts`, and `sshLayer` comes from `ssh.ts`. Callers can retain their local names with `import { hostLayer as layer } from "alchemy-celld"`. `startupLayer` comes from the canonical instance contract. `startupContractLayer` comes through the startup-contract shim. Both startup names refer to the same implementation, and the consumer proof pins both. `HostInventory.layer` and `Ssh.layer` remain available too.

### Consumer contract: 30 modules, 57 symbol occurrences

Every entry below is reachable from `alchemy-celld`. The count includes six type imports, counts `Declaration` in both value and type positions, and counts the two startup exports separately. `Declaration` is the schema value; an erased type import supports the existing `typeof Declaration.Type` usage, not a new decoded-value type alias.

| Source module                  | Root exports                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `adoption.ts`                  | `StateRecovery`                                                                                     |
| `cache-io-script.ts`           | `cacheIoScript`                                                                                     |
| `celld.ts`                     | `Celld`                                                                                             |
| `deployment.ts`                | `Deployment`, `DeploymentProvider`, type `DeploymentProps`                                          |
| `deployment-build.ts`          | `prepareDeployment`                                                                                 |
| `deployment-config.ts`         | `BindingName`, `Declaration`, `GeneratedConfiguration`, type `Declaration`, `wranglerConfiguration` |
| `deployment-stage.ts`          | `deploymentStageLayout`, `stageDeploymentFiles`                                                     |
| `files.ts`                     | `deleteDirectory`, `digest`, `reconcileDirectory`, `refuse`, `textDigest`                           |
| `host.ts`                      | `Host`, `layer as hostLayer`                                                                        |
| `host-shell.ts`                | `HostError`, `HostShell`, `must`, type `Interface`                                                  |
| `instance.ts`                  | `InstanceNameSchema`, type `InstanceLayout`, `validateInstance`                                     |
| `instance-probe-stack.ts`      | `probeUnitLimits`                                                                                   |
| `instance-startup-contract.ts` | `startupLayer`                                                                                      |
| `inventory-schema.ts`          | type `Node`                                                                                         |
| `listener-contract.ts`         | `declaredListeners`                                                                                 |
| `listeners.ts`                 | `readListeners`, `stackListeners`                                                                   |
| `local-exec.ts`                | `localExec`                                                                                         |
| `object-archive-script.ts`     | `objectArchiveScript`                                                                               |
| `object-store.ts`              | `ObjectStore`                                                                                       |
| `operator-build.ts`            | `operatorBundle`, `optionalOperatorBundle`                                                          |
| `probe-receipts.ts`            | `withDestroyReceipt`                                                                                |
| `probes.ts`                    | `listenerProbe`                                                                                     |
| `providers.ts`                 | `RemoteFile`, `SystemdUnit`                                                                         |
| `release.ts`                   | `sourceLayer`                                                                                       |
| `ssh.ts`                       | `layer as sshLayer`, `shellQuote`                                                                   |
| `startup-contract.ts`          | `assertStarted`, `startupLayer as startupContractLayer`, `stopUnits`                                |
| `storage-readiness.ts`         | `waitForStorage`                                                                                    |
| `systemd.ts`                   | `UnitSchema`, `deleteDeclaredUnit`, `renderUnit`, type `UnitProps`, `unitPath`                      |
| `unit-cleanup.ts`              | `removeStoreSockets`                                                                                |
| `worker-bundle.ts`             | `workerBundle`                                                                                      |

The root also exposes `bootstrapCheck`, `bootstrapProbe`, `diagnoseProbe`, and `raceProbe` for the example runtime. The existing `renderUnits` root export remains available and is exercised by the consumer. The Claude-specific agent-runtime surface is not part of this package.

The store unit's weed `ExecStart` ends with `-volume.max=<value> -volume.preStopSeconds=0`. The latter flag preserves the downstream owner's required unit-rendering change. `test/store-prestop.test.ts` checks it across generated restart-gate and volume-limit inputs through the package name. The instance plan/render snapshots deliberately change at three lines: the two weed command representations and the resulting unit digest. No other rendered bytes were changed by this patch.

### Consumer proof and runtime scope

`test/consumer/surface.ts` imports only published package entry points. `test/consumer.test.ts` copies it into a fresh external consumer directory and creates a workspace-style package link. It runs both TypeScript and native Node against the link. All 51 runtime occurrences and six erased type imports are pinned. The executable exercises valid and invalid instance validation, both startup aliases, host/SSH layer construction, deployment configuration, unit rendering including the store pre-stop flag, hashing, quoting, and shell command-result handling. It does not contact hosts or start services.

The regression test copies the package into an isolated snapshot, withdraws only the `validateInstance` root export, and runs the same consumer. Both TypeScript and Node must reject the missing export. The working tree is never mutated by this test.

The entry points remain TypeScript source. The native Node proof covers workspace links, where Node resolves the real source path outside `node_modules`. A tarball installed directly under `node_modules` needs a TypeScript-capable bundler or loader; Node's built-in type stripping does not support that location. This change adds no compiled JavaScript distribution and makes no claim that plain Node can run such a tarball. The proof needs only the already-installed dependencies and performs no registry access.
