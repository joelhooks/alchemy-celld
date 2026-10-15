import { NodePath, NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Cli } from "alchemy/Report";
import { State } from "alchemy/State";
import * as Test from "alchemy/Test/Vitest";
import { Arbitrary, Cause, Context, Effect, Exit, Layer, Match, Predicate, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { Celld } from "../src/celld.ts";
import {
  assertDeletePath,
  assertDeleteUnit,
  deploymentDeleteRoot,
  instanceDeleteCustody,
} from "../src/delete-custody.ts";
import { deleteDeployment } from "../src/deployment.ts";
import { makeFakeShell } from "../src/fake-shell.ts";
import { textDigest } from "../src/files.ts";
import { HostShell } from "../src/host-shell.ts";
import { renderUnits } from "../src/index.ts";
import { deleteDirectory, deleteFile } from "../src/instance-files.ts";
import { declaredListeners, startupLayer, InstanceNameSchema, instanceLayout } from "./fixture.ts";
import { instanceGoneScript } from "../src/instance-probe-scripts.ts";
import {
  instanceProbeProgram,
  probeIdentity,
  probeUnitLimits,
} from "../src/instance-probe-stack.ts";
import { localExec } from "../src/local-exec.ts";
import { ObjectStore } from "../src/object-store.ts";
import { withDestroyReceipt } from "../src/probe-receipts.ts";
import { ReleaseBinary } from "../src/providers.ts";
import { ReleaseSource } from "../src/release.ts";
import { s3Script } from "../src/s3-script.ts";
import { deleteUnit } from "../src/systemd.ts";
import { storeSocketScript } from "../src/unit-cleanup.ts";
import { checkedRead, checkedStack } from "./checked-stack.ts";
import { BucketFixture } from "./instance-bucket-model.ts";
import { goneFixture } from "./instance-teardown-model.ts";
import type { WorkerMode } from "./instance-worker-model.ts";
import { isWorkerInstall, WorkerFixture } from "./instance-worker-model.ts";

const host = {
  dataRoot: "/srv/example/mailbox",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

const layoutFor = (instance: string) =>
  instanceLayout(host, {
    dataRoot: `/srv/example/${instance}`,
    instance,
    portBase: 28_010,
  });

it.effect.prop(
  "named delete custody accepts only its layout and refuses default and every other instance before effects",
  {
    names: Arbitrary.schema(
      Schema.Tuple([InstanceNameSchema, InstanceNameSchema]).check(
        Schema.makeFilter(([own, other]) => own !== other),
      ),
    ),
    suffix: Arbitrary.schema(
      Schema.String.check(Schema.makeFilter((value) => !value.startsWith("bootstrap-"))),
    ),
  },
  ({ names: [own, other], suffix }) =>
    Effect.gen(function* custodyProperty() {
      const fake = yield* makeFakeShell();
      const layout = layoutFor(own);
      const custody = instanceDeleteCustody(host.home, layout);

      const shell = {
        ...fake.shell,
        deleteCustody: custody,
        purgeRoots: [layout.configuration, layout.binaryRoot, layout.dataRoot],
      };

      for (const path of custody.files) {
        expect(yield* assertDeletePath(shell, path, "files").pipe(Effect.isSuccess)).toBe(true);
      }

      for (const path of custody.directories) {
        expect(yield* assertDeletePath(shell, path, "directories").pipe(Effect.isSuccess)).toBe(
          true,
        );
      }

      for (const name of custody.units) {
        expect(
          yield* assertDeleteUnit(shell, { home: host.home, name }).pipe(Effect.isSuccess),
        ).toBe(true);
      }

      expect(deploymentDeleteRoot(shell, `${layout.configuration}/deployment`)).toBe(
        layout.configuration,
      );
      expect(
        deploymentDeleteRoot(shell, `${host.home}/.config/celld/mailbox-deployment`),
      ).toBeUndefined();

      const strangers = [
        instanceDeleteCustody(host.home, instanceLayout(host, {})),
        instanceDeleteCustody(host.home, layoutFor(other)),
      ];

      for (const foreign of strangers) {
        for (const path of [
          ...foreign.directories,
          `${host.home}/.config/celld/mailbox-deployment`,
        ]) {
          expect(yield* deleteDirectory(shell, { mode: 0o700, path }).pipe(Effect.isFailure)).toBe(
            true,
          );
        }

        for (const path of foreign.files) {
          expect(
            yield* deleteFile(shell, {
              mode: 0o600,
              path,
              sha256: "0".repeat(64),
            }).pipe(Effect.isFailure),
          ).toBe(true);
        }

        for (const name of foreign.units) {
          expect(
            yield* deleteUnit(shell, {
              active: true,
              configSha256: "0".repeat(64),
              enabled: true,
              home: host.home,
              name,
              needDaemonReload: false,
              path: `${host.home}/.config/systemd/user/${name}`,
              scope: "user",
              sha256: "0".repeat(64),
            }).pipe(Effect.isFailure),
          ).toBe(true);
        }

        expect(
          deploymentDeleteRoot(shell, `${foreign.layout.configuration}/deployment`),
        ).toBeUndefined();
      }

      const candidate = `${layout.configuration}/${suffix}`;
      expect(yield* assertDeletePath(shell, candidate, "files").pipe(Effect.isSuccess)).toBe(
        custody.files.includes(candidate),
      );
      expect(yield* fake.calls()).toEqual([]);
    }),
);

const probeLayout = layoutFor("mischiefrb");

it.effect.prop(
  "delete with partial olds and no output is a no-op before any host effect",
  { directory: Arbitrary.schema(Schema.String) },
  ({ directory }) =>
    Effect.gen(function* partialDelete() {
      const fake = yield* makeFakeShell(instanceDeleteCustody(host.home, probeLayout));

      yield* deleteDeployment(fake.shell, {
        olds: {
          binary: `${probeLayout.bin}/celld`,
          bundle: "not deployed",
          commit: "example",
          configuration: "{}",
          directory,
          environmentFile: `${probeLayout.configuration}/celld.env`,
          version: "example",
        },
      });

      expect(yield* fake.calls()).toEqual([]);
    }),
);

class Fake extends Context.Service<Fake, Effect.Success<ReturnType<typeof makeFakeShell>>>()(
  "Test/InstanceDestroyFake",
) {}

const runtime = Layer.effectContext(
  Effect.gen(function* runtime() {
    const custody = instanceDeleteCustody(host.home, probeLayout);
    const fake = yield* makeFakeShell(custody);

    yield* fake.shell.mkdir({ mode: 0o700, path: "/srv/example/mailbox" });
    let bucketExists = false;
    const objects = new Set<string>();
    const requests: string[] = [];
    let worker: typeof WorkerMode.Type = "bootstrap";
    let installs = 0;

    const shell = {
      ...fake.shell,
      deleteCustody: custody,
      exec: (argv: readonly string[]) => {
        if (isWorkerInstall(argv)) {
          worker = "installed";
          installs += 1;
        }

        if (argv[0] === "systemd-run") {
          return Effect.succeed({ code: 0, stdout: "bootstrap deployed" });
        }

        if (argv[0] === "ss") {
          return Effect.gen(function* listeners() {
            const node = yield* fake.shell.exec([
              "systemctl",
              "--user",
              "is-active",
              probeLayout.nodeUnit,
            ]);

            const text = declaredListeners("127.0.0.1", node.code === 0, false, probeLayout)
              .map(
                ({ address, port, unit }) =>
                  `LISTEN 0 128 ${address}:${port} 0.0.0.0:* cgroup:/${probeLayout.slice}/${unit}`,
              )
              .join("\n");

            return { code: 0, stdout: text };
          });
        }

        if (argv[2] === s3Script) {
          const operation = argv[6] ?? "";

          requests.push(operation);

          if (operation === "create") {
            bucketExists = true;
          }

          let status = bucketExists ? 200 : 404;

          if (operation === "purge" || operation === "delete") {
            status = operation === "delete" && objects.size > 0 ? 409 : 204;

            if (status === 204) {
              bucketExists = false;
              objects.clear();
            }
          }

          return Effect.succeed({
            code: 0,
            stdout: JSON.stringify({
              status: argv[6] === "pointer" || (argv[6] === "read" && !bucketExists) ? 404 : status,
              version: "",
            }),
          });
        }

        if (
          argv[0] === "sh" ||
          argv[0] === "curl" ||
          (argv[0] === "python3" &&
            argv[2] ===
              storeSocketScript
                .replace("seaweedfs-s3-31006.sock", "seaweedfs-s3-28016.sock")
                .replace("seaweedfs-s3-grpc-31007.sock", "seaweedfs-s3-grpc-28017.sock"))
        ) {
          return Effect.succeed({ code: 0, stdout: "ready" });
        }

        return fake.shell.exec(argv);
      },
      purgeRoots: [probeLayout.configuration, probeLayout.binaryRoot, probeLayout.dataRoot],
    };

    return Context.make(Fake, fake).pipe(
      Context.add(BucketFixture, {
        clearRequests: Effect.sync(() => {
          requests.length = 0;
        }),
        drain: Effect.sync(() => {
          objects.clear();
        }),
        objects: Effect.sync(() => [...objects]),
        put: (key) =>
          Effect.sync(() => {
            objects.add(key);
          }),
        requests: Effect.sync(() => [...requests]),
      }),
      Context.add(HostShell, shell),
      Context.add(WorkerFixture, {
        installs: Effect.sync(() => installs),
        set: (mode) =>
          Effect.sync(() => {
            worker = mode;
          }),
      }),
      Context.add(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          if (worker === "transport") {
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request }),
              }),
            );
          }

          const body = Match.value(worker).pipe(
            Match.when("bootstrap", () => "celld bootstrap"),
            Match.when("wrong", () => JSON.stringify({ commit: "other", version: "other" })),
            Match.when("invalid-schema", () => JSON.stringify({ unexpected: true })),
            Match.orElse(() => JSON.stringify(probeIdentity)),
          );

          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(body, {
                status: worker === "unavailable" ? 503 : 200,
              }),
            ),
          );
        }),
      ),
    );
  }),
);

