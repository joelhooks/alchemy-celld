// @effect-diagnostics anyUnknownInErrorContext:off -- Alchemy scratch.plan exposes any errors; this test asserts its failure without publishing them.
import * as Output from "alchemy/Output";
import * as Plan from "alchemy/Plan";
import { Random, RandomProvider } from "alchemy/Random";
import { State } from "alchemy/State";
import * as Test from "alchemy/Test/Vitest";
import { Context, Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { StateRecovery, rotatingFile, rotationScript } from "../src/adoption.ts";
import { BucketProvider, BucketResource } from "../src/bucket-api.ts";
import { Deployment, DeploymentProvider } from "../src/deployment.ts";
import { makeFakeShell } from "../src/fake-shell.ts";
import { digest, textDigest } from "../src/files.ts";
import { HostShell } from "../src/host-shell.ts";
import { NodeProvider, NodeResource } from "../src/node-provider.ts";
import {
  HostDirectory,
  ReleaseBinary,
  RemoteFile,
  SystemdUnit,
  providers,
} from "../src/providers.ts";
import { ReleaseSource } from "../src/release.ts";
import { s3Script } from "../src/s3-script.ts";
import { nodeUnit, sliceUnit, storeUnit } from "./fixture.ts";
import { renderUnit } from "../src/systemd.ts";
import { checkedStack } from "./checked-stack.ts";

const host = {
  dataRoot: "/srv/example",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

const config = `${host.home}/.config/celld`;

const bin = `${config}/bin`;

const bytes = new TextEncoder().encode("invented executable");

const identity = { commit: "1234567", version: "v1" };

class Fake extends Context.Service<
  Fake,
  Effect.Success<ReturnType<typeof makeFakeShell>> & {
    readonly commands: (readonly string[])[];
  }
>()("Test/AdoptionFake") {}

const runtime = Layer.effectContext(
  Effect.gen(function* runtime() {
    const fake = yield* makeFakeShell();
    let bucket = false;
    const commands: (readonly string[])[] = [];

    const shell = HostShell.of({
      ...fake.shell,
      exec: (argv) => {
        commands.push(argv);

        if (["sh", "curl"].includes(argv[0] ?? "")) {
          return Effect.succeed({ code: 0, stdout: "" });
        }

        if (argv[2] === rotationScript) {
          return Effect.succeed({ code: 0, stdout: "" });
        }

        if (argv[2] === s3Script) {
          if (argv[6] === "create") {
            bucket = true;
          }

          return Effect.succeed({
            code: 0,
            stdout: JSON.stringify({ status: bucket ? 200 : 404, version: "" }),
          });
        }

        return fake.shell.exec(argv);
      },
    });

    return Context.make(Fake, { ...fake, commands }).pipe(
      Context.add(HostShell, shell),
      Context.add(StateRecovery, true),
      Context.add(ReleaseSource, { get: () => Effect.succeed(bytes) }),
      Context.add(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(identity))),
        ),
      ),
    );
  }),
);

const { test } = Test.make({
  adopt: true,
  providers: Layer.mergeAll(
    providers(),
    RandomProvider(),
    BucketProvider(),
    NodeProvider(),
    DeploymentProvider(),
  ).pipe(Layer.provideMerge(runtime)),
  stage: "adoption-tests",
});

