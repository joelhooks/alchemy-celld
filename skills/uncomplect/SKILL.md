---
name: uncomplect
description: Separate this provider's responsibilities. Use when simplifying, reviewing architecture, adding a resource or option, or deciding where behavior belongs. Parent skill for the enforced principles.
---

# Uncomplect alchemy-celld

Keep things separate when they change for different reasons. Read `AGENTS.md`, matching agent sources, and the affected tests first. Preserve observed behavior, not accidental coupling.

| Strands                              | Keep apart here                                                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cell and object store                | `src/celld.ts` consumes the bucket output from `src/object-store.ts`. Do not make the cell infer store ownership from an address or run storage maintenance itself.                                      |
| Unit bytes and permission to restart | `src/instance-units.ts` renders declarations. `src/instance-restart-gate.ts` and `src/instance-startup-contract.ts` check operational conditions. A changed digest is not permission to restart a slice. |
| Port layout and host topology        | `src/instance.ts` validates explicit props; `src/host.ts` loads private inventory. Do not encode a real deployment in defaults.                                                                          |
| Resource logic and transport         | `src/providers.ts` uses `HostShell`; `src/ssh.ts` implements transport. A resource should not construct SSH connections or hide transport retries.                                                       |
| Adoption and recovery                | Ownership checks in `src/adoption.ts` constrain recovery credential rotation. Ordinary adoption is not a request to regenerate credentials. Adoption is not globally mutation-free; see the known gaps.  |
| Desired plan and approved apply      | Provider diffs can emit replacement. Stop at the plan; do not treat that action as authorization.                                                                                                        |

Specific cases:

- [No planned replace](../no-planned-replace/SKILL.md): a limit update must not become a slice restart. This is not a global replacement veto.
- [Retain by default](../retain-by-default/SKILL.md): data custody is separate from service lifecycle.
- [Writes never retry](../writes-never-retry/SKILL.md): retry observation, not mutation.
- [Test against the real thing](../test-against-the-real-thing/SKILL.md): a fake's answer is separate from systemd's behavior.

For each proposed change, name the two responsibilities, their source paths, the smallest interface between them, and the behavior check. Remove a wrapper only if it hides no dependency, ownership boundary, or failure. If no check protects the separation, say so. Do not describe a proposed fence as shipped.
