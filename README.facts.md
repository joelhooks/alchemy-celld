- Package name: `alchemy-celld`.
- Package version: `0.1.2`.
- License: MIT; `LICENSE` and `LICENSE-homeflare-kit` contain the notices.
- The Linux and release providers in `src/` adapt `taslabs-net/homeflare-kit` at `cf20298`; its MIT notice is retained in `LICENSE-homeflare-kit`.
- Internal runtime dependencies: `@effect/platform-node@4.0.0`, `esbuild@0.28.2`.
- Required host peer dependencies: `alchemy@>=2.0.0-beta.81 <2.0.0-beta.84`, `effect@^4.0.0`.
- Development dependencies: `@effect/tsgo@0.45.0`, `@effect/vitest@4.0.1`, `@types/node@24.13.6`, `alchemy@2.0.0-beta.81`, `effect@4.0.1`, `oxfmt@0.68.0`, `typescript@7.0.2`, `vitest@5.0.1`.
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

### Shared runtime contract

Effect and Alchemy are required peers because the provider exchanges Effect services and Alchemy resources/outputs with its host application. Their exact development pins keep this repository's own checks reproducible; they are not private runtime dependencies installed for the provider.

Upstream `@effect/platform-node@4.0.0` declares an Effect peer of `^4.0.0`, and `@effect/vitest@4.0.1` declares `^4.0.1`: compatible ranges are the published Effect ecosystem convention. This package declares `^4.0.0`, admitting compatible stable Effect 4 releases including 4.0.0, but excluding Effect 5 and prereleases such as 4.0.0-rc.110. Its Alchemy range is deliberately bounded to `>=2.0.0-beta.81 <2.0.0-beta.84`: beta.81 through beta.83 are admitted, while beta.80, beta.84, and 2.0.0 final are excluded. The local development and test baseline remains exactly Effect 4.0.1 and Alchemy beta.81; the peer ranges are not a claim that every admitted version has been exercised by this suite.

`@effect/platform-node` remains an internal dependency. It provides Node implementations inside the standalone gate/probe programs, not a platform-specific tag exchanged with the host. Its `NodeServices.layer` supplies tags owned by Effect, including `FileSystem` and `Path`. Esbuild remains an internal runtime dependency: `prepareDeployment`, `workerBundle`, and `operatorBundle` call its `build` function when the operator runs them, not only while publishing this package.

Peer diagnostics depend on installer policy. With pnpm peer auto-install disabled, a bare consumer gets missing-peer warnings for Effect and Alchemy; strict peer checking can turn those warnings into installation errors. Pnpm's default `autoInstallPeers: true` instead installs missing peers automatically. Declaring peers does not override that consumer-side policy or itself guarantee one physical module instance. `test/package-peers.test.ts` packs the real package, verifies missing-peer diagnostics without auto-install, and checks that a consumer supplying the supported versions resolves the same Effect and Alchemy paths as the provider.

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

The store unit omits `preStopSeconds` by default. Set `volumePreStopSeconds: 0` on `StoreProps`, or on `UnitRenderLimits.seaweed` when calling `renderUnits`, to append `-volume.preStopSeconds=0` immediately after `-volume.max`. Other supplied values are rejected. `test/store-prestop.test.ts` checks both arms across generated restart-gate and volume-limit inputs. The default instance snapshots match the extraction baseline byte-for-byte, including their unit digest. The `volumeMax` default and explicit overrides are unchanged; provider tests also pin an explicit cap of 64.

### Explicit configuration seams

The root additionally exports `InstancePortsSchema`, `InstanceAdoptionSchema`, `RestartGateCommandsSchema`, `MaintenanceGuardSchema`, and their `InstancePorts`, `InstanceAdoption`, `RestartGateCommands`, `MaintenanceGuard`, and `MaintenanceProps` types. Existing `InstanceProps`, `SliceProps`, `StoreProps`, `CelldProps`, and unit-limit types carry the relevant optional props.