const binaryProvider = Provider.effect(
  ReleaseBinary,
  Effect.gen(function* provider() {
    const shell = yield* HostShell;

    return ReleaseBinary.Provider.of({
      delete: ({ output }) => deleteFile(shell, output),
      list: () => Effect.succeed([]),
      read: ({ output }) => Effect.succeed(output),
      reconcile: ({ news }) =>
        Effect.gen(function* install() {
          const content = "invented pinned binary";
          yield* shell.write({
            bytes: new TextEncoder().encode(content),
            mode: 0o755,
            path: news.path,
          });

          return { mode: 0o755, path: news.path, sha256: textDigest(content) };
        }),
    });
  }),
);

const startupRuntime = Layer.unwrap(
  Effect.gen(function* startupRuntime() {
    const shell = yield* HostShell;

    return startupLayer(
      "127.0.0.1",
      "scope",
      `${probeLayout.dataRoot}/.mailbox-restore-objects.tar`,
      shell.write({
        bytes: new TextEncoder().encode("invented restored objects"),
        mode: 0o600,
        path: `${probeLayout.dataRoot}/.mailbox-restore-objects.tar`,
      }),
      probeLayout,
    );
  }),
).pipe(Layer.provideMerge(runtime), Layer.provideMerge(NodeServices.layer));

