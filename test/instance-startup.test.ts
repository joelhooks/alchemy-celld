import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Layer } from "effect";
import { expect } from "vitest";

import { makeFakeShell } from "../src/fake-shell.ts";
import { HostShell } from "../src/host-shell.ts";
import { declaredListeners, startupLayer, InstanceNameSchema, instanceLayout } from "./fixture.ts";
import { UnitStartup } from "../src/unit-startup.ts";

const host = {
  dataRoot: "/srv/example/mailbox",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

it.effect.prop(
  "named startup reads its credentials and stops only its units on listener exposure",
  { instance: Arbitrary.schema(InstanceNameSchema) },
  ({ instance }) =>
    Effect.gen(function* startup() {
      const layout = instanceLayout(host, {
        dataRoot: `/srv/example/${instance}`,
        instance,
        portBase: 30_000,
      });

      const fake = yield* makeFakeShell();
      const commands: (readonly string[])[] = [];
      const reads: string[] = [];

      const cgroup = (unit: string) =>
        `/user.slice/example-user.slice/example-user.service/${layout.slice}/${unit}`;

      const text = declaredListeners(host.tailnetIPv4, true, false, layout)
        .map(
          ({ address, port, unit }) =>
            `LISTEN 0 4096 ${unit === layout.nodeUnit && address === host.tailnetIPv4 ? "0.0.0.0" : address}:${port} 0.0.0.0:* users:(("process",pid=1,fd=3)) cgroup:${cgroup(unit)}`,
        )
        .join("\n");

      const environment = `CELLD_BUCKET="s3://example-cells"\nS3_ENDPOINT="http://127.0.0.1:${layout.ports.s3}"\n`;

      const identity = JSON.stringify({
        identities: [
          {
            credentials: [{ accessKey: "a".repeat(32), secretKey: "b".repeat(64) }],
          },
        ],
      });

      const contents = new Map([
        [`${layout.configuration}/celld.env`, new TextEncoder().encode(environment)],
        [`${layout.configuration}/s3.json`, new TextEncoder().encode(identity)],
      ]);

      const shell = HostShell.of({
        ...fake.shell,
        exec: (argv) =>
          Effect.sync(() => {
            commands.push(argv);

            if (argv[0] === "python3") {
              return {
                code: 0,
                stdout: JSON.stringify({ status: 200, version: "invented" }),
              };
            }

            if (argv[0] === "ss") {
              return { code: 0, stdout: text };
            }

            if (argv.includes("--property=ControlGroup")) {
              return { code: 0, stdout: cgroup(argv[3] ?? "") };
            }

            return { code: 0, stdout: "active" };
          }),
        read: (path) =>
          Effect.sync(() => {
            reads.push(path);

            return contents.get(path);
          }),
      });

      yield* Effect.gen(function* check() {
        const gate = yield* UnitStartup;
        yield* gate.beforeStart("celld-celld.service", host.home);
        yield* gate.afterStart("celld-seaweedfs.service");
        expect(commands).toEqual([]);
        yield* gate.beforeStart(layout.nodeUnit, host.home);
        expect(reads).toEqual([
          `${layout.configuration}/celld.env`,
          `${layout.configuration}/s3.json`,
        ]);
        expect(commands[0]?.[3]).toBe(`${layout.configuration}/s3.json`);
        expect(yield* gate.afterStart(layout.nodeUnit).pipe(Effect.isFailure)).toBe(true);

        const stopped = commands
          .flatMap((argv) => (argv[2] === "stop" ? [argv[3] ?? "missing"] : []))
          .toSorted((a, b) => a.localeCompare(b));

        expect(stopped).toEqual(
          [layout.nodeUnit, layout.storeUnit].toSorted((a, b) => a.localeCompare(b)),
        );
        expect(
          commands.some(
            (argv) =>
              argv.includes("celld-celld.service") || argv.includes("celld-seaweedfs.service"),
          ),
        ).toBe(false);
      }).pipe(
        Effect.provide(
          startupLayer(host.tailnetIPv4, "scope", undefined, undefined, layout).pipe(
            Layer.provide(Layer.succeed(HostShell, shell)),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 12 } },
);
