import { Effect, Layer } from "effect";

import { absent } from "./absent.ts";
import { bootstrapCleanupScript } from "./bootstrap-cleanup.ts";
import { assertDeletePath, isBootstrapDirectory } from "./delete-custody.ts";
import type { DeleteCustody as Custody } from "./delete-custody.ts";
import { HostShell, HostError } from "./host-shell.ts";
import type { Interface, Result } from "./host-shell.ts";
import { purgeScript, validatePurgePath } from "./purge.ts";
import { storeSocketScript, wantsLinkScript } from "./unit-cleanup.ts";

export interface Call {
  readonly operation: string;
  readonly argv: readonly string[];
}

interface StoredFile {
  readonly bytes: Uint8Array;
  readonly mode: number;
}

interface Unit {
  readonly path: string;
  readonly loaded: string;
  readonly active: boolean;
  readonly enabled: boolean;
}

export const makeFakeShell = Effect.fn("HostShell.fake")((custody?: Custody) =>
  Effect.sync(() => {
    const files = new Map<string, StoredFile>();

    const directories = new Map<string, number>([
      ["/home/example/.config/systemd/user", 0o755],
      ["/home/example/.config/celld", 0o700],
      ["/srv/example", 0o755],
      ["/home/example/.config", 0o755],
      ["/home/example/.local/share", 0o755],
    ]);

    const symlinks = new Map<string, string>();
    const units = new Map<string, Unit>();
    const calls: Call[] = [];
    let failStart = false;

    const record = (operation: string, argv: readonly string[]) => calls.push({ argv, operation });

    const chmod = (argv: readonly string[]): Result => {
      const [, rawMode, , path] = argv;

      if (path === undefined) {
        return { code: 1, stdout: "" };
      }

      const mode = Number.parseInt(rawMode ?? "", 8);
      const file = files.get(path);

      if (file !== undefined) {
        files.set(path, { ...file, mode });
      } else if (directories.has(path)) {
        directories.set(path, mode);
      } else {
        return { code: 1, stdout: "" };
      }

      return { code: 0, stdout: "" };
    };

    const reload = (): Result => {
      for (const [path, file] of files) {
        if (!/\.(?:service|slice|timer)$/u.test(path)) {
          continue;
        }

        const key = path.slice(path.lastIndexOf("/") + 1);
        const prior = units.get(key);
        units.set(key, {
          active: prior?.active ?? false,
          enabled: prior?.enabled ?? false,
          loaded: new TextDecoder().decode(file.bytes),
          path,
        });
      }

      for (const [key, unit] of units) {
        if (!files.has(unit.path) && !unit.active && !unit.enabled) {
          units.delete(key);
        }
      }

      return { code: 0, stdout: "" };
    };

    const show = (name: string): Result => {
      const unit = units.get(name);

      if (unit === undefined) {
        return {
          code: 0,
          stdout: "LoadState=not-found\nActiveState=inactive\n",
        };
      }

      return {
        code: 0,
        stdout: `LoadState=loaded\nActiveState=${unit.active ? "active" : "inactive"}\nSubState=${unit.active ? "running" : "dead"}\nUnitFileState=${unit.enabled ? "enabled" : "disabled"}\nNeedDaemonReload=${new TextDecoder().decode(files.get(unit.path)?.bytes) === unit.loaded ? "no" : "yes"}\nFragmentPath=${unit.path}\n`,
      };
    };

    const changeUnit = (action: string, name: string): Result => {
      const unit = units.get(name);

      if (unit === undefined) {
        return { code: 1, stdout: "" };
      }

      if ((action === "start" || action === "restart") && failStart) {
        failStart = false;

        return { code: 1, stdout: "" };
      }

      if (action === "enable" || action === "disable") {
        units.set(name, { ...unit, enabled: action === "enable" });
      } else if (["start", "restart", "stop"].includes(action)) {
        units.set(name, { ...unit, active: action !== "stop" });
      } else {
        return { code: 1, stdout: "" };
      }

      return { code: 0, stdout: "" };
    };

    const control = (action: string, name: string, argv: readonly string[]): Result => {
      if (action === "daemon-reload") {
        return reload();
      }

      if (action === "is-active") {
        const active = units.get(name)?.active === true;

        return {
          code: active ? 0 : 3,
          stdout: active ? "active\n" : "inactive\n",
        };
      }

      if (action === "show" && argv.includes("--value")) {
        if (argv.includes("--property=ActiveState")) {
          return {
            code: 0,
            stdout: units.get(name)?.active === true ? "active\n" : "inactive\n",
          };
        }

        if (argv.includes("--property=ControlGroup") && units.has(name)) {
          return {
            code: 0,
            stdout: `/${custody?.layout.slice ?? "celld.slice"}/${name}\n`,
          };
        }
      }

      if (action === "show") {
        return show(name);
      }

      return changeUnit(action, name);
    };

    const bootstrapCleanup = (root: string): Result => {
      if (files.has(root) || symlinks.has(root)) {
        return { code: 1, stdout: "" };
      }

      const paths = [...directories.keys(), ...files.keys(), ...symlinks.keys()].filter((path) =>
        isBootstrapDirectory(root, path),
      );

      for (const path of paths) {
        const children = [...files.keys(), ...directories.keys(), ...symlinks.keys()].filter(
          (child) => child.startsWith(`${path}/`),
        );

        if (
          !directories.has(path) ||
          symlinks.has(path) ||
          children.some(
            (child) =>
              !files.has(child) ||
              symlinks.has(child) ||
              ![`${path}/index.js`, `${path}/wrangler.json`].includes(child),
          )
        ) {
          return { code: 1, stdout: "" };
        }
      }

      return { code: 0, stdout: JSON.stringify(paths) };
    };

    const unitCleanup = (argv: readonly string[]): Result | undefined => {
      if (argv[0] !== "python3") {
        return absent;
      }

      if (argv[2] === bootstrapCleanupScript) {
        return bootstrapCleanup(argv[3] ?? "");
      }

      if (argv[2] === storeSocketScript) {
        return { code: 0, stdout: "ready" };
      }

      if (argv[2] !== wantsLinkScript) {
        return absent;
      }

      const home = argv[3] ?? "";
      const unit = argv[4] ?? "";
      const target = `${home}/.config/systemd/user/${unit}`;
      const link = `${home}/.config/systemd/user/default.target.wants/${unit}`;
      const existing = symlinks.get(link);

      if (existing !== undefined && existing !== target) {
        return { code: 1, stdout: "" };
      }

      if (argv[5] === "remove") {
        symlinks.delete(link);
      }

      return { code: 0, stdout: "ready" };
    };

    const shell: Interface = {
      deleteCustody: custody,
      exec: Effect.fn("HostShell.fake.exec")(function* exec(argv) {
        record("exec", argv);
        const [program, scope, action = "", name = ""] = argv;

        const cleanup = unitCleanup(argv);

        if (cleanup !== undefined) {
          return cleanup;
        }

        if (program === "python3" && argv[2] === purgeScript) {
          const root = argv.at(3) ?? "";
          const target = argv.at(4) ?? "";

          if (
            !validatePurgePath(target, root) ||
            !directories.has(root) ||
            [...symlinks.keys()].some(
              (link) =>
                link === root ||
                root.startsWith(`${link}/`) ||
                link === target ||
                link.startsWith(`${target}/`),
            )
          ) {
            return { code: 1, stdout: "" };
          }

          for (const key of files.keys()) {
            if (key.startsWith(`${target}/`)) {
              files.delete(key);
            }
          }

          for (const key of directories.keys()) {
            if (key === target || key.startsWith(`${target}/`)) {
              directories.delete(key);
            }
          }

          return { code: 0, stdout: "" };
        }

        if (program === "chmod") {
          return chmod(argv);
        }

        if (program !== "systemctl" || scope !== "--user") {
          const received = [
            "systemctl",
            "chmod",
            "python3",
            "echo",
            "curl",
            "node",
            "sh",
            "bash",
            "ls",
            "cat",
            "whoami",
            "mkdir",
            "rm",
            "true",
            "false",
          ].includes(program ?? "")
            ? program
            : "<redacted command>";
          return yield* new HostError({
            operation: "exec",
            reason: `Fake refuses unknown command. Received program: ${received}; arguments redacted.`,
            field: "argv",
            actual: `${received}; arguments redacted`,
            expectedShape:
              "chmod; systemctl --user; python3 with a recognised cleanup or purge script",
            action:
              "Use an accepted fake command or explicitly add support to the test transport; do not send arbitrary shell text.",
          });
        }

        return control(action, name, argv);
      }),
      mkdir: Effect.fn("HostShell.fake.mkdir")(function* mkdir({ path, mode }) {
        record("mkdir", [path]);

        if (
          !directories.has(path.slice(0, path.lastIndexOf("/"))) ||
          files.has(path) ||
          directories.has(path)
        ) {
          return yield* new HostError({
            operation: "mkdir",
            reason: "Invalid directory creation.",
            field: !directories.has(path.slice(0, path.lastIndexOf("/"))) ? "path.parent" : "path",
            actual: !directories.has(path.slice(0, path.lastIndexOf("/")))
              ? "absent parent"
              : files.has(path)
                ? "existing file"
                : "existing directory",
            expectedShape:
              "An absent child directory with an existing parent directory; path value redacted",
            action: !directories.has(path.slice(0, path.lastIndexOf("/")))
              ? "Create the parent directory first, then retry the declared child."
              : "Use an unused directory path or explicitly reconcile/adopt the existing owned directory.",
          });
        }

        directories.set(path, mode);

        return yield* Effect.void;
      }),
      purgeRoots: [
        "/srv/example",
        "/home/example/.config/celld",
        "/home/example/.local/share/celld",
      ],
      read: Effect.fn("HostShell.fake.read")((path) =>
        Effect.sync(() => {
          record("read", [path]);
          const file = files.get(path);

          return file === undefined ? undefined : new Uint8Array(file.bytes);
        }),
      ),
      remove: Effect.fn("HostShell.fake.remove")(function* remove(path) {
        yield* assertDeletePath(shell, path, "files");
        record("remove", [path]);
        files.delete(path);
      }),
      rmdir: Effect.fn("HostShell.fake.rmdir")(function* rmdir(path) {
        yield* assertDeletePath(shell, path, "directories");
        record("rmdir", [path]);

        if ([...files.keys(), ...directories.keys()].some((name) => name.startsWith(`${path}/`))) {
          return yield* new HostError({
            operation: "rmdir",
            reason: "Directory is not empty.",
            field: "path.children",
            expectedShape: "An empty owned directory",
            action: "Remove only declared owned children before removing their parent directory.",
          });
        }

        directories.delete(path);

        return yield* Effect.void;
      }),
      stat: Effect.fn("HostShell.fake.stat")((path) =>
        Effect.sync(() => {
          record("stat", [path]);
          const file = files.get(path);

          if (file !== undefined) {
            return { kind: "file" as const, mode: file.mode };
          }

          const mode = directories.get(path);

          return mode === undefined ? undefined : { kind: "directory" as const, mode };
        }),
      ),
      write: Effect.fn("HostShell.fake.write")(function* write({ path, bytes, mode }) {
        record("write", [path]);

        if (!directories.has(path.slice(0, path.lastIndexOf("/")))) {
          return yield* new HostError({
            operation: "write",
            reason: "Missing parent.",
            field: "path.parent",
            expectedShape: "An existing parent directory",
            action: "Declare or reconcile the parent directory before writing the file.",
          });
        }

        files.set(path, { bytes: new Uint8Array(bytes), mode });

        return yield* Effect.void;
      }),
    };

    return {
      archive: Effect.fn("HostShell.fake.archive")(function* archive(
        path: string,
        destination: string,
      ) {
        const file = files.get(path);

        if (
          file === undefined ||
          files.has(destination) ||
          directories.has(destination) ||
          symlinks.has(destination)
        ) {
          return yield* new HostError({
            operation: "archive",
            reason: "Invalid external archive move.",
            field: file === undefined ? "source" : "destination",
            expectedShape:
              "An existing source file and an unused destination path; values redacted",
            action:
              "Supply an existing source and choose a destination without a file, directory or symlink collision.",
          });
        }

        return yield* Effect.sync(() => {
          files.set(destination, file);
          files.delete(path);

          return { destination, source: path };
        });
      }),
      calls: () => Effect.sync(() => [...calls]),
      clear: () =>
        Effect.sync(() => {
          calls.length = 0;
        }),
      failStart: () =>
        Effect.sync(() => {
          failStart = true;
        }),
      shell: HostShell.of(shell),
      symlink: (path: string, target: string) =>
        Effect.sync(() => {
          symlinks.set(path, target);
        }),
      symlinkTarget: (path: string) => Effect.sync(() => symlinks.get(path)),
    };
  }),
);

export const offlineLayer = Layer.effect(
  HostShell,
  makeFakeShell().pipe(Effect.map((fake) => fake.shell)),
);
