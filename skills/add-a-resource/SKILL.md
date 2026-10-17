---
name: add-a-resource
description: Extend alchemy-celld with a resource a real consumer needs. Use when adding resource types, provider lifecycle methods, schemas, outputs, or public exports.
---

# Add a resource

1. Read `AGENTS.md`, [uncomplect](../uncomplect/SKILL.md), and [keep-or-cut](../keep-or-cut/SKILL.md). Name the consumer and its required lifecycle. Prefer a plain helper when no resource identity or lifecycle is needed.
2. Start from matching source mirrors, not remembered APIs. `AGENTS.md` gives the manual vendoring procedure; there is no vendoring script. Read Alchemy's `Resource`, `Provider`, `Diff`, `AdoptPolicy`, and a comparable upstream provider at the pinned beta. Read Effect's matching schema and service APIs.
3. Trace `src/providers.ts` and `src/bucket-api.ts`: declare a Resource contract; build its provider with `Provider.effect`; implement the applicable read, diff, reconcile, delete, and list methods. Use the actual upstream signatures. Do not invent a parallel deployment engine.
4. Validate external inputs at the boundary. Keep outputs sufficient for ownership and readback. Use `HostShell` for transport and typed, redacted failures for refusal. Do not attach raw paths, credentials, host facts, or subprocess output to public errors.
5. Keep reads observational and diffs free of mutation. Distinguish explicit adoption from creation and recovery. Do not copy the existing replacement arms as a new default; stop if the design requires replacement.
6. Keep mutations single-attempt. Make purge explicit and custody-bound. Test missing state, partial outputs, foreign ownership, create, adoption, update, noop, failure, and deletion where those paths apply.
7. Register the provider in the relevant provider composition. Add only needed exports to `src/index.ts`; exercise them through the package name in `test/consumer/surface.ts`, not private source imports.
8. Run `pnpm check`, `pnpm test`, and relevant approved real-system proof. Plant a bug before trusting a new invariant test. Report known gaps rather than weakening checks or snapshots.

No topology defaults, generic resource factories, or extra API surfaces without a consumer. Finish with the resource identity, ownership rule, preserved behavior, tests run, and remaining live proof.
