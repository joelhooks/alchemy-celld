import { Context, Effect, Layer } from "effect";
import type { Redacted } from "effect";

import type { DeleteCustody } from "./delete-custody.ts";
import { HostError } from "./host-error.ts";

export { HostError } from "./host-error.ts";

export interface Entry {
  readonly kind: "file" | "directory";
  readonly mode: number;
}

export interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr?: string;
}

export interface Diagnostics {
  readonly redactions: readonly Redacted.Redacted[];
}

export interface Interface {
  readonly deleteCustody?: DeleteCustody | undefined;
  readonly purgeRoots: readonly string[];
  readonly checksum?: (path: string) => Effect.Effect<string, HostError>;
  readonly exec: (
    argv: readonly string[],
    diagnostics?: Diagnostics,
  ) => Effect.Effect<Result, HostError>;
  readonly read: (path: string) => Effect.Effect<Uint8Array | undefined, HostError>;
  readonly stat: (path: string) => Effect.Effect<Entry | undefined, HostError>;
  readonly write: (input: {
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly mode: number;
  }) => Effect.Effect<void, HostError>;
  readonly remove: (path: string) => Effect.Effect<void, HostError>;
  readonly mkdir: (input: {
    readonly path: string;
    readonly mode: number;
  }) => Effect.Effect<void, HostError>;
  readonly rmdir: (path: string) => Effect.Effect<void, HostError>;
}

export class HostShell extends Context.Service<HostShell, Interface>()(
  "@alchemy-celld/HostShell",
) {}

export const must = Effect.fn("HostShell.must")(function* must(
  shell: Pick<Interface, "exec">,
  argv: readonly string[],
) {
  const result = yield* shell.exec(argv);

  if (result.code !== 0) {
    return yield* new HostError({
      operation: "exec",
      reason: "Remote command failed; values redacted.",
    });
  }

  return result.stdout;
});

export const testLayer = (shell: Interface) => Layer.succeed(HostShell, shell);
