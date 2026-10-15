// @effect-diagnostics anyUnknownInErrorContext:off -- Alchemy beta.79's scratch harness declares any errors; this test-only adapter turns them into test defects.
import type { ScratchStack } from "alchemy/Test/Vitest";
import { Effect } from "effect";

export const checkedRead = <P, A, R>(
  reader: { readonly read?: (input: P) => Effect.Effect<A, unknown, R> },
  input: P,
) =>
  reader.read === undefined
    ? Effect.die("Missing provider read port")
    : reader.read(input).pipe(Effect.orDie);

export const checkedStack = (stack: ScratchStack) => ({
  deploy: <A, E, R>(program: Effect.Effect<A, E, R>) => stack.deploy(program).pipe(Effect.orDie),
  destroy: () => stack.destroy().pipe(Effect.orDie),
  plan: <A, E, R>(program: Effect.Effect<A, E, R>) => stack.plan(program).pipe(Effect.orDie),
});
