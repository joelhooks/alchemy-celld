import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { makeFakeShell } from "../src/fake-shell.ts";
import type { Call } from "../src/fake-shell.ts";
import {
  deleteDirectory,
  deleteFile,
  readFile,
  reconcileDirectory,
  reconcileFile,
  digest,
  validateFile,
} from "../src/files.ts";
import { reconcileBinary, verifiedBytes } from "../src/release.ts";
import type { BinaryProps } from "../src/release.ts";
import { shellQuote } from "../src/ssh.ts";
import { deleteUnit, readUnit, reconcileUnit, validateUnit } from "../src/systemd.ts";
import type { UnitProps } from "../src/systemd.ts";
import { wantsLinkScript } from "../src/unit-cleanup.ts";
import { service } from "./fixtures.ts";

const mutations = (calls: readonly Call[]) =>
  calls.flatMap((call) => {
    if (call.operation === "exec" && call.argv[2] === wantsLinkScript) {
      return [`wants-${call.argv[5]}`];
    }

    if (call.operation === "exec" && call.argv[2] !== "show") {
      return [call.argv[2]];
    }

    return ["write", "remove", "mkdir", "rmdir"].includes(call.operation) ? [call.operation] : [];
  });

describe("user unit lifecycle", () => {
  it.effect("declares an inactive implicit slice without treating it as a foreign fragment", () =>
    Effect.gen(function* implicit() {
      const fake = yield* makeFakeShell();

      const shell = {
        ...fake.shell,
        exec: Effect.fn("Test.implicitSlice")(function* exec(argv: readonly string[]) {
          const result = yield* fake.shell.exec(argv);

          if (
            argv[2] === "show" &&
            argv[3]?.endsWith(".slice") === true &&
            result.stdout.includes("LoadState=not-found")
          ) {
            return {
              code: 0,
              stdout:
                "LoadState=loaded\nActiveState=inactive\nUnitFileState=\nNeedDaemonReload=no\nFragmentPath=\n",
            };
          }

          return result;
        }),
      };

      const props: UnitProps = {
        home: "/home/example",
        name: "celld.slice",
        scope: "user",
        sections: [{ lines: [["MemoryMax", "4G"]], name: "Slice" }],
      };

      const output = yield* reconcileUnit(shell, props, undefined, false);
      expect(output.active).toBe(true);
      expect(output.enabled).toBe(false);
      yield* deleteUnit(shell, output);
    }),
  );
  it.effect(
    "refuses unapproved or mismatching adoption and invalid declarations without writes",
    () =>
      Effect.gen(function* refusals() {
        const fake = yield* makeFakeShell();

        const output = yield* reconcileUnit(fake.shell, service(), undefined, false);

        yield* fake.clear();
        expect(
          yield* reconcileUnit(fake.shell, service(), undefined, false).pipe(Effect.isFailure),
        ).toBe(true);
        expect(
          yield* reconcileUnit(
            fake.shell,
            service(undefined, undefined, "60M"),
            undefined,
            true,
          ).pipe(Effect.isFailure),
        ).toBe(true);
        expect(
          yield* validateUnit({ ...service(), name: "../other.service" }).pipe(Effect.isFailure),
        ).toBe(true);
        expect(
          yield* validateUnit({
            ...service(),
            sections: [{ lines: [["ExecStart", "bad\nInjected=yes"]], name: "Service" }],
          }).pipe(Effect.isFailure),
        ).toBe(true);
        expect(mutations(yield* fake.calls())).toEqual([]);
        yield* deleteUnit(fake.shell, output);
      }),
  );

  it.effect("cleans a failed create and recovers a failed update with the stored digest", () =>
    Effect.gen(function* recovery() {
      const fake = yield* makeFakeShell();
      yield* fake.failStart();
      expect(
        yield* reconcileUnit(fake.shell, service(), undefined, false).pipe(Effect.isFailure),
      ).toBe(true);
      expect(yield* readUnit(fake.shell, service())).toBeUndefined();

      const before = yield* reconcileUnit(fake.shell, service(), undefined, false);

      const next = service(undefined, undefined, "60M");
      yield* fake.failStart();
      expect(yield* reconcileUnit(fake.shell, next, before, false).pipe(Effect.isFailure)).toBe(
        true,
      );
      yield* fake.clear();
      const after = yield* reconcileUnit(fake.shell, next, before, false);
      expect(mutations(yield* fake.calls())).toEqual(["restart"]);
      yield* deleteUnit(fake.shell, after);
    }),
  );
});