const { test } = Test.make({
  providers: Layer.mergeAll(
    ObjectStore.providers(),
    Celld.providers(),
    Celld.deploymentProvider(),
    binaryProvider,
  ).pipe(
    Layer.provideMerge(startupRuntime),
    Layer.provide(NodePath.layer),
    Layer.provide(
      Layer.succeed(ReleaseSource, {
        get: () => Effect.die("Offline destroy must not download"),
      }),
    ),
    Layer.orDie,
  ),
  stage: "instance-destroy",
});

test.provider(
  "offline destroy-plan and real provider teardown leave only mailbox resources",
  (scratch) =>
    Effect.gen(function* teardown() {
      const fake = yield* Fake;
      const stack = checkedStack(scratch);

      const fresh = yield* stack.plan(instanceProbeProgram(host, probeLayout.dataRoot));

      expect(fresh.resources["store/config-root"]?.downstream).toContain(
        "mischiefrb-deployment-stage-directory",
      );

      yield* stack.deploy(instanceProbeProgram(host, probeLayout.dataRoot));

      const units = renderUnits(
        { ...host, tailnetIPv4: "127.0.0.1" },
        {
          dataRoot: probeLayout.dataRoot,
          instance: "mischiefrb",
          portBase: 28_010,
          restartGate: true,
        },
        probeUnitLimits,
      );

      expect(units).toHaveLength(5);

      for (const unit of units) {
        const bytes = yield* fake.shell.read(unit.path);

        expect(new TextDecoder().decode(bytes)).toBe(unit.text);
      }

      yield* fake.shell.write({
        bytes: new TextEncoder().encode("invented data"),
        mode: 0o600,
        path: `${probeLayout.dataRoot}/seaweedfs/volume.dat`,
      });

      const plan = yield* Plan.destroy({
        name: scratch.name,
        stage: scratch.stage,
      }).pipe(Effect.provide(scratch.state));

      expect(Object.keys(plan.deletions).length).toBeGreaterThan(20);

      const DeletionSurface = Schema.Record(
        Schema.String,
        Schema.Struct({
          state: Schema.Struct({
            attr: Schema.Struct({
              directory: Schema.optionalKey(Schema.String),
              name: Schema.optionalKey(Schema.String),
              path: Schema.optionalKey(Schema.String),
            }),
          }),
        }),
      );

      const surface = yield* Schema.decodeEffect(Schema.fromJsonString(DeletionSurface))(
        JSON.stringify(plan.deletions),
      );

      const text = JSON.stringify(surface);
      expect(text).toContain("mischiefrb.slice");
      expect(text).toContain("mischiefrb-seaweedfs.service");
      expect(text).toContain("mischiefrb-celld.service");

      for (const value of [
        "celld.slice",
        "celld-celld.service",
        "celld-seaweedfs.service",
        "/.config/celld",
        "/.local/share/celld",
      ]) {
        expect(text).not.toContain(value);
      }

      yield* fake.clear();
      yield* stack.destroy();

      for (const path of [
        ...instanceDeleteCustody(host.home, probeLayout).directories,
        ...instanceDeleteCustody(host.home, probeLayout).files,
      ]) {
        expect(yield* fake.shell.stat(path)).toBeUndefined();
      }

      expect(yield* fake.shell.stat(host.dataRoot)).toBeDefined();

      const mutations = (yield* fake.calls()).filter(
        ({ operation }) => operation === "remove" || operation === "rmdir",
      );

      expect(mutations.every(({ argv }) => argv[0]?.includes("mischiefrb") === true)).toBe(true);
    }),
);