- `maintenanceGuard` is required for `renderMaintenanceScript`, `renderUnits`, and `ObjectStore.Bucket`. Omission fails before rendering or provider writes. Pass `{ refuses: [] }` to explicitly declare no protected ports; `refuses` is an empty tuple, not a list that accepts entries. Otherwise pass `{ base, offsets, exemptInstance }`, with a nonempty array of nonnegative integer offsets, every `base + offset` between 1 and 65535, and a safe exemption name of at most 16 characters. The structured form renders the canonical `mailbox_ports = {<base> + offset for offset in (<offsets>)}` and `args.instance != "<exemption>"` guard blocks. It accepts no raw Python. Layout construction alone can omit the declaration because it does not render or execute maintenance; every maintenance-producing path enforces it. Examples/tests make the empty choice explicitly, not through a production default.
- `ports?: InstancePorts` supplies all ten listener ports: `public`, `internal`, `filer`, `filerGrpc`, `master`, `masterGrpc`, `s3`, `s3Grpc`, `volume`, and `volumeGrpc`. Each must be an integer from 1 through 65535. Partial, malformed and extra-key maps fail instead of merging. Omit the map to retain the existing uniform `portBase + offset` layout. `portBase` remains required and validated. No deployment-specific map or default is embedded in the package.
- `adopt?: { name: string; acceptsNestedSlice: true }` explicitly adopts an existing name. The name must match `instance`, start with a lowercase letter, contain only lowercase letters/digits and single separating hyphens, and fit within 16 characters (the existing owner-unit and rotation schemas' bound). This is a separate validation path. `InstanceNameSchema` remains unchanged for new instances. Acknowledging adoption does not flatten a nested systemd slice. Pass adoption consistently to `ObjectStore.Slice`, `ObjectStore.Bucket`, `Celld.Node`, and the shell/layout constructor.
- `restartGateCommands?: { beforeNode: string; node: string; store: string }` supplies complete raw systemd command values. They render verbatim, without changing quoting or appending arguments. All three must be nonblank and contain no newline, carriage return or NUL. Extra keys and partial sets fail. Commands require `restartGate: true`; deploying them through `ObjectStore.Bucket` also requires a nonblank, explicit `restartGateBundle`. Any supplied bundle, including a bundle without custom commands, must be a nonblank pre-built string with gating enabled. The bytes are installed verbatim, including trailing newlines, rather than rebuilt. A bundle alone retains the default long-argument command ABI. The consumer owns any custom command syntax and its matching implementation.

The default gate command stays topology-explicit: address, action, instance, port base, and data root. A non-uniform port map or adoption acknowledgement adds one systemd-quoted JSON context argument with `ports` and/or `adopt`. The shipped helper validates that context and reconstructs the same layout before running commands. An omitted context keeps the existing uniform command bytes. Custom commands bypass this generated ABI and use the consumer's supplied bundle instead. Extending the shipped helper changes that helper's bundle bytes; consumers preserving a pinned helper artifact must inject it explicitly.

`test/maintenance-guard.test.ts` pins omission failure versus explicit-empty success, canonical protected-guard bytes, block-withdrawal detection, invalid/incomplete declarations, and actual Python rejection/exemption before any network access. The maintenance isolation assertion verifies the requested script blocks as well as explicit endpoint isolation. `test/instance-ports.test.ts` checks complete overrides, every missing port key, invalid values, default-byte preservation, rendered listeners and gate context. `test/instance-adoption.test.ts` checks the strict/adopted name paths, command-injection rejection, missing bundles, and provider propagation through fake providers. All new fixtures use invented names, addresses, ports and paths. No tests contact hosts or start services.

### Error payloads and redaction

Tagged error identities and raise conditions are retained. Errors expose an `operation`, an invariant `reason`, and field/accepted-shape/action context. Existing open reason strings remain open; there is no global casing or punctuation rewrite. `HostError` keeps its existing constructor usable, with optional additional context. Public maintenance-error constructors also retain reason-only construction through context defaults.

`WorkerBundleFailure` includes a redacted `entrypoint` descriptor (field, redaction marker, source extension) and structured `diagnostics`: category, severity, field, safe text, and line/column when available. Deployment and operator build errors use the same diagnostic projection. Raw source paths, source lines, arbitrary quoted values, plugin detail and raw causes are not retained. Esbuild's direct diagnostic logging is disabled so those raw values do not bypass the redacted payload. Missing-output failures identify the expected output and preserve sanitized build warnings.

Deployment bindings and empty bundle identity have separate reasons. Identity mismatches carry `expected` and `actual` version/commit SHA-256 digests with `identityEncoding: "sha256"`, not raw identity values. Invalid secret names identify the offending `secretNames[index]` and the accepted `^[A-Z][A-Z0-9_]*$` shape without echoing that entry. Fake-shell failures name safe known command tokens while redacting arguments or unknown command values; directory failures identify the field and collision/parent state without revealing paths. Inventory/host validation retains its existing redaction, naming the field and accepted shape rather than embedding raw schema issues.

Existing security invariants, including `Delete path escapes its instance custody` and `named maintenance refuses mailbox ports`, are preserved. Generated Python parser strings and the maintenance script body are unchanged. Existing listener receipts are retained; the new listener error message adds invariant/action context rather than copying receipt values into prose. Error-context and missing-output tests cover the payloads and redaction; default render snapshots remain separate byte-preservation evidence.

### Consumer proof and runtime scope

`test/consumer/surface.ts` imports only published package entry points. `test/consumer.test.ts` copies it into a fresh external consumer directory and creates a workspace-style package link. It runs both TypeScript and native Node against the link. The original 51 runtime occurrences and six erased type imports are pinned, along with the additional public schema/type contracts below. The executable exercises valid and invalid instance validation, both startup aliases, host/SSH layer construction, deployment configuration, unit rendering with and without the store pre-stop flag, injected ports/adoption/commands, hashing, quoting, and shell command-result handling. It does not contact hosts or start services.

The regression test copies the package into an isolated snapshot, withdraws only the `validateInstance` root export, and runs the same consumer. Both TypeScript and Node must reject the missing export. The working tree is never mutated by this test.

The package ships TypeScript source: its exports map points at `./src/index.ts`, `./src/host.ts`, and `./src/offline.ts`, with no compiled JavaScript distribution. When installed under `node_modules`, it requires a TypeScript-aware consumer such as jiti, tsx, vitest, or a bundler. Plain `node` cannot import it from `node_modules`: Node's built-in type stripping rejects TypeScript there with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. The native Node proof covers workspace links, where Node resolves the real source path outside `node_modules`; it does not establish plain Node support for an installed tarball. The proof needs only the already-installed dependencies and performs no registry access.
