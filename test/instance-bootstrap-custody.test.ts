import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Layer, Schema } from "effect";
import { expect } from "vitest";

import { bootstrapCleanupScript } from "../src/bootstrap-cleanup.ts";
import { assertDeletePath, instanceDeleteCustody } from "../src/delete-custody.ts";
import { makeFakeShell } from "../src/fake-shell.ts";
import { HostShell } from "../src/host-shell.ts";
import { startupLayer, InstanceNameSchema, instanceLayout } from "./fixture.ts";
import { localExec } from "../src/local-exec.ts";
import { UnitStartup } from "../src/unit-startup.ts";

const host = {
  dataRoot: "/srv/example/mailbox",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

const own = instanceLayout(host, {
  dataRoot: "/srv/example/mischiefrb",
  instance: "mischiefrb",
  portBase: 28_010,
});

const uuids = Arbitrary.schema(Schema.String.check(Schema.isUUID(4)));

it.effect.prop(
  "bootstrap custody admits only this root, lowercase UUIDv4 directories and the two known files",
  {
    other: Arbitrary.schema(
      InstanceNameSchema.check(Schema.makeFilter((name) => name !== own.instance)),
    ),
    uuid: uuids,
  },
  ({ uuid, other }) =>
    Effect.gen(function* admission() {
      const { shell } = yield* makeFakeShell(instanceDeleteCustody(host.home, own));

      const valid = uuid.toLowerCase();
      const directory = `${own.configuration}/bootstrap-${valid}`;

      expect(yield* assertDeletePath(shell, directory, "directories").pipe(Effect.isSuccess)).toBe(
        true,
      );

      for (const name of ["index.js", "wrangler.json"]) {
        expect(
          yield* assertDeletePath(shell, `${directory}/${name}`, "files").pipe(Effect.isSuccess),
        ).toBe(true);
      }

      for (const root of [
        `${host.home}/.config/celld`,
        `${host.home}/.config/${other}`,
        `${own.configuration}/nested`,
      ]) {
        const foreign = `${root}/bootstrap-${valid}`;
        expect(yield* assertDeletePath(shell, foreign, "directories").pipe(Effect.isFailure)).toBe(
          true,
        );
        expect(
          yield* assertDeletePath(shell, `${foreign}/index.js`, "files").pipe(Effect.isFailure),
        ).toBe(true);
      }

      for (const invalid of [
        `A${valid.slice(1)}`,
        `${valid.slice(0, 14)}5${valid.slice(15)}`,
        `${valid.slice(0, 19)}7${valid.slice(20)}`,
        `${valid}\n`,
        `${valid}/nested`,
        `${valid}/../bootstrap-${valid}`,
      ]) {
        const path = `${own.configuration}/bootstrap-${invalid}`;
        expect(yield* assertDeletePath(shell, path, "directories").pipe(Effect.isFailure)).toBe(
          true,
        );
        expect(
          yield* assertDeletePath(shell, `${path}/wrangler.json`, "files").pipe(Effect.isFailure),
        ).toBe(true);
      }

      for (const path of [`${directory}/other.js`, `${directory}/nested/index.js`]) {
        expect(yield* assertDeletePath(shell, path, "files").pipe(Effect.isFailure)).toBe(true);
      }
    }),
);

it.effect.prop(
  "named restore rejects any foreign archive before stat, import or deletion",
  {
    other: Arbitrary.schema(
      InstanceNameSchema.check(Schema.makeFilter((name) => name !== own.instance)),
    ),
  },
  ({ other }) =>
    Effect.gen(function* foreignRestore() {
      const fake = yield* makeFakeShell(instanceDeleteCustody(host.home, own));
      const { shell } = fake;
      yield* shell.mkdir({ mode: 0o700, path: own.configuration });
      yield* shell.write({
        bytes: new TextEncoder().encode(
          `CELLD_BUCKET="s3://example"\nS3_ENDPOINT="http://127.0.0.1:28016"\n`,
        ),
        mode: 0o600,
        path: `${own.configuration}/celld.env`,
      });
      yield* shell.write({
        bytes: new TextEncoder().encode(JSON.stringify({ identities: [] })),
        mode: 0o600,
        path: `${own.configuration}/s3.json`,
      });
      yield* fake.clear();

      const archive = `/srv/example/${other}/.mailbox-restore-objects.tar`;

      const startup = yield* UnitStartup.pipe(
        Effect.provide(
          startupLayer("127.0.0.1", "scope", archive, undefined, own).pipe(
            Layer.provide(Layer.succeed(HostShell, shell)),
          ),
        ),
      );

      expect(yield* startup.beforeStart(own.nodeUnit, host.home).pipe(Effect.isFailure)).toBe(true);
      const calls = yield* fake.calls();
      expect(
        calls.some(
          ({ operation, argv }) => ["stat", "remove"].includes(operation) && argv[0] === archive,
        ),
      ).toBe(false);
      expect(
        calls.some(({ operation, argv }) => operation === "exec" && argv.includes("import")),
      ).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
);

const listingFixture = String.raw`
import os, sys, tempfile
mode, uuid, source = sys.argv[1:]
with tempfile.TemporaryDirectory() as temporary:
    root = os.path.join(temporary, "configuration")
    outside = os.path.join(temporary, "outside")
    os.mkdir(outside)
    if mode == "root-link":
        os.symlink(outside, root)
    else:
        os.mkdir(root)
    path = os.path.join(root, "bootstrap-" + uuid)
    if mode == "directory-link":
        os.symlink(outside, path)
    else:
        os.mkdir(path)
        if mode == "file-link":
            os.symlink(outside, os.path.join(path, "index.js"))
        elif mode == "unknown-file":
            open(os.path.join(path, "other.js"), "wb").close()
        else:
            open(os.path.join(path, "index.js"), "wb").close()
    sys.argv = ["probe", root]
    exec(source)
`;

it.effect.prop(
  "bootstrap discovery validates real filesystem entries and refuses symlinks or unknown children",
  {
    mode: Arbitrary.schema(
      Schema.Literals(["clean", "root-link", "directory-link", "file-link", "unknown-file"]),
    ),
    uuid: uuids,
  },
  ({ uuid, mode }) =>
    Effect.gen(function* listing() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        listingFixture,
        mode,
        uuid.toLowerCase(),
        bootstrapCleanupScript,
      ]);

      expect(result.code === 0).toBe(mode === "clean");
    }).pipe(Effect.provide(NodeServices.layer)),
);
