import type { PlanStatusSession } from "alchemy/Report";
import { Console, Effect, Exit, Predicate, Runtime, Schema } from "effect";

import type { Interface } from "./host-shell.ts";
import { instanceGoneScript } from "./instance-probe-scripts.ts";

export type DeleteStatus = "deleted" | "failed" | "skipped";

export const withDestroyReceipt = <A, E, R>(
  resources: readonly string[],
  run: (session: PlanStatusSession) => Effect.Effect<A, E, R>,
  write: (line: string) => Effect.Effect<void> = Console.log,
) =>
  Effect.gen(function* receipt() {
    const states = new Map<string, DeleteStatus>(resources.map((name) => [name, "skipped"]));

    const session: PlanStatusSession = {
      done: () => Effect.void,
      emit: (event) =>
        Effect.sync(() => {
          if (!Predicate.isTagged(event, "apply.resource.status") || !states.has(event.fqn)) {
            return;
          }

          if (event.status === "deleted") {
            states.set(event.fqn, "deleted");
          } else if (event.status === "fail") {
            states.set(event.fqn, "failed");
          } else if (event.status === "skipped") {
            states.set(event.fqn, "skipped");
          }
        }),
    };

    return yield* run(session).pipe(
      Effect.onExit(() =>
        Effect.forEach(
          [...states].toSorted(([left], [right]) => left.localeCompare(right)),
          ([name, status]) => write(`${status} ${name}`),
          { discard: true },
        ),
      ),
    );
  });

export const verifyInstanceGone = Effect.fn("InstanceProbe.verifyGone")(function* verify(
  shell: Interface,
  home: string,
  dataRoot: string,
  pids: Readonly<Record<string, number>>,
) {
  const result = yield* shell
    .exec(["python3", "-c", instanceGoneScript, home, dataRoot, JSON.stringify(pids)])
    .pipe(
      Effect.catchTag("HostError", () =>
        Effect.succeed({ code: 1, stdout: "FAIL probe execution" }),
      ),
    );

  yield* Console.log(result.stdout.trimEnd());

  return result.code;
});

export const probeTeardown: Runtime.Teardown = (exit, onExit) => {
  if (
    Exit.isSuccess(exit) &&
    Schema.is(Schema.Int.check(Schema.isBetween({ maximum: 255, minimum: 0 })))(exit.value)
  ) {
    onExit(exit.value);
  } else {
    Runtime.defaultTeardown(exit, onExit);
  }
};
