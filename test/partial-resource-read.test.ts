import { NodeServices } from "@effect/platform-node";
import { State } from "alchemy/State";
import * as Test from "alchemy/Test/Vitest";
import { Arbitrary, Cause, Context, Effect, Exit, Layer, Schema } from "effect";
import { expect } from "vitest";

import { instanceDeleteCustody } from "../src/delete-custody.ts";
import { makeFakeShell } from "../src/fake-shell.ts";
import { textDigest } from "../src/files.ts";
import { HostShell } from "../src/host-shell.ts";
import { instanceLayout } from "./fixture.ts";
import {
  HostDirectory,
  HostDirectoryProvider,
  ReleaseBinary,
  ReleaseBinaryProvider,
} from "../src/providers.ts";
import { ReleaseSource } from "../src/release.ts";
import type { BinaryProps } from "../src/release.ts";
import { checkedRead, checkedStack } from "./checked-stack.ts";

const host = {
  dataRoot: "/srv/example/mailbox",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

const layout = instanceLayout(host, {
  dataRoot: "/srv/example/mischiefrb",
  instance: "mischiefrb",
  portBase: 28_010,
});

const content = "invented pinned binary";

const bytes = new TextEncoder().encode(content);

const binary: BinaryProps = {
  asset: { format: "raw" },
  mode: 0o755,
  path: `${layout.bin}/celld`,
  sha256: textDigest(content),
  size: bytes.byteLength,
  url: "https://github.com/example/tool/releases/download/v1.0.0/tool",
};

class Fake extends Context.Service<Fake, Effect.Success<ReturnType<typeof makeFakeShell>>>()(
  "Test/PartialReadFake",
) {}

const runtime = Layer.effectContext(
  Effect.gen(function* runtime() {
    const fake = yield* makeFakeShell(instanceDeleteCustody(host.home, layout));
    yield* fake.shell.mkdir({ mode: 0o700, path: layout.binaryRoot });
    yield* fake.shell.mkdir({ mode: 0o700, path: layout.bin });

    return Context.make(Fake, fake).pipe(
      Context.add(HostShell, fake.shell),
      Context.add(ReleaseSource, { get: () => Effect.succeed(bytes) }),
    );
  }),
);

const { test } = Test.make({
  providers: Layer.mergeAll(HostDirectoryProvider(), ReleaseBinaryProvider()).pipe(
    Layer.provideMerge(runtime),
    Layer.provideMerge(NodeServices.layer),
    Layer.orDie,
  ),
  stage: "partial-resource-read",
});

test.provider(
  "partial directory and binary reads recover only without recorded output and delete remains custody scoped",
  (scratch) =>
    Effect.gen(function* recovery() {
      const fake = yield* Fake;
      const stack = checkedStack(scratch);

      const state = yield* State.pipe(Effect.flatten, Effect.provide(scratch.state));

      const result = yield* Arbitrary.checkEffect(
        Arbitrary.schema(Schema.String.check(Schema.isUUID(4))),
        (uuid) =>
          Effect.gen(function* cycle() {
            for (const kind of ["directory", "binary"]) {
              const program = Effect.gen(function* program() {
                return kind === "directory"
                  ? yield* HostDirectory("candidate", {
                      mode: 0o700,
                      path: layout.configuration,
                    })
                  : yield* ReleaseBinary("candidate", binary);
              });

              for (const recorded of [false, true]) {
                yield* stack.destroy();

                const row = {
                  bindings: [],
                  downstream: [],
                  fqn: "candidate",
                  instanceId: uuid.toLowerCase(),
                  logicalId: "candidate",
                  namespace: undefined,
                  props: kind === "directory" ? { mode: 0o700 } : { path: binary.path },
                  providerVersion: 0,
                  resourceType:
                    kind === "directory" ? "LinuxHost.HostDirectory" : "LinuxHost.ReleaseBinary",
                };

                if (recorded) {
                  const output = yield* stack.deploy(program);
                  yield* state.set({
                    fqn: "candidate",
                    stack: scratch.name,
                    stage: scratch.stage,
                    value: { ...row, attr: output, status: "created" },
                  });

                  const attempt = yield* Effect.gen(function* readRecorded() {
                    if (kind === "directory") {
                      const provider = yield* HostDirectory.Provider;

                      if (provider.read === undefined) {
                        return yield* Effect.die("Missing directory read port");
                      }

                      return yield* checkedRead(provider, {
                        fqn: "candidate",
                        id: "candidate",
                        instanceId: row.instanceId,
                        olds: { mode: 0o700, path: "invalid" },
                        output,
                      });
                    }

                    const provider = yield* ReleaseBinary.Provider;

                    if (provider.read === undefined || !("sha256" in output)) {
                      return yield* Effect.die("Missing binary read port or output");
                    }

                    return yield* checkedRead(provider, {
                      fqn: "candidate",
                      id: "candidate",
                      instanceId: row.instanceId,
                      olds: { ...binary, path: "invalid" },
                      output,
                    });
                  }).pipe(Effect.exit);

                  expect(Exit.isFailure(attempt)).toBe(true);

                  if (Exit.isFailure(attempt)) {
                    expect(Cause.pretty(attempt.cause)).toContain(
                      kind === "directory"
                        ? "Invalid directory declaration"
                        : "Release assets require a pinned",
                    );
                  }
                } else {
                  yield* state.set({
                    fqn: "candidate",
                    stack: scratch.name,
                    stage: scratch.stage,
                    value: { ...row, status: "creating" },
                  });
                  const plan = yield* stack.plan(program);
                  expect(plan.resources.candidate?.action).toBe("create");
                  yield* stack.deploy(program);
                }

                yield* stack.destroy();
                expect(
                  yield* fake.shell.stat(kind === "directory" ? layout.configuration : binary.path),
                ).toBeUndefined();
                expect(yield* fake.shell.stat(`${host.home}/.config/celld`)).toBeDefined();
              }
            }

            return true;
          }),
        { runs: 4 },
      );

      expect(result._tag, Arbitrary.formatCheckFailure(result)).toBe("Passed");
    }),
);
