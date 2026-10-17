---
name: writes-never-retry
description: Keep mutation single-attempt and retries around readback only. Use when adding retries, SSH operations, deployment calls, bucket mutations, or failure recovery.
---

# Writes never retry automatically

A specific case of [uncomplect](../uncomplect/SKILL.md): separate observing completion from repeating a mutation.

The shipped transport in `src/ssh.ts` executes each command once. Filesystem mutations in `src/files.ts` and `src/systemd.ts` do not wrap writes in retry. `src/bucket-api.ts` retries bucket observation, not create or purge. `src/deployment.ts` calls deploy and reload once, then retries version readback for up to 60 seconds.

A lost response does not prove a write failed. Blind replay can repeat work after it already happened. Inspect live state before deciding whether to run reconciliation again.

This rule concerns automatic retries inside the shipped provider. It does not guarantee exactly-once execution across process crashes, an external caller's retries, or a custom HostShell implementation. Cleanup and explicitly authorized recovery are separate operations, not transport retries.

Check each retry boundary: its body must contain only observation. Run `pnpm test`, including provider lifecycle, bucket recovery, deployment, and restart-safety tests. When adding a mutation path, count write attempts under a failed response and require one. Current absence of retry wrappers is not a static ban on future wrappers; review the diff.