test.provider(
  "custody-enabled fresh deploy executes bootstrap and restore cleanup, then destroys interrupted bootstrap leftovers",
  (scratch) =>
    Effect.gen(function* interruptedBootstrap() {
      const fake = yield* Fake;
      const stack = checkedStack(scratch);

      const result = yield* Arbitrary.checkEffect(
        Arbitrary.schema(
          Schema.Struct({
            files: Schema.Array(Schema.Literals(["index.js", "wrangler.json"])),
            uuid: Schema.String.check(Schema.isUUID(4)),
          }),
        ),
        ({ files, uuid }) =>
          Effect.gen(function* cycle() {
            yield* stack.destroy();
            yield* fake.clear();
            yield* stack.deploy(instanceProbeProgram(host, probeLayout.dataRoot));

            const calls = yield* fake.calls();

            const bootstrap = calls.find(
              ({ operation, argv }) =>
                operation === "rmdir" &&
                argv[0]?.startsWith(`${probeLayout.configuration}/bootstrap-`) === true,
            )?.argv[0];

            expect(bootstrap).toBeDefined();
            expect(
              calls.some(
                ({ operation, argv }) =>
                  operation === "remove" &&
                  argv[0] === `${probeLayout.dataRoot}/.mailbox-restore-objects.tar`,
              ),
            ).toBe(true);
            expect(
              calls.some(
                ({ operation, argv }) =>
                  operation === "remove" && argv[0] === `${bootstrap}/index.js`,
              ),
            ).toBe(true);
            expect(
              calls.some(
                ({ operation, argv }) =>
                  operation === "remove" && argv[0] === `${bootstrap}/wrangler.json`,
              ),
            ).toBe(true);

            const leftover = `${probeLayout.configuration}/bootstrap-${uuid.toLowerCase()}`;
            yield* fake.shell.mkdir({ mode: 0o700, path: leftover });

            for (const name of files) {
              yield* fake.shell.write({
                bytes: new TextEncoder().encode("interrupted bootstrap"),
                mode: 0o600,
                path: `${leftover}/${name}`,
              });
            }

            yield* stack.destroy();
            expect(yield* fake.shell.stat(probeLayout.configuration)).toBeUndefined();
            expect(yield* fake.shell.stat(leftover)).toBeUndefined();
            expect(yield* fake.shell.stat(host.dataRoot)).toBeDefined();

            return true;
          }),
        { runs: 8 },
      );

      expect(result._tag, Arbitrary.formatCheckFailure(result)).toBe("Passed");
    }),
);