const graph = Effect.gen(function* graph() {
  const root = yield* HostDirectory("root", {
    mode: 0o700,
    path: host.dataRoot,
  });

  yield* HostDirectory("bin", { mode: 0o700, path: bin });

  const data = yield* HostDirectory("data", {
    mode: 0o700,
    path: Output.interpolate`${root.path}/cells`,
  });

  const binary = yield* ReleaseBinary("binary", {
    asset: { format: "raw" },
    path: `${bin}/binary`,
    sha256: digest(bytes),
    size: bytes.length,
    url: "https://github.com/example/example/releases/download/v1/binary",
  });

  const slice = yield* SystemdUnit("slice", sliceUnit(host.home));
  const access = yield* Random("access-key", { bytes: 16 });
  const secret = yield* Random("secret-key", { bytes: 32 });

  const storeDeclaration = storeUnit({
    binary: `${bin}/binary`,
    config: `${config}/s3.json`,
    data: `${host.dataRoot}/cells`,
    home: host.home,
    restartOn: [],
  });

  const nodeDeclaration = nodeUnit({
    binary: `${bin}/binary`,
    data: `${host.dataRoot}/cells`,
    environment: `${config}/celld.env`,
    host,
    restartOn: [],
  });

  const s3 = yield* RemoteFile("identity", {
    content: Output.all(access.text, secret.text).pipe(
      Output.map(([accessKey, secretKey]) =>
        Redacted.make(
          JSON.stringify({
            identities: [
              {
                actions: ["Admin", "Read", "Write", "List", "Tagging"],
                credentials: [
                  {
                    accessKey: Redacted.value(accessKey),
                    secretKey: Redacted.value(secretKey),
                  },
                ],
                name: "celld",
              },
            ],
          }),
        ),
      ),
    ),
    mode: 0o600,
    path: `${config}/s3.json`,
    rotationOwner: {
      home: host.home,
      name: "celld-seaweedfs.service",
      sha256: textDigest(renderUnit(storeDeclaration)),
    },
  });

  const store = yield* SystemdUnit(
    "store",
    Output.all(slice.sha256, binary.path, data.path, s3.path, s3.sha256).pipe(
      Output.map(([, binaryPath, directory, configPath, hash]) =>
        storeUnit({
          binary: binaryPath,
          config: configPath,
          data: directory,
          home: host.home,
          restartOn: [hash],
        }),
      ),
    ),
  );

  const bucket = yield* BucketResource("bucket", {
    config: s3.path,
    endpoint: "http://127.0.0.1:31006",
    name: "example-bucket",
    ownedStore: store.sha256.pipe(
      Output.map((sha256) => ({
        home: host.home,
        name: "celld-seaweedfs.service" as const,
        sha256,
      })),
    ),
    ready: store.sha256,
    region: "us-east-1",
  });

  const env = yield* RemoteFile("environment", {
    content: Output.all(access.text, secret.text, bucket.name).pipe(
      Output.map(([accessKey, secretKey, name]) =>
        Redacted.make(
          `AWS_ACCESS_KEY_ID="${Redacted.value(accessKey)}"\nAWS_SECRET_ACCESS_KEY="${Redacted.value(secretKey)}"\nAWS_REGION=us-east-1\nS3_ENDPOINT="http://127.0.0.1:31006"\nCELLD_BUCKET="s3://${name}"\nCELLD_OTEL=0\n`,
        ),
      ),
    ),
    mode: 0o600,
    path: `${config}/celld.env`,
    rotationOwner: {
      home: host.home,
      name: "celld-celld.service",
      sha256: textDigest(renderUnit(nodeDeclaration)),
    },
  });

  const node = yield* NodeResource(
    "node",
    Output.all(binary.path, data.path, env.path, env.sha256).pipe(
      Output.map(([binaryPath, directory, environment, hash]) => ({
        ...nodeUnit({
          binary: binaryPath,
          data: directory,
          environment,
          host,
          restartOn: [hash],
        }),
        internalUrl: "http://127.0.0.1:31001",
        publicUrl: "http://203.0.113.10:31000",
        version: "v0.6.1" as const,
      })),
    ),
  );

  yield* RemoteFile("public-file", {
    content: "ours",
    mode: 0o600,
    path: `${config}/public.json`,
  });

  const deployment = yield* Deployment(
    "deployment",
    Output.all(node.path, bucket.name).pipe(
      Output.map(() => ({
        ...identity,
        binary: `${bin}/binary`,
        bundle: JSON.stringify(identity),
        configuration: JSON.stringify({
          compatibility_date: "2026-10-04",
          compatibility_flags: ["nodejs_compat"],
          durable_objects: { bindings: [] },
          main: "worker.mjs",
          migrations: [],
          name: "example",
          no_bundle: true,
          vars: {},
        }),
        directory: `${config}/mailbox-deployment`,
        environmentFile: `${config}/celld.env`,
        internalUrl: "http://127.0.0.1:31001",
        workerUrl: "http://203.0.113.10:31000",
      })),
    ),
  );

  return { deployment: deployment.sha256, key: access.text };
});

test.provider(
  "lost state adopts owned objects, rotates keys, then noops; foreign content refuses",
  (scratch) =>
    Effect.gen(function* recover() {
      const stack = checkedStack(scratch);
      const fake = yield* Fake;
      const state = yield* yield* State;
      yield* fake.shell.exec(["chmod", "700", "--", host.dataRoot]);
      const before = yield* stack.deploy(graph);
      yield* state.deleteStack({ stack: scratch.name, stage: scratch.stage });
      yield* fake.clear();
      const plan = yield* stack.plan(graph);
      expect(
        Object.entries(plan.resources).every(
          ([id, r]) =>
            r.action === "adopted" ||
            (r.action === "create" &&
              (r.deferredAdoption !== undefined || ["access-key", "secret-key"].includes(id))),
        ),
      ).toBe(true);
      expect(plan.deletions).toEqual({});
      expect(
        Plan.describePlan(plan)
          .resources.filter((r) => r.resourceType === "Alchemy.Random")
          .map((r) => r.action),
      ).toEqual(["create", "create"]);
      expect(
        (yield* fake.calls()).every((c) => ["read", "stat", "exec"].includes(c.operation)),
      ).toBe(true);
      yield* fake.clear();
      fake.commands.length = 0;
      const after = yield* stack.deploy(graph);
      expect(
        (yield* fake.calls()).some((c) => ["mkdir", "remove", "rmdir"].includes(c.operation)),
      ).toBe(false);
      expect(fake.commands.some((argv) => argv[2] === s3Script && argv[6] === "create")).toBe(
        false,
      );
      expect(fake.commands.filter((argv) => argv[2] === "restart").map((argv) => argv[3])).toEqual([
        "celld-seaweedfs.service",
        "celld-celld.service",
      ]);
      expect(Redacted.value(after.key)).not.toBe(Redacted.value(before.key));
      const noop = yield* stack.plan(graph);
      expect(Object.values(noop.resources).every((r) => r.action === "noop")).toBe(true);
      yield* state.deleteStack({ stack: scratch.name, stage: scratch.stage });
      yield* fake.shell.write({
        bytes: new TextEncoder().encode("foreign"),
        mode: 0o600,
        path: `${config}/public.json`,
      });
      expect(yield* scratch.plan(graph).pipe(Effect.isFailure)).toBe(true);
      yield* fake.shell.write({
        bytes: new TextEncoder().encode("foreign owner unit"),
        mode: 0o644,
        path: `${host.home}/.config/systemd/user/celld-seaweedfs.service`,
      });
      expect(
        yield* rotatingFile(yield* HostShell, {
          content: "new credentials",
          mode: 0o600,
          path: `${config}/s3.json`,
          rotationOwner: {
            home: host.home,
            name: "celld-seaweedfs.service",
            sha256: textDigest(
              renderUnit(
                storeUnit({
                  binary: `${bin}/binary`,
                  config: `${config}/s3.json`,
                  data: `${host.dataRoot}/cells`,
                  home: host.home,
                  restartOn: [],
                }),
              ),
            ),
          },
        }).pipe(Effect.isFailure),
      ).toBe(true);
    }),
);
