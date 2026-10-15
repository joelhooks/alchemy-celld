import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { HostError } from "./host-error.ts";
import type { Interface } from "./host-shell.ts";

export const localExec = Effect.gen(function* localExec() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return {
    exec: Effect.fn("HostShell.localExec")(
      function* exec(argv) {
        const [command, ...args] = argv;

        if (command === undefined) {
          return yield* new HostError({
            operation: "exec",
            reason: "Empty command",
          });
        }

        const handle = yield* spawner.spawn(ChildProcess.make(command, args));

        const result = yield* Effect.all(
          {
            code: handle.exitCode,
            stderr: Stream.runDrain(handle.stderr),
            stdout: Stream.runCollect(handle.stdout),
          },
          { concurrency: "unbounded" },
        );

        return {
          code: Number(result.code),
          stdout: Buffer.concat(result.stdout).toString("utf-8"),
        };
      },
      Effect.scoped,
      Effect.mapError(() => new HostError({ operation: "exec", reason: "Local command failed" })),
    ),
  } satisfies Pick<Interface, "exec">;
});
