import { NodeServices } from "@effect/platform-node";
import * as Output from "alchemy/Output";
import * as Test from "alchemy/Test/Vitest";
import { Context, Effect, Layer } from "effect";
import { expect } from "vitest";

import { BucketProvider, BucketResource } from "../src/bucket-api.ts";
import { makeFakeShell } from "../src/fake-shell.ts";
import { HostShell } from "../src/host-shell.ts";
import {
  RemoteFile,
  RemoteFileProvider,
  SystemdUnit,
  SystemdUnitProvider,
} from "../src/providers.ts";
import { s3Script } from "../src/s3-script.ts";
import { storeUnit, startupLayer } from "./fixture.ts";
import { UnitStartup } from "../src/unit-startup.ts";
import { checkedStack } from "./checked-stack.ts";

const home = "/home/example";

const name = "celld-seaweedfs.service";

const unitPath = `${home}/.config/systemd/user/${name}`;

class RecoveryFake extends Context.Service<
  RecoveryFake,
  {
    readonly deleted: () => Effect.Effect<number>;
    readonly trace: () => Effect.Effect<readonly string[]>;
  }
>()("Test/RecoveryFake") {}

const fakeLayer = Layer.effectContext(
  Effect.gen(function* fakeStore() {
    const fake = yield* makeFakeShell();
    let exists = false;
    let deleted = 0;
    const trace: string[] = [];

    const shell = HostShell.of({
      ...fake.shell,
      exec: Effect.fn("Test.recovery.exec")(function* exec(argv) {
        if (argv[0] === "ss") {
          return {
            code: 0,
            stdout: 'LISTEN 0 4096 0.0.0.0:31006 0.0.0.0:* users:(("weed",pid=12,fd=3))',
          };
        }

        if (argv[0] === "systemctl" && ["start", "stop"].includes(argv[2] ?? "")) {
          trace.push(`${argv[2]}:${argv[3]}`);
        }

        if (argv[0] !== "python3" || argv[2] !== s3Script) {
          return yield* fake.shell.exec(argv);
        }

        const operation = argv.at(6);
        trace.push(`s3:${operation}`);

        const unit = yield* fake.shell.exec(["systemctl", "--user", "show", name]);

        if (!unit.stdout.includes("ActiveState=active\n")) {
          return { code: 1, stdout: "" };
        }

        let status = exists ? 200 : 404;

        if (operation === "create") {
          exists = true;
          status = 200;
        }

        if (operation === "purge") {
          exists = false;
          deleted += 1;
          status = 204;
        }

        return { code: 0, stdout: JSON.stringify({ status, version: "" }) };
      }),
    });

    return Context.make(HostShell, shell).pipe(
      Context.add(RecoveryFake, {
        deleted: () => Effect.succeed(deleted),
        trace: () => Effect.succeed([...trace]),
      }),
    );
  }),
);

const { test } = Test.make({
  providers: Layer.mergeAll(BucketProvider(), SystemdUnitProvider(), RemoteFileProvider()).pipe(
    Layer.provideMerge(fakeLayer),
  ),
  stage: "bucket-recovery-tests",
});

test.provider(
  "failed start stops weed, then destroy drains and reaches all 22 deletes",
  (scratch) =>
    Effect.gen(function* recoverDestroy() {
      const stack = checkedStack(scratch);
      yield* stack.deploy(
        Effect.gen(function* resources() {
          const unit = yield* SystemdUnit(
            "store-server",
            storeUnit({
              binary: "/opt/example/weed",
              config: `${home}/.config/celld/s3.json`,
              data: "/srv/example",
              home,
              restartOn: [],
            }),
          );

          const bucket = yield* BucketResource("store-bucket", {
            config: `${home}/.config/celld/s3.json`,
            endpoint: "http://127.0.0.1:31006",
            name: "example-bucket",
            ownedStore: Output.all(unit.home, unit.sha256).pipe(
              Output.map(([unitHome, sha256]) => ({ home: unitHome, name, sha256 })),
            ),
            purgeOnDelete: true,
            ready: unit.sha256,
            region: "us-east-1",
          });

          for (let index = 0; index < 20; index += 1) {
            yield* RemoteFile(`node-file-${index}`, {
              content: Output.interpolate`bucket=${bucket.name}`,
              path: `/srv/example/node-${index}`,
            });
          }

          return { bucketName: bucket.name };
        }),
      );
      const shell = yield* HostShell;
      yield* Effect.gen(function* failStart() {
        const startup = yield* UnitStartup;
        expect(yield* startup.afterStart("celld-celld.service").pipe(Effect.isFailure)).toBe(true);
      }).pipe(
        Effect.provide(
          startupLayer("203.0.113.10").pipe(
            Layer.provide(Layer.succeed(HostShell, shell)),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      const fake = yield* RecoveryFake;
      const before = yield* fake.trace();
      expect(before).toContain(`stop:${name}`);
      expect((yield* shell.exec(["systemctl", "--user", "show", name])).stdout).toContain(
        "ActiveState=inactive",
      );
      yield* stack.destroy();
      expect(yield* fake.deleted()).toBe(1);
      expect(yield* shell.stat(unitPath)).toBeUndefined();

      for (let index = 0; index < 20; index += 1) {
        expect(yield* shell.stat(`/srv/example/node-${index}`)).toBeUndefined();
      }

      expect((yield* fake.trace()).slice(before.length)).toEqual([
        "s3:version",
        `start:${name}`,
        "s3:version",
        "s3:purge",
        `stop:${name}`,
      ]);
    }),
);
