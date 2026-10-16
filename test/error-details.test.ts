import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Result, Schema } from "effect";
import { expect } from "vitest";

import { ArchiveRefused } from "../src/archive-error.ts";
import { buildDiagnostics } from "../src/build-diagnostics.ts";
import { wranglerConfiguration } from "../src/deployment-config.ts";
import { makeFakeShell } from "../src/fake-shell.ts";
import { Host, layer as inventoryLayer } from "../src/host.ts";
import { MaintenanceRenderError } from "../src/maintenance-targets.ts";
import { ListenerExposure } from "../src/instance-listeners.ts";
import { layer as sshLayer } from "../src/ssh.ts";
import { tarReader } from "../src/tar.ts";
import { workerBundle } from "../src/worker-bundle.ts";

const secret = "EXAMPLE_PRIVATE_VALUE_DO_NOT_LOG";
const declaration = {
  compatibility_date: "2026-10-04",
  compatibility_flags: [],
  durable_objects: { bindings: [{ class_name: "Example", name: "EXAMPLE" }] },
  migrations: [{ new_sqlite_classes: ["Example"], tag: "v1" }],
  name: "example-worker",
};
const build = {
  version: "example-version",
  commit: "example-commit",
  main: "worker.mjs",
  vars: {},
};

it.effect(
  "binding and bundle identity failures retain their tag but name different fields and actions",
  () =>
    Effect.gen(function* split() {
      const bindings = yield* wranglerConfiguration({ ...declaration, migrations: [] }, build).pipe(
        Effect.result,
      );
      const identity = yield* wranglerConfiguration(declaration, { ...build, commit: "" }).pipe(
        Effect.result,
      );
      expect(Result.isFailure(bindings)).toBe(true);
      expect(Result.isFailure(identity)).toBe(true);
      if (Result.isFailure(bindings) && Result.isFailure(identity)) {
        expect(bindings.failure._tag).toBe("DeploymentError");
        expect(bindings.failure.reason).toBe("Invalid deployment bindings");
        expect(bindings.failure.field).toBe("durable_objects.bindings.class_name");
        expect(identity.failure._tag).toBe("DeploymentError");
        expect(identity.failure.reason).toBe("Invalid bundle identity");
        expect(identity.failure.field).toBe("build.commit");
        expect(identity.failure.message).toContain("Action:");
      }
    }),
);

it.effect(
  "worker build failures retain safe diagnostics and input descriptors without source paths or snippets",
  () =>
    Effect.gen(function* buildFailure() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "example-build-" });
      const entrypoint = `${directory}/private-entrypoint.ts`;
      yield* fs.writeFileString(entrypoint, `export const = ${JSON.stringify(secret)};`);
      const result = yield* workerBundle(entrypoint).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("WorkerBundleFailure");
        expect(result.failure.operation).toBe("build-worker");
        expect(result.failure.entrypoint).toEqual({
          field: "entrypoint",
          redacted: true,
          extension: ".ts",
        });
        expect(result.failure.diagnostics[0]).toMatchObject({
          code: "syntax",
          location: { line: 1 },
          text: 'Expected identifier but found "="',
        });
        expect(JSON.stringify(result.failure)).not.toContain(secret);
        expect(JSON.stringify(result.failure)).not.toContain(entrypoint);
        expect(JSON.stringify(result.failure)).not.toContain("private-entrypoint");
        expect(result.failure.message).toContain("Action:");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("diagnostic projection drops arbitrary values, nested notes, snippets, filenames and plugin details", () => {
  const diagnostics = buildDiagnostics({
    errors: [
      {
        text: `Could not resolve "/srv/example/${secret}.ts"`,
        location: { file: `/srv/example/${secret}`, line: 7, column: 3, lineText: secret },
        detail: { credential: secret },
        notes: [{ text: secret, location: null }],
      },
    ],
    warnings: [{ text: `Unexpected "${secret}"`, location: null }],
  });
  expect(diagnostics).toHaveLength(3);
  expect(diagnostics[0]).toMatchObject({ code: "resolution", location: { line: 7, column: 3 } });
  expect(diagnostics[1]?.severity).toBe("note");
  expect(diagnostics[2]?.severity).toBe("warning");
  expect(JSON.stringify(diagnostics)).not.toContain(secret);
  expect(JSON.stringify(diagnostics)).not.toContain("/srv/example");
  expect(buildDiagnostics(new Error(secret))[0]?.text).toContain("values redacted");
});

