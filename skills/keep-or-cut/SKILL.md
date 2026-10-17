---
name: keep-or-cut
description: Decide what earns a place in alchemy-celld. Use when proposing a resource, option, dependency, test, export, or cleanup, or when extracting consumer-specific code.
---

# Keep or cut alchemy-celld

Read [uncomplect](../uncomplect/SKILL.md) and trace callers before changing the surface.

- A resource earns a place when a real stack needs its lifecycle and ownership contract. A helper is not automatically a resource.
- An option earns a place when a consumer sets it. Name the caller and prove omission preserves the existing behavior.
- A test earns a place when it catches a real failure. State its independent expected result. Plant a bug when adding a new behavior check; restore it before committing.
- An export earns a place when a consumer needs it. Keep explicit exports in `src/index.ts`, not wildcard access to every helper.

## Existing boundaries

- Homeflare-kit's failover and OpenBao integrations are absent by design from this package's source and exports. They are not needed to describe the shipped cell, object store, or deployment. Do not invent a commit that removed them: this repository begins with a standalone extraction.
- Fakes were **not** cut. `src/fake-shell.ts` and fake-provider tests still earn their place by checking ownership, plans, custody, and refusal without touching hosts. They do not establish real systemd behavior.
- Application-specific agent installation and gateway behavior stayed outside the provider. `test/selection.json` records the omitted application-runtime suite and stack-coupled suites. Do not restore them just to grow the test count.
- Complete port maps, explicit adoption, custom gate commands, and the optional store pre-stop flag have consumers and omission checks in `test/consumer/surface.ts` and the corresponding port, adoption, and pre-stop tests. Keep their validation; do not replace explicit inputs with deployment guesses.

For a proposed cut, list callers, exports, dependencies, tests, and the consumer behavior preserved. Delete only within the authorized scope. Run `pnpm check`, `pnpm test`, and the relevant live proof. If removing a feature requires changing unrelated consumers, the boundary needs work before the cut.
