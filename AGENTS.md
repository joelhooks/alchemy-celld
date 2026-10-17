# Repo law

Read [VISION.md](VISION.md), then the relevant [skill](skills/uncomplect/SKILL.md). Read source and tests before claiming behavior. Preserve consumer work and unrelated changes. Do not deploy, destroy, publish, or push without authorization for that action.

## Stack

`package.json` owns pins. Development uses Alchemy `2.0.0-beta.81`, Effect `4.0.1`, platform-node `4.0.0`, TypeScript `7.0.2`, effect-tsgo `0.45.0`, effect-vitest `4.0.1`, Vitest `5.0.1`, Oxfmt `0.68.0`, and esbuild `0.28.2`. Use Node `>=24.18.0` and pnpm `11.28.2` (engine minimum `>=11.1.2`). No stack migration as a side effect.

Alchemy and Effect are shared runtime peers: `>=2.0.0-beta.81 <2.0.0-beta.84` and `^4.0.0`. These ranges are not a tested-version matrix. Imports go through the explicit package exports. Installed packages ship TypeScript, not compiled JavaScript; use a TypeScript-aware consumer. See `test/consumer.test.ts` and `test/package-peers.test.ts`.

## Commands

- `pnpm install --frozen-lockfile`: install development pins and runtime peers.
- `pnpm check`: typecheck and check formatting.
- `pnpm test`: default suite, with telemetry disabled.
- `pnpm example plan`: inspect the configured example's plan; reads a live host.
- `pnpm example deploy`: mutates the approved host; requires `FLEET_START_APPROVED=true`.

The example requires private `FLEET_INVENTORY`, `FLEET_LIVE_NODE`, `FLEET_INSTANCE`, `FLEET_PORT_BASE`, `FLEET_RESTART_GATE`, `FLEET_BUCKET`, and external `FLEET_STATE_DIR`. Inventory must be mode 0600. `FLEET_RACE_APPROVED=true` separately approves the race action. Keep inventory, state, receipts, and credentials outside tracked source.

### Live proof

Run the relevant real test before claiming infrastructure behavior. Local systemd proof:

```sh
FLEET_LIVE_NODE=local FLEET_START_APPROVED=true ALCHEMY_TELEMETRY_DISABLED=1 pnpm exec vitest run --config vitest.config.ts test/systemd-live.test.ts
```

This creates unique throwaway units on the **local** non-root Linux user manager. The node variable enables it; it does not select a remote target. It checks slice-limit updates and activation settling, then removes its units. Read the test before authorizing it.

The separate instance launcher is `ALCHEMY_TELEMETRY_DISABLED=1 node test/live/instance-probe.ts <action>`. It requires `FLEET_INVENTORY`, `FLEET_LIVE_NODE`, `FLEET_PROBE_DATA_ROOT`, and external `FLEET_STATE_DIR`. Review its fixed instance and ports in `src/instance-probe-stack.ts` before use. Read actions are `plan`, `health`, `destroy-plan`, and `verify-gone`; `render-units` omits the state-directory requirement. `deploy` requires `FLEET_START_APPROVED=true`; `destroy` requires `FLEET_DESTROY_APPROVED=true` after reviewing `destroy-plan`. Its probe explicitly enables purge. Never point it at existing data. Keep its baseline and receipts private.

### Matching agent sources

There is **no** `pnpm vendor:agent-sources` script here. Do not claim to have run it. Populate ignored mirrors manually when absent:

```sh
mkdir -p .agent_sources/github.com/Effect-TS .agent_sources/github.com/alchemy-run
git clone --depth 1 --branch effect@4.0.1 https://github.com/Effect-TS/effect.git .agent_sources/github.com/Effect-TS/effect
git clone --depth 1 --branch v2.0.0-beta.81 https://github.com/alchemy-run/alchemy.git .agent_sources/github.com/alchemy-run/alchemy
```

Do not overwrite an existing mirror. Check its commit, tag and manifest against the pins first. Read matching Effect source and Alchemy `Resource`, `Provider`, `Diff`, `AdoptPolicy`, and provider tests before asserting API behavior. Mirrors are reference material, not runtime imports or committed files.

## Stop rules

- No private topology: real host names, tailnet names, IP addresses, node IDs, storage IDs, token IDs, private paths, or internal agent names. Invented documentation values and loopback test addresses are allowed. Scan every changed file before committing or publishing; inspect matches, not just the exit code. There is no automatic redaction gate.
- No planned replacement in an approved apply. If the plan contains replacement or unexpected deletion, stop and redesign or obtain a separately reviewed migration. Do not rename resource identities to make a plan pass. This is operator law, not a global provider fence.
- Do not restart an active slice to apply changed limits. Reconciliation writes it and daemon-reloads. Explicit stop requests remain destructive operations. See `src/systemd.ts:467`.
- Writes get one attempt. Readback may retry; a failed write needs inspection, not blind replay of the whole reconcile. See the [write rule](skills/writes-never-retry/SKILL.md).
- Data purge is opt-in, not a default or an adoption side effect. Retention does not mean every resource survives destroy.
- Default tests do not prove live behavior. Report skipped live checks and untested versions plainly.

## Known gaps and deliberate exceptions

These source locations describe 0.1.3. Recheck them after changing the code.

| Rule                            | Boundary or gap                                                                                                                                                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No planned replacement          | `src/providers.ts:101`, `:175`, `:274`, `:380`, `src/node-provider.ts:86`, `src/bucket-api.ts:201`, and `src/deployment.ts:309` still return replacement actions for identity changes. No global plan veto exists. The slice safety skill is only a narrow case.                    |
| Adoption never mutates          | Not a global invariant. `src/files.ts:252` can chmod an adopted directory. `src/systemd.ts:463` can enable or disable a matching unit, and `:469` can start it. No `adopt-never-mutates` skill is shipped.                                                                          |
| Recovery credential rotation    | Intended exception, not a gap: `src/adoption.ts:73` validates rotation ownership during `StateRecovery`; `src/providers.ts:127` admits that recovery path before reconciliation installs new bytes. Do not turn recovery into ordinary adoption.                                    |
| Live proof required             | `test/systemd-live.test.ts:14` gates real tests behind environment variables. `vitest.config.ts:6` includes default test files, not `test/live/instance-probe.ts`. No hook or CI requires a live run. The live-test skill documents real assertions, not an automatic release gate. |
| Topology and source-first rules | Manual review only. `package.json:19` has no source-vendoring or redaction script. Existing historical fixtures are not proof that new deployment facts are safe to commit.                                                                                                         |

## Shape and checks

Keep resource identity, transport, rendering, and operational policy separate. Use `skills/add-a-resource/SKILL.md` for extensions and `skills/keep-or-cut/SKILL.md` to judge new surface area. Finish with `pnpm check`, `pnpm test`, relevant live proof, a redaction scan, and a diff review. State exactly which ran. Never adjust snapshots merely to hide behavior changes.
