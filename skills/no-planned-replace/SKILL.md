---
name: no-planned-replace
description: Keep slice limit changes from becoming disruptive restarts. Use when changing systemd limits, reviewing replacement plans, or modifying unit reconciliation. The enforced scope is active slice updates, not a global plan veto.
---

# No planned replace: the slice case

This is a specific case of [uncomplect](../uncomplect/SKILL.md): separate a configuration change from replacing running work.

**Enforced:** `src/systemd.ts` writes changed active slice declarations and daemon-reloads them without issuing restart. Changed non-slice units still restart when required, after a bounded activation wait. Explicit `started: false` still stops a slice.

On 2026-10-17, a generic unit reconcile restarted a slice after its memory cap changed. That restarted every service in the slice. Reloading the declaration applies the limit without replacing those service invocations.

**Not enforced globally:** identity changes still produce replacement plans in file, directory, binary, unit, node, bucket, and deployment providers. `AGENTS.md` lists the source locations. Stop on a planned replacement; this skill is not permission to apply one.

Check `test/unit-restart-safety.test.ts` and the gated `test/systemd-live.test.ts`. The real test requires unchanged member InvocationID and MainPID plus the new MemoryMax. See [the live procedure](../test-against-the-real-thing/SKILL.md). A successful daemon-reload alone is not proof that a member survived.
