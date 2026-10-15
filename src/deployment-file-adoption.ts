import { Stack } from "alchemy/Stack";
import { State } from "alchemy/State";
import { Effect, Option, Schema } from "effect";

import { ownedPath } from "./adoption.ts";
import { AbsolutePath, textDigest } from "./files.ts";
import type { FileAttributes } from "./files.ts";
import { HostError } from "./host-shell.ts";
import type { Interface } from "./host-shell.ts";

const Owner = Schema.Struct({
  attr: Schema.Struct({
    bindingsFile: Schema.optionalKey(Schema.String),
    bundle: Schema.String,
    configuration: Schema.String,
    directory: AbsolutePath,
  }),
  resourceType: Schema.Literal("Celld.Deployment"),
  status: Schema.Literals(["created", "updated"]),
});

export const legacyDeploymentFile = Effect.fn("Deployment.qualifyStagedFile")(
  function* legacyDeploymentFile(shell: Interface, fqn: string, live: FileAttributes) {
    if (
      !["mailbox-stage-worker", "mailbox-stage-configuration"].includes(fqn) ||
      live.mode !== 0o600
    ) {
      return false;
    }

    const state = yield* Effect.serviceOption(State);
    const stack = yield* Effect.serviceOption(Stack);

    if (Option.isNone(state) || Option.isNone(stack)) {
      return false;
    }

    const store = yield* state.value;

    const owner = yield* Schema.decodeUnknownEffect(Owner)(
      yield* store.get({
        fqn: "mailbox",
        stack: stack.value.name,
        stage: stack.value.stage,
      }),
    ).pipe(Effect.option);

    if (Option.isNone(owner)) {
      return false;
    }

    const { attr } = owner.value;

    const expected =
      fqn === "mailbox-stage-worker"
        ? {
            hash: textDigest(attr.bundle),
            path: `${attr.directory}/worker.mjs`,
          }
        : {
            hash: textDigest(attr.configuration),
            path: `${attr.directory}/${
              attr.bindingsFile === undefined ? "wrangler.json" : "wrangler.public.json"
            }`,
          };

    return (
      live.path === expected.path &&
      live.sha256 === expected.hash &&
      (yield* ownedPath(shell, live.path))
    );
  },
  (effect) =>
    effect.pipe(
      Effect.mapError(
        () =>
          new HostError({
            operation: "adopt",
            reason: "Prior deployment file ownership could not be verified",
          }),
      ),
    ),
);