test.provider(
  "exact partial creating worker resumes without output and rejects invalid olds with recorded output",
  (scratch) =>
    Effect.gen(function* interruptedWorker() {
      const fake = yield* Fake;
      const stack = checkedStack(scratch);

      const state = yield* State.pipe(Effect.flatten, Effect.provide(scratch.state));

      const program = instanceProbeProgram(host, probeLayout.dataRoot);

      const partial = {
        binary: `${probeLayout.bin}/celld`,
        bundle: `export default { fetch() { return Response.json(${JSON.stringify(probeIdentity)}); } };`,
        commit: probeIdentity.commit,
        configuration: JSON.stringify({
          compatibility_date: "2026-10-04",
          compatibility_flags: [],
          durable_objects: { bindings: [] },
          main: "worker.mjs",
          migrations: [],
          name: "mischiefrb",
          no_bundle: true,
          vars: {},
        }),
        directory: `${probeLayout.configuration}/deployment`,
        environmentFile: `${probeLayout.configuration}/celld.env`,
        version: probeIdentity.version,
      };

      const result = yield* Arbitrary.checkEffect(
        Arbitrary.schema(Schema.String.check(Schema.isUUID(4))),
        (uuid) =>
          Effect.gen(function* cycle() {
            for (const mode of ["resume", "recorded-output", "destroy-creating"]) {
              yield* stack.destroy();

              const row = {
                bindings: [],
                downstream: [],
                fqn: "worker",
                instanceId: uuid.toLowerCase(),
                logicalId: "worker",
                namespace: undefined,
                props: partial,
                providerVersion: 0,
                resourceType: "Celld.Deployment",
              };

              if (mode === "resume") {
                yield* state.set({
                  fqn: "worker",
                  stack: scratch.name,
                  stage: scratch.stage,
                  value: { ...row, status: "creating" },
                });
                yield* state.set({
                  fqn: "celld/node",
                  stack: scratch.name,
                  stage: scratch.stage,
                  value: {
                    ...row,
                    fqn: "celld/node",
                    logicalId: "node",
                    namespace: undefined,
                    props: {
                      home: host.home,
                      name: probeLayout.nodeUnit,
                      scope: "user",
                    },
                    resourceType: "Celld.Node",
                    status: "creating",
                  },
                });

                const plan = yield* stack.plan(program);
                expect(plan.resources.worker?.action).toBe("create");
                const output = yield* stack.deploy(program);
                expect(output.internalUrl).toBe(`http://127.0.0.1:${probeLayout.ports.internal}`);
              } else {
                const output = yield* stack.deploy(program);

                yield* state.set({
                  fqn: "worker",
                  stack: scratch.name,
                  stage: scratch.stage,
                  value:
                    mode === "recorded-output"
                      ? { ...row, attr: output, status: "created" }
                      : { ...row, status: "creating" },
                });

                if (mode === "recorded-output") {
                  const provider = yield* Celld.Deployment.Provider;

                  if (provider.read === undefined) {
                    return yield* Effect.die("Missing deployment read port");
                  }

                  const attempt = yield* checkedRead(provider, {
                    fqn: "worker",
                    id: "worker",
                    instanceId: row.instanceId,
                    olds: { ...output, internalUrl: "invalid" },
                    output,
                  }).pipe(Effect.exit);

                  expect(Exit.isFailure(attempt)).toBe(true);

                  if (Exit.isFailure(attempt)) {
                    expect(
                      yield* Schema.decodeUnknownEffect(
                        Schema.Struct({
                          _tag: Schema.Literal("DeploymentError"),
                          reason: Schema.Literal("Invalid internal listener URL"),
                        }),
                      )(Cause.squash(attempt.cause)).pipe(Effect.isSuccess),
                    ).toBe(true);
                  }
                } else {
                  const teardown = yield* Plan.destroy({
                    name: scratch.name,
                    stage: scratch.stage,
                  }).pipe(Effect.provide(scratch.state));

                  expect(Object.keys(teardown.deletions).length).toBe(24);
                }
              }

              yield* stack.destroy();
              expect(yield* fake.shell.stat(probeLayout.configuration)).toBeUndefined();
              expect(yield* fake.shell.stat(host.dataRoot)).toBeDefined();
            }

            return true;
          }),
        { runs: 4 },
      );

      expect(result._tag, Arbitrary.formatCheckFailure(result)).toBe("Passed");
    }),
);

test.provider(
  "destroy exact worker and node creating rows from full and independently reduced host sets",
  (scratch) =>
    Effect.gen(function* partialHost() {
      const fake = yield* Fake;

      const stack = checkedStack(scratch);

      const state = yield* State.pipe(Effect.flatten, Effect.provide(scratch.state));

      const result = yield* Arbitrary.checkEffect(
        Arbitrary.schema(Schema.String.check(Schema.isUUID(4))),
        (uuid) =>
          Effect.gen(function* cycle() {
            for (const reduced of [false, true]) {
              yield* stack.destroy();

              const output = yield* stack.deploy(instanceProbeProgram(host, probeLayout.dataRoot));

              const units = [
                probeLayout.nodeUnit,
                ...(reduced ? [probeLayout.retentionUnit, probeLayout.retentionTimer] : []),
              ];

              for (const name of units) {
                yield* fake.shell.exec(["systemctl", "--user", "stop", name]);
                yield* fake.shell.exec(["systemctl", "--user", "disable", name]);
                yield* fake.shell.remove(`${host.home}/.config/systemd/user/${name}`);
              }

              yield* fake.shell.exec(["systemctl", "--user", "daemon-reload"]);

              if (reduced) {
                for (const fqn of ["store/storage-retention", "store/storage-retention-timer"]) {
                  yield* state.delete({
                    fqn,
                    stack: scratch.name,
                    stage: scratch.stage,
                  });
                }
              }

              const row = {
                bindings: [],
                downstream: [],
                instanceId: uuid.toLowerCase(),
                namespace: undefined,
                providerVersion: 0,
              };

              yield* state.set({
                fqn: "worker",
                stack: scratch.name,
                stage: scratch.stage,
                value: {
                  ...row,
                  fqn: "worker",
                  logicalId: "worker",
                  props: {
                    binary: output.binary,
                    bundle: output.bundle,
                    commit: output.commit,
                    configuration: output.configuration,
                    directory: output.directory,
                    environmentFile: output.environmentFile,
                    version: output.version,
                  },
                  resourceType: "Celld.Deployment",
                  status: "creating",
                },
              });
              yield* state.set({
                fqn: "celld/node",
                stack: scratch.name,
                stage: scratch.stage,
                value: {
                  ...row,
                  fqn: "celld/node",
                  logicalId: "node",
                  props: {
                    home: host.home,
                    name: probeLayout.nodeUnit,
                    scope: "user",
                  },
                  resourceType: "Celld.Node",
                  status: "creating",
                },
              });

              const plan = yield* Plan.destroy({
                name: scratch.name,
                stage: scratch.stage,
              }).pipe(Effect.provide(scratch.state));

              expect(Object.keys(plan.deletions).length).toBe(reduced ? 22 : 24);
              yield* stack.destroy();

              for (const path of [
                ...instanceDeleteCustody(host.home, probeLayout).files,
                ...instanceDeleteCustody(host.home, probeLayout).directories,
              ]) {
                expect(yield* fake.shell.stat(path)).toBeUndefined();
              }

              const world = {
                commands: false,
                directory: false,
                inactive: false,
                link: false,
                listener: false,
                loaded: false,
                pid: false,
                slice: false,
                socket: false,
                units: false,
              };

              for (const name of instanceDeleteCustody(host.home, probeLayout).units) {
                const status = yield* fake.shell.exec(["systemctl", "--user", "show", name]);

                world.loaded ||= status.stdout.includes("LoadState=loaded");
              }

              const gone = yield* localExec.pipe(
                Effect.flatMap((executor) =>
                  executor.exec([
                    "python3",
                    "-c",
                    goneFixture,
                    JSON.stringify(world),
                    instanceGoneScript,
                  ]),
                ),
                Effect.provide(NodeServices.layer),
              );

              expect(gone.code, gone.stdout).toBe(0);
              expect(gone.stdout).not.toContain("FAIL");
              expect(yield* fake.shell.stat(host.dataRoot)).toBeDefined();
            }

            return true;
          }),
        { runs: 4 },
      );

      expect(result._tag, Arbitrary.formatCheckFailure(result)).toBe("Passed");
    }),
);

