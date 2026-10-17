---
name: retain-by-default
description: Keep data purge explicit. Use when changing delete behavior, storage ownership, adoption, purge options, or destroy plans.
---

# Retain data by default

A specific case of [uncomplect](../uncomplect/SKILL.md): service lifecycle does not grant authority to erase data.

`src/object-store.ts` and `src/celld.ts` default `purgeOnDelete` to false. `src/files.ts` removes a non-purge directory with rmdir, which refuses nonempty data. `src/bucket-api.ts` defaults to ordinary bucket delete, not recursive purge; a nonempty bucket must be drained explicitly. Adoption cannot grant purge authority to existing directories or buckets.

This is a non-purge default, not a promise that destroy leaves every resource intact. Units and configuration can be removed, empty directories and buckets can be deleted, and a failed deletion can leave partial teardown. Inspect the whole destroy plan.

Explicit purge also needs the declared owned root and custody checks in `src/delete-custody.ts`, `src/files.ts`, and `src/bucket-api.ts`. Never widen custody to force deletion through. The disposable instance probe deliberately opts into purge; do not copy that setting into a data-bearing stack.

Check `test/store-node.test.ts` for owned-root and symlink refusal, `test/instance-destroy.test.ts` for teardown paths, and `test/instance-bootstrap-custody.test.ts` for bootstrap boundaries. Run `pnpm test`. Live deletion proof requires separate approval and disposable data; unit tests do not authorize destruction.
