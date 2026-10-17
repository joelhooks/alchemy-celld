# Vision

alchemy-celld lets agents and engineers declare self-hosted celld infrastructure in Alchemy. A consumer stack composes a cell, its SeaweedFS object store, user-systemd units, and worker deployments as typed resources.

The provider owns resource contracts, validation, reconciliation, and readback. The consumer owns host inventory, credentials, deployment state, topology, and approval to change live infrastructure. Keep those responsibilities separate.

This is a Linux x86_64 provider, not a fleet manager, application runtime, hosted service, or compatibility promise for every Alchemy beta. It ships TypeScript source; installed consumers need a TypeScript-aware loader or bundler.

Status: package 0.1.3, developed against Alchemy `2.0.0-beta.81` and Effect `4.0.1`. Alchemy is pre-release. Supported peer ranges and runtime limits live in [README.facts.md](README.facts.md); a range is not proof that every admitted version has been tested.

**Public GitHub is a steal-the-ideas surface.** Keep examples useful and invented. Never put private deployment facts here.

The Linux and release providers adapt [taslabs-net/homeflare-kit](https://github.com/taslabs-net/homeflare-kit) at `cf20298`. Its MIT notice remains in `LICENSE-homeflare-kit`. The agent-facing method comes from [rat-stack](https://github.com/joelhooks/rat-stack); [skills/PROVENANCE.md](skills/PROVENANCE.md) records the source.

Read [AGENTS.md](AGENTS.md) for repo law. Start with [uncomplect](skills/uncomplect/SKILL.md) before changing boundaries, or [use-alchemy-celld](skills/use-alchemy-celld/SKILL.md) to declare a consumer stack.