test.provider(
  "nonpurging bucket refusal preserves journals, allows empty rmdir, and resumes after external archive and drain",
  (scratch) =>
    Effect.gen(function* refusedDestroy() {
      const fake = yield* Fake;
      const bucket = yield* BucketFixture;
      let archiveSequence = 0;

      const cli = yield* Cli;
      const stack = checkedStack(scratch);

      const result = yield* Arbitrary.checkEffect(
        Arbitrary.schema(Schema.String),
        (key) =>
          Effect.gen(function* retry() {
            for (const journals of [false, true]) {
              yield* stack.deploy(instanceProbeProgram(host, probeLayout.dataRoot, false));
              yield* bucket.put(key);

              const journal = `${probeLayout.dataRoot}/celld/journal.db`;

              const content = new TextEncoder().encode(key || "journal evidence");

              if (journals) {
                yield* fake.shell.write({
                  bytes: content,
                  mode: 0o600,
                  path: journal,
                });
              }

              const before = yield* Plan.destroy({
                name: scratch.name,
                stage: scratch.stage,
              }).pipe(Effect.provide(scratch.state));

              const lines: string[] = [];
              const events: string[] = [];

              yield* bucket.clearRequests;
              yield* fake.clear();

              const failed = yield* withDestroyReceipt(
                Object.keys(before.deletions),
                (session) =>
                  stack.destroy().pipe(
                    Effect.provideService(Cli, {
                      approvePlan: (plan, options) => cli.approvePlan(plan, options),
                      displayPlan: (plan, options) => cli.displayPlan(plan, options),
                      startApplySession: () =>
                        Effect.succeed({
                          done: session.done,
                          emit: (event) =>
                            Effect.gen(function* emit() {
                              if (Predicate.isTagged(event, "apply.resource.status")) {
                                events.push(`${event.status} ${event.fqn}`);
                              }

                              yield* session.emit(event);
                            }),
                        }),
                      startPlanningSession: (label, detail, title) =>
                        cli.startPlanningSession(label, detail, title),
                    }),
                  ),
                (line) =>
                  Effect.sync(() => {
                    lines.push(line);
                  }),
              ).pipe(Effect.exit);

              expect(Exit.isFailure(failed)).toBe(true);

              if (Exit.isFailure(failed)) {
                expect(Cause.pretty(failed.cause)).toContain(
                  "Bucket delete refused; drain owned objects first.",
                );
              }

              expect(yield* bucket.objects).toEqual([key]);
              expect(yield* bucket.requests).not.toContain("purge");
              expect(lines).toContain("failed store/bucket");
              expect(lines).toContain(journals ? "failed celld/data" : "deleted celld/data");

              const calls = yield* fake.calls();

              for (const path of [probeLayout.dataRoot, `${probeLayout.dataRoot}/seaweedfs`]) {
                expect(yield* fake.shell.stat(path)).toBeDefined();
                expect(
                  calls.filter(
                    (call) =>
                      ["remove", "rmdir"].includes(call.operation) && call.argv.includes(path),
                  ),
                ).toEqual([]);
              }

              expect(
                calls.filter(
                  (call) =>
                    call.operation === "remove" &&
                    call.argv.some((path) => path.startsWith(`${probeLayout.dataRoot}/`)),
                ),
              ).toEqual([]);
              expect(
                calls.filter(
                  (call) =>
                    call.operation === "exec" &&
                    call.argv.some(
                      (path) =>
                        path === probeLayout.dataRoot ||
                        path.startsWith(`${probeLayout.dataRoot}/`),
                    ),
                ),
              ).toEqual([]);
              expect(events.indexOf("deleted celld/node")).toBeLessThan(
                events.indexOf("fail store/bucket"),
              );
              expect(events.indexOf("fail store/bucket")).toBeLessThan(
                events.indexOf("deleting celld/data"),
              );

              expect(events.indexOf("deleted celld/node")).toBeLessThan(
                events.indexOf("deleting celld/data"),
              );
              expect(
                calls.filter(
                  (call) =>
                    call.operation === "rmdir" &&
                    call.argv.includes(`${probeLayout.dataRoot}/celld`),
                ),
              ).toHaveLength(1);
              expect(
                calls.filter(
                  (call) =>
                    call.operation === "exec" &&
                    call.argv.includes(`${probeLayout.dataRoot}/celld`),
                ),
              ).toEqual([]);

              if (journals) {
                expect(yield* fake.shell.stat(`${probeLayout.dataRoot}/celld`)).toBeDefined();
                expect(yield* fake.shell.read(journal)).toEqual(content);
              } else {
                expect(yield* fake.shell.stat(`${probeLayout.dataRoot}/celld`)).toBeUndefined();
              }

              const independent = [
                "celld/celld",
                "celld/environment",
                "celld/node",
                "mischiefrb-deployment-stage-configuration",
                "mischiefrb-deployment-stage-directory",
                "mischiefrb-deployment-stage-worker",
                "store/storage-maintenance",
                "store/storage-retention",
                "store/storage-retention-timer",
                "worker",
                ...(journals ? [] : ["celld/data"]),
              ].toSorted();

              expect(
                lines
                  .flatMap((line) => (line.startsWith("deleted ") ? [line.slice(8)] : []))
                  .toSorted(),
              ).toEqual(independent);

              const remaining = yield* Plan.destroy({
                name: scratch.name,
                stage: scratch.stage,
              }).pipe(Effect.provide(scratch.state));

              expect(Object.keys(remaining.deletions).toSorted()).toEqual(
                Object.keys(before.deletions)
                  .filter((name) => !independent.includes(name))
                  .toSorted(),
              );

              const archivedObjects = yield* bucket.objects;

              const archiveMoves: { destination: string; source: string }[] = [];

              if (journals) {
                archiveSequence += 1;

                const moved = yield* fake.archive(
                  journal,
                  `/srv/example/archive/journal-${archiveSequence}.db`,
                );

                archiveMoves.push(moved);
                expect(yield* fake.shell.read(moved.destination)).toEqual(content);
              }

              yield* bucket.drain;
              yield* stack.destroy();

              expect(archivedObjects).toEqual([key]);
              expect(archiveMoves).toHaveLength(journals ? 1 : 0);

              for (const path of [
                ...instanceDeleteCustody(host.home, probeLayout).files,
                ...instanceDeleteCustody(host.home, probeLayout).directories,
              ]) {
                expect(yield* fake.shell.stat(path)).toBeUndefined();
              }

              const gone = yield* localExec.pipe(
                Effect.flatMap((executor) =>
                  executor.exec([
                    "python3",
                    "-c",
                    goneFixture,
                    JSON.stringify({
                      commands: false,
                      directory: false,
                      inactive: false,
                      link: false,
                      listener: false,
                      loaded: false,
                      pid: false,
                      slice: false,
                      socket: false,
                      units: false,
                    }),
                    instanceGoneScript,
                  ]),
                ),
                Effect.provide(NodeServices.layer),
              );

              expect(gone.code, gone.stdout).toBe(0);
            }

            return true;
          }),
        { runs: 3 },
      );

      expect(result._tag, Arbitrary.formatCheckFailure(result)).toBe("Passed");
    }),
);