it.effect(
  "fake command and directory errors identify the received operation without exposing arguments or paths",
  () =>
    Effect.gen(function* fakeFailures() {
      const fake = yield* makeFakeShell();
      const command = yield* fake.shell
        .exec(["curl", `https://example.invalid/${secret}`])
        .pipe(Effect.result);
      const directory = yield* fake.shell
        .mkdir({ mode: 0o700, path: `/srv/example/${secret}/child` })
        .pipe(Effect.result);
      expect(Result.isFailure(command)).toBe(true);
      expect(Result.isFailure(directory)).toBe(true);
      if (Result.isFailure(command) && Result.isFailure(directory)) {
        expect(command.failure.message).toContain("Received program: curl");
        expect(command.failure.expectedShape).toContain("systemctl --user");
        expect(command.failure.actual).toBe("curl; arguments redacted");
        expect(directory.failure.field).toBe("path.parent");
        expect(directory.failure.actual).toBe("absent parent");
        expect(directory.failure.action).toContain("Create the parent");
        expect(JSON.stringify([command.failure, directory.failure])).not.toContain(secret);
      }
    }),
);

it.effect(
  "host and inventory failures retain redaction and add fields, shapes and corrective actions",
  () =>
    Effect.gen(function* privateFailures() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "example-private-" });
      const path = `${directory}/inventory.json`;
      yield* fs.writeFileString(path, JSON.stringify({ credential: secret }), { mode: 0o600 });
      const inventory = yield* Effect.gen(function* read() {
        return yield* (yield* Host).node(secret);
      }).pipe(
        Effect.provide(
          inventoryLayer.pipe(
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ FLEET_INVENTORY: path })),
            ),
          ),
        ),
        Effect.result,
      );
      const host = yield* Effect.void.pipe(
        Effect.provide(
          sshLayer(
            {
              home: "/home/example",
              dataRoot: "/srv/example",
              ssh: "example",
              tailnetIPv4: secret,
            },
            { instance: "example", portBase: 33_000, restartGate: false },
          ),
        ),
        Effect.result,
      );
      expect(Result.isFailure(inventory)).toBe(true);
      expect(Result.isFailure(host)).toBe(true);
      if (Result.isFailure(inventory) && Result.isFailure(host)) {
        expect(inventory.failure._tag).toBe("InventoryError");
        expect(host.failure._tag).toBe("HostError");
        expect(JSON.stringify([inventory.failure, host.failure])).not.toContain(secret);
        expect(JSON.stringify(inventory.failure)).not.toContain(path);
        if (inventory.failure._tag === "InventoryError") {
          expect(inventory.failure.reason).toBe(
            "Private inventory is unreadable or malformed; values redacted.",
          );
          expect(inventory.failure.field).toBe("FLEET_INVENTORY");
          expect(inventory.failure.message).toContain("Action:");
        }
        if (host.failure._tag === "HostError") {
          expect(host.failure.reason).toBe("Invalid host facts; values redacted.");
          expect(host.failure.field).toBe("node");
          expect(host.failure.expectedShape).toContain("IPv4");
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("archive context redacts member/root inputs and public error constructors retain open reasons", () => {
  const reader = tarReader(new Set(), `/srv/example/${secret}`);
  reader.push(new Uint8Array(1024));
  try {
    reader.finish();
    expect.fail("The missing declared archive root must be refused.");
  } catch (error) {
    expect(Schema.is(ArchiveRefused)(error)).toBe(true);
    if (Schema.is(ArchiveRefused)(error)) {
      expect(error.operation).toBe("read-archive");
      expect(error.reason).toContain("declared root never appears");
      expect(error.message).toContain("Action:");
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  }
  expect(new MaintenanceRenderError({ reason: "Caller-defined invariant" }).reason).toBe(
    "Caller-defined invariant",
  );
  const listener = new ListenerExposure({ receipt: "example receipt" });
  expect(listener.receipt).toBe("example receipt");
  expect(listener.operation).toBe("validate-listeners");
  expect(listener.message).toContain("Startup listener contract violated");
});