describe("files, directories and releases", () => {
  it.effect(
    "refuses traversal, root, trailing separators and control characters at the path boundary",
    () =>
      Effect.gen(function* paths() {
        for (const path of [
          "/",
          "/../tool",
          "/./tool",
          "/srv/example/../tool",
          "/srv//example",
          "/srv/example/",
          "/srv/example\n",
          "/srv/example\0",
        ]) {
          expect(yield* validateFile({ content: "example", path }).pipe(Effect.isFailure)).toBe(
            true,
          );
        }

        expect((yield* validateFile({ content: "example", path: "/x" })).path).toBe("/x");
      }),
  );
  it.effect("updates only changed bytes or mode and deletes empty directories only", () =>
    Effect.gen(function* files() {
      const fake = yield* makeFakeShell();

      const dir = yield* reconcileDirectory(
        fake.shell,
        { mode: 0o700, path: "/srv/example/config" },
        undefined,
        false,
      );

      const props = {
        content: "invented value",
        mode: 0o600,
        path: `${dir.path}/settings`,
      };

      const file = yield* reconcileFile(fake.shell, props, undefined, false);
      expect(file.mode).toBe(0o600);
      yield* fake.clear();
      yield* reconcileFile(fake.shell, props, file, false);
      expect(mutations(yield* fake.calls())).toEqual([]);

      const changed = yield* reconcileFile(fake.shell, { ...props, content: "next" }, file, false);

      expect(changed.sha256).not.toBe(file.sha256);
      expect(yield* deleteDirectory(fake.shell, dir).pipe(Effect.isFailure)).toBe(true);

      const mode = yield* reconcileFile(
        fake.shell,
        { ...props, content: "next", mode: 0o640 },
        changed,
        false,
      );

      expect(mode.mode).toBe(0o640);
      yield* deleteFile(fake.shell, mode);
      yield* deleteDirectory(fake.shell, dir);
      expect(yield* fake.shell.stat(dir.path)).toBeUndefined();
    }),
  );

  it.effect(
    "refuses missing pins and wrong checksums before writes, installs then adopts pinned bytes",
    () =>
      Effect.gen(function* release() {
        const fake = yield* makeFakeShell();
        const bytes = new TextEncoder().encode("invented binary");

        const props: BinaryProps = {
          asset: { format: "raw" },
          path: "/srv/example/binary",
          sha256: digest(bytes),
          size: bytes.length,
          url: "https://github.com/example/project/releases/download/v1/tool",
        };

        let downloads = 0;

        const source = {
          get: () =>
            Effect.sync(() => {
              downloads += 1;

              return bytes;
            }),
        };

        expect(
          yield* reconcileBinary(
            fake.shell,
            source,
            { ...props, sha256: "" },
            undefined,
            false,
          ).pipe(Effect.isFailure),
        ).toBe(true);
        expect(
          yield* verifiedBytes(bytes, {
            ...props,
            sha256: "0".repeat(64),
          }).pipe(Effect.isFailure),
        ).toBe(true);
        expect(downloads).toBe(0);
        expect(mutations(yield* fake.calls())).toEqual([]);

        const file = yield* reconcileBinary(fake.shell, source, props, undefined, false);

        expect(file.mode).toBe(0o755);
        yield* reconcileBinary(fake.shell, source, props, file, false);
        yield* reconcileBinary(fake.shell, source, props, undefined, true);
        expect(downloads).toBe(1);
        expect(
          yield* reconcileBinary(
            fake.shell,
            source,
            { ...props, sha256: "0".repeat(64) },
            undefined,
            true,
          ).pipe(Effect.isFailure),
        ).toBe(true);
        yield* deleteFile(fake.shell, file);
        expect(yield* readFile(fake.shell, props.path)).toBeUndefined();
      }),
  );

  it("quotes remote arguments without interpolation", () => {
    expect(shellQuote("a b'$HOME;echo x")).toBe("'a b'\\''$HOME;echo x'");
  });
});