test.provider(
  "destroy from a bootstrap-serving creating worker clears both 24-resource and 22-resource retained plans",
  (scratch) =>
    Effect.gen(function* bootstrapDestroy() {
      const fake = yield* Fake;
      const worker = yield* WorkerFixture;
      const stack = checkedStack(scratch);

      const state = yield* State.pipe(Effect.flatten, Effect.provide(scratch.state));

      const result = yield* Arbitrary.checkEffect(
        Arbitrary.schema(Schema.String.check(Schema.isUUID(4))),
        (uuid) =>
          Effect.gen(function* rollback() {
            for (const reduced of [false, true]) {
              yield* worker.set("installed");

              const output = yield* stack.deploy(instanceProbeProgram(host, probeLayout.dataRoot));

              if (reduced) {
                for (const name of [probeLayout.retentionUnit, probeLayout.retentionTimer]) {
                  yield* fake.shell.exec(["systemctl", "--user", "stop", name]);
                  yield* fake.shell.exec(["systemctl", "--user", "disable", name]);
                  yield* fake.shell.remove(`${host.home}/.config/systemd/user/${name}`);
                }

                yield* fake.shell.exec(["systemctl", "--user", "daemon-reload"]);

                for (const fqn of ["store/storage-retention", "store/storage-retention-timer"]) {
                  yield* state.delete({
                    fqn,
                    stack: scratch.name,
                    stage: scratch.stage,
                  });
                }
              }

              yield* state.set({
                fqn: "worker",
                stack: scratch.name,
                stage: scratch.stage,
                value: {
                  bindings: [],
                  downstream: [],
                  fqn: "worker",
                  instanceId: uuid.toLowerCase(),
                  logicalId: "worker",
                  namespace: undefined,
                  props: output,
                  providerVersion: 0,
                  resourceType: "Celld.Deployment",
                  status: "creating",
                },
              });
              yield* worker.set("bootstrap");

              const plan = yield* Plan.destroy({
                name: scratch.name,
                stage: scratch.stage,
              }).pipe(Effect.provide(scratch.state));

              expect(Object.keys(plan.deletions)).toHaveLength(reduced ? 22 : 24);
              yield* stack.destroy();

              for (const path of [
                ...instanceDeleteCustody(host.home, probeLayout).files,
                ...instanceDeleteCustody(host.home, probeLayout).directories,
              ]) {
                expect(yield* fake.shell.stat(path)).toBeUndefined();
              }

              expect(yield* fake.shell.stat(host.dataRoot)).toBeDefined();
            }

            return true;
          }),
        { runs: 3 },
      );

      expect(result._tag, Arbitrary.formatCheckFailure(result)).toBe("Passed");
    }),
);

