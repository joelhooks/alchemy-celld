---
name: test-against-the-real-thing
description: Prove systemd behavior on a real user manager. Use when changing lifecycle, activation waiting, slice limits, restart safety, or claiming that a deployment works.
---

# Test against the real thing

A specific case of [uncomplect](../uncomplect/SKILL.md): keep a model's answer separate from the platform's behavior.

`test/systemd-live.test.ts` uses real local transport and user-systemd, not a fake manager. Its slice test asserts unchanged member InvocationID and MainPID after a MemoryMax update. Its activation test observes the real state before restart and requires active, not activating. Both remove their unique units in a finalizer.

The slice incident showed why: ordinary unit reconciliation can look correct in a fake while restarting every member service on the real manager. The 0.1.3 fix needs both byte-level checks and process-identity evidence.

Run on an approved, non-root Linux user manager:

```sh
FLEET_LIVE_NODE=local FLEET_START_APPROVED=true ALCHEMY_TELEMETRY_DISABLED=1 pnpm exec vitest run --config vitest.config.ts test/systemd-live.test.ts
```

This always targets the local manager. It creates throwaway units but does not deploy celld. Do not run it under unrelated live approval. Confirm finalizer cleanup; report leftovers rather than deleting unfamiliar units.

The assertions are enforced **when this gated suite runs**. Default `pnpm test` skips it without both variables. There is no mandatory live release gate. Live proof for broader celld deployment uses the separate instance probe described in `AGENTS.md`, with its own private inputs and destructive approvals. A passing systemd test is not proof that celld, storage, or a consumer stack is healthy.

When adding a platform assertion, remove the relevant guard temporarily and confirm the test fails. Restore it and rerun. Keep mutation receipts private; commit only generic fixtures and checks.
