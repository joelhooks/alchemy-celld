import { it } from "@effect/vitest";
import * as Test from "alchemy/Test/Vitest";
import { Context, Effect, Layer, Redacted } from "effect";
import { expect } from "vitest";

import { BucketProvider, BucketResource } from "../src/bucket-api.ts";
import { makeFakeShell } from "../src/fake-shell.ts";
import { deleteDirectory, reconcileDirectory, validateDirectory } from "../src/files.ts";
import { HostShell } from "../src/host-shell.ts";
import { NodeProvider, NodeResource } from "../src/node-provider.ts";
import type { NodeProps } from "../src/node-provider.ts";
import { RemoteFile, RemoteFileProvider } from "../src/providers.ts";
import { nodeUnit, sliceUnit, storeUnit } from "./fixture.ts";
import { renderUnit, validateUnit } from "../src/systemd.ts";
import { checkedStack } from "./checked-stack.ts";

const host = {
  dataRoot: "/srv/example",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

const store = storeUnit({
  binary: "/opt/example/weed",
  config: "/opt/example/s3.json",
  data: "/srv/example/store",
  home: host.home,
  restartOn: ["identity-hash", "binary-hash"],
});

const node = nodeUnit({
  binary: "/opt/example/celld",
  data: "/srv/example/cells",
  environment: "/opt/example/celld.env",
  host,
  restartOn: ["env-hash", "binary-hash"],
});

it.effect("renders binding, caps, telemetry and dependencies without credentials", () =>
  Effect.gen(function* testUnits() {
    for (const unit of [sliceUnit(host.home), store, node]) {
      yield* validateUnit(unit);
    }

    const storeText = renderUnit(store);

    for (const flag of [
      "-ip=127.0.0.1",
      "-ip.bind=127.0.0.1",
      "-master.telemetry=false",
      "-s3.port.iceberg=0",
      "-s3.port.lance=0",
      "-metricsPort=0",
      "-debug=false",
      "-volume.pprof=false",
    ]) {
      expect(storeText).toContain(flag);
    }

    for (const port of [31_004, 31_008, 31_002, 31_006, 31_005, 31_009, 31_003, 31_007]) {
      expect(storeText).toContain(`=${port}`);
    }

    expect(storeText).toContain("WorkingDirectory=/srv/example/store");
    expect(storeText).not.toContain('WorkingDirectory="');
    expect(storeText).toContain("MemoryMax=3G");
    expect(storeText).toContain("CPUQuota=100%");
    expect(storeText).toContain("SENTRY_DSN=");
    expect(storeText).toContain("OTEL_SDK_DISABLED=true");
    const nodeText = renderUnit(node);
    expect(nodeText).toContain("--listen 203.0.113.10:31000 --internal-listen 127.0.0.1:31001");
    expect(nodeText).toContain("WorkingDirectory=/srv/example/cells");
    expect(nodeText).not.toContain('WorkingDirectory="');
    expect(nodeText).toContain('Environment="CELLD_TEST_DATA_DIR=/srv/example/cells"');
    expect(nodeText).toContain("EnvironmentFile=");
    expect(nodeText).toContain("Requires=celld-seaweedfs.service");
    expect(nodeText).toContain("After=celld-seaweedfs.service");
    expect(nodeText).toContain("MemoryMax=3G");
    expect(nodeText).toContain("CPUQuota=200%");
    expect(nodeText).not.toContain("AWS_");

    for (const text of [storeText, nodeText]) {
      for (const directive of [
        "Slice=celld.slice",
        "Nice=10",
        "Restart=on-failure",
        "RestartSec=10",
        "StartLimitIntervalSec=0",
        "MemorySwapMax=0",
      ]) {
        expect(text).toContain(directive);
      }

      expect(text).not.toContain("0.0.0.0");
    }
  }),
);

it.effect("owned directory purge is explicit and refuses paths and escaping symlinks", () =>
  Effect.gen(function* purgeSafety() {
    const fake = yield* makeFakeShell();
    const props = { mode: 0o700, path: "/srv/example/store" };

    expect(
      yield* reconcileDirectory(
        fake.shell,
        { ...props, purgeOnDelete: true, purgeRoot: "/srv" },
        undefined,
        false,
      ).pipe(Effect.isFailure),
    ).toBe(true);

    const plain = yield* reconcileDirectory(fake.shell, props, undefined, false);

    yield* fake.shell.write({
      bytes: new Uint8Array([1]),
      mode: 0o600,
      path: "/srv/example/store/data",
    });
    expect(yield* deleteDirectory(fake.shell, plain).pipe(Effect.isFailure)).toBe(true);
    expect(
      yield* validateDirectory({
        ...props,
        purgeOnDelete: true,
        purgeRoot: "/opt/example",
      }).pipe(Effect.isFailure),
    ).toBe(true);

    const owned = yield* reconcileDirectory(
      fake.shell,
      { ...props, purgeOnDelete: true, purgeRoot: "/srv/example" },
      plain,
      false,
    );

    yield* fake.symlink("/srv/example/store/link", "/opt/example/foreign");
    expect(yield* deleteDirectory(fake.shell, owned).pipe(Effect.isFailure)).toBe(true);
    expect(yield* fake.shell.stat(props.path)).toBeDefined();
    const clean = yield* makeFakeShell();

    const directory = yield* reconcileDirectory(
      clean.shell,
      { ...props, purgeOnDelete: true, purgeRoot: "/srv/example" },
      undefined,
      false,
    );

    yield* clean.shell.write({
      bytes: new Uint8Array([1]),
      mode: 0o600,
      path: "/srv/example/store/data",
    });
    yield* deleteDirectory(clean.shell, directory);
    expect(yield* clean.shell.stat(props.path)).toBeUndefined();
    expect(yield* clean.shell.stat("/srv/example")).toBeDefined();
  }),
);

class FakeBucket extends Context.Service<
  FakeBucket,
  { readonly version: (value: string) => Effect.Effect<void> }
>()("Test/FakeBucket") {}

const fakeLayer = Layer.effectContext(
  Effect.gen(function* makeBucketFake() {
    const fake = yield* makeFakeShell();
    let exists = false;
    let version = "";

    const shell = HostShell.of({
      ...fake.shell,
      exec: (argv) => {
        if (argv[0] !== "python3") {
          return fake.shell.exec(argv);
        }

        return Effect.sync(() => {
          const operation = argv.at(6);
          let status = 200;

          if (operation === "read" && !exists) {
            status = 404;
          }

          if (operation === "create") {
            exists = true;
          }

          if (operation === "delete" || operation === "purge") {
            exists = false;
            status = 204;
          }

          return {
            code: 0,
            stdout: JSON.stringify({
              status,
              version: operation === "version" ? version : "",
            }),
          };
        });
      },
    });

    return Context.make(HostShell, shell).pipe(
      Context.add(FakeBucket, {
        version: (value) =>
          Effect.sync(() => {
            version = value;
          }),
      }),
    );
  }),
);

const { test: nodeTest } = Test.make({
  providers: NodeProvider().pipe(Layer.provideMerge(fakeLayer)),
  stage: "node-tests",
});

const nodeProps: NodeProps = {
  ...node,
  internalUrl: "http://127.0.0.1:31001",
  publicUrl: "http://203.0.113.10:31000",
  version: "v0.6.1",
};

nodeTest.provider("Celld.Node create, version outputs, update, noop and delete", (scratch) =>
  Effect.gen(function* nodeLifecycle() {
    const stack = checkedStack(scratch);
    const created = yield* stack.deploy(NodeResource("node", nodeProps));
    expect(created.version).toBe("v0.6.1");
    expect(created.active).toBe(true);

    const next: NodeProps = {
      ...nodeProps,
      restartOn: ["changed-environment"],
    };

    const updated = yield* stack.deploy(NodeResource("node", next));
    expect(updated.configSha256).not.toBe(created.configSha256);
    const plan = yield* stack.plan(NodeResource("node", next));
    expect(Object.values(plan.resources).map((resource) => resource.action)).toEqual(["noop"]);
    yield* stack.destroy();
  }),
);

const { test: secretTest } = Test.make({
  providers: RemoteFileProvider().pipe(Layer.provideMerge(fakeLayer)),
  stage: "secret-file-tests",
});

secretTest.provider(
  "redacted secret files survive Alchemy state serialization and plan noop",
  (scratch) =>
    Effect.gen(function* secretState() {
      const stack = checkedStack(scratch);

      const props = {
        content: Redacted.make("invented-only"),
        mode: 0o600,
        path: "/srv/example/redacted",
      };

      const result = yield* stack.deploy(RemoteFile("secret", props));
      expect(result.mode).toBe(0o600);
      expect(new TextDecoder().decode(yield* (yield* HostShell).read(props.path))).toBe(
        "invented-only",
      );
      const plan = yield* stack.plan(RemoteFile("secret", props));
      expect(Object.values(plan.resources).map((resource) => resource.action)).toEqual(["noop"]);
      yield* stack.destroy();
    }),
);

const { test } = Test.make({
  providers: BucketProvider().pipe(Layer.provideMerge(fakeLayer)),
  stage: "bucket-tests",
});

const props = {
  config: "/srv/example/s3.json",
  endpoint: "http://127.0.0.1:31006",
  name: "example-bucket",
  ready: "unit-hash",
  region: "us-east-1",
} as const;

test.provider("bucket create, readback, noop plan and delete", (scratch) =>
  Effect.gen(function* lifecycle() {
    const stack = checkedStack(scratch);
    const created = yield* stack.deploy(BucketResource("bucket", props));
    expect(created.name).toBe(props.name);
    const plan = yield* stack.plan(BucketResource("bucket", props));
    expect(Object.values(plan.resources).map((resource) => resource.action)).toEqual(["noop"]);
    yield* stack.destroy();
  }),
);

test.provider("refuses previously enabled or suspended versioning", (scratch) =>
  Effect.gen(function* versioning() {
    const stack = checkedStack(scratch);
    yield* stack.deploy(BucketResource("bucket", props));
    const fake = yield* FakeBucket;
    yield* fake.version("Suspended");
    expect((yield* Effect.exit(stack.plan(BucketResource("bucket", props))))._tag).toBe("Failure");
    yield* fake.version("");
    yield* stack.destroy();
  }),
);