test.provider(
  "bootstrap and non-version workers read absent, install fresh, and destroy creating rows without stranding dependencies",
  (scratch) =>
    Effect.gen(function* bootstrapRecovery() {
      const fake = yield* Fake;
      const worker = yield* WorkerFixture;
      const provider = yield* Celld.Deployment.Provider;
      const stack = checkedStack(scratch);

      const state = yield* State.pipe(Effect.flatten, Effect.provide(scratch.state));

      const result = yield* Arbitrary.checkEffect(
        Arbitrary.schema(Schema.String.check(Schema.isUUID(4))),
        (uuid) =>
          Effect.gen(function* cycle() {
            for (const mode of [
              "bootstrap",
              "invalid-schema",
            ] satisfies readonly (typeof WorkerMode.Type)[]) {
              yield* worker.set(mode);

              const installs = yield* worker.installs;

              const plan = yield* stack.plan(instanceProbeProgram(host, probeLayout.dataRoot));

              expect(plan.resources.worker?.action).toBe("create");

              const output = yield* stack.deploy(instanceProbeProgram(host, probeLayout.dataRoot));

              expect(yield* worker.installs).toBe(installs + 1);

              for (const bad of [
                "wrong",
                "unavailable",
                "transport",
              ] satisfies readonly (typeof WorkerMode.Type)[]) {
                yield* worker.set(bad);

                const observed = yield* checkedRead(provider, {
                  fqn: "worker",
                  id: "worker",
                  instanceId: uuid.toLowerCase(),
                  olds: output,
                  output,
                }).pipe(Effect.exit);

                expect(Exit.isFailure(observed)).toBe(true);
              }

              yield* worker.set(mode);

              for (const recorded of [undefined, output]) {
                expect(
                  yield* checkedRead(provider, {
                    fqn: "worker",
                    id: "worker",
                    instanceId: uuid.toLowerCase(),
                    olds: output,
                    output: recorded,
                  }),
                ).toBeUndefined();
              }

              yield* state.set({
                fqn: "worker",
                stack: scratch.name,
                stage: scratch.stage,
                value: {
                  bindings: [],
                  downstream: [],
                  fqn: "worker",
                  instanceId: uuid.toLowerCase(),
                  logicalId: "worker",
                  namespace: undefined,
                  props: output,
                  providerVersion: 0,
                  resourceType: "Celld.Deployment",
                  status: "creating",
                },
              });
              yield* stack.destroy();

              for (const path of [
                ...instanceDeleteCustody(host.home, probeLayout).files,
                ...instanceDeleteCustody(host.home, probeLayout).directories,
              ]) {
                expect(yield* fake.shell.stat(path)).toBeUndefined();
              }

              expect(yield* fake.shell.stat(host.dataRoot)).toBeDefined();
            }

            return true;
          }),
        { runs: 3 },
      );

      expect(result._tag, Arbitrary.formatCheckFailure(result)).toBe("Passed");
    }),
);
