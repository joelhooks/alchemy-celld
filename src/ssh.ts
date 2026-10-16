import { Effect, Layer, Redacted, Schema, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { absent } from "./absent.ts";
import { assertDeletePath, instanceDeleteCustody } from "./delete-custody.ts";
import { HostError, HostShell } from "./host-shell.ts";
import type { Diagnostics, Interface, Result } from "./host-shell.ts";
import { validateInstance } from "./instance.ts";
import type { InstanceProps } from "./instance.ts";
import { NodeSchema } from "./inventory-schema.ts";
import type { Node } from "./inventory-schema.ts";

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const argvText = (argv: readonly string[]) => argv.map(shellQuote).join(" ");

export interface ShellTransport {
  readonly transport: "ssh" | "local";
}

export const layer = (
  node: Node,
  props: InstanceProps & { readonly dataRoot?: string },
  options?: ShellTransport,
) =>
  Layer.effect(
    HostShell,
    Effect.gen(function* makeSshShell() {
      const validated = yield* Schema.decodeEffect(NodeSchema)(node).pipe(
        Effect.mapError(
          () =>
            new HostError({
              operation: "connect",
              reason: "Invalid host facts; values redacted.",
              field: "node",
              expectedShape:
                "Normalized absolute home/dataRoot paths, a safe nonempty SSH target, and a literal IPv4 address",
              action:
                "Correct the private node inventory fields locally; do not log their values or attach raw schema issues.",
            }),
        ),
      );

      const layout = yield* validateInstance(validated, props);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const permits = yield* Semaphore.make(4);
      const transport = options?.transport ?? "ssh";

      if (transport === "local") {
        const hostname = yield* spawner
          .string(ChildProcess.make("hostname", ["-s"], { stdin: "ignore" }))
          .pipe(
            Effect.mapError(
              () =>
                new HostError({
                  operation: "connect",
                  reason: "Cannot read the local hostname.",
                }),
            ),
          );

        if (hostname.trim() !== validated.ssh.split("@").at(-1)) {
          return yield* new HostError({
            operation: "connect",
            reason: "Local transport requires the inventory node to be this host.",
          });
        }
      }

      const run = Effect.fn("HostShell.ssh")(
        function* run(script: string, bytes?: Uint8Array, diagnostics?: Diagnostics) {
          const errorChunks: Uint8Array[] = [];
          let errorBytes = 0;

          const stdin = bytes === undefined ? "ignore" : Stream.succeed(bytes);

          const handle = yield* spawner.spawn(
            transport === "local"
              ? ChildProcess.make("sh", ["-c", script], { stdin })
              : ChildProcess.make(
                  "ssh",
                  [
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    "-o",
                    "ConnectTimeout=10",
                    "--",
                    validated.ssh,
                    `sh -c ${shellQuote(script)}`,
                  ],
                  { stdin },
                ),
          );

          const result = yield* Effect.all(
            {
              code: handle.exitCode,
              output: Stream.runCollect(handle.stdout),
              stderr: Stream.runForEach(handle.stderr, (chunk) =>
                Effect.sync(() => {
                  if (diagnostics !== undefined && errorBytes < 16_384) {
                    const prefix = chunk.subarray(0, 16_384 - errorBytes);
                    errorChunks.push(prefix);
                    errorBytes += prefix.length;
                  }
                }),
              ),
            },
            { concurrency: "unbounded" },
          );

          if (transport === "ssh" && result.code === 255) {
            return yield* new HostError({
              operation: "ssh",
              reason: "SSH transport failed; values redacted.",
            });
          }

          const scrub = (text: string) => {
            let safe = text;

            for (const value of diagnostics?.redactions ?? []) {
              safe = safe.replaceAll(Redacted.value(value), "<redacted>");
            }

            for (const fact of [
              validated.home,
              layout.dataRoot,
              validated.ssh,
              validated.tailnetIPv4,
            ]) {
              safe = safe.replaceAll(fact, "<host>");
            }

            return safe;
          };

          const stdout = Buffer.concat(result.output).toString("utf-8");

          if (diagnostics === undefined) {
            return { code: Number(result.code), stdout } satisfies Result;
          }

          return {
            code: Number(result.code),
            stderr: scrub(Buffer.concat(errorChunks).toString("utf-8")),
            stdout: scrub(stdout.slice(0, 32_768)),
          } satisfies Result;
        },
        Effect.scoped,
        (effect) =>
          effect.pipe(
            permits.withPermits(1),
            Effect.timeoutOrElse({
              duration: "2 minutes",
              orElse: () =>
                Effect.fail(
                  new HostError({
                    operation: "ssh",
                    reason: "SSH command timed out.",
                  }),
                ),
            }),
            Effect.mapError(
              () =>
                new HostError({
                  operation: "ssh",
                  reason: "SSH command failed; values redacted.",
                }),
            ),
          ),
      );

      const checked = Effect.fn("HostShell.checked")(function* checked(
        script: string,
        bytes?: Uint8Array,
      ) {
        const result = yield* run(script, bytes);

        if (result.code !== 0) {
          return yield* new HostError({
            operation: "filesystem",
            reason: "Remote filesystem operation failed; values redacted.",
          });
        }

        return result.stdout;
      });

      const probe = yield* checked("uname -s; id -u");
      const [system, uid] = probe.trim().split("\n");

      if (system !== "Linux" || uid === undefined || !/^[1-9]\d*$/u.test(uid)) {
        return yield* new HostError({
          operation: "connect",
          reason: "Expected a non-root Linux user.",
        });
      }

      const shell: Interface = {
        checksum: Effect.fn("HostShell.checksum")(function* checksum(path) {
          const result = yield* checked(
            `test ! -L ${shellQuote(path)} && sha256sum -- ${shellQuote(path)}`,
          );

          const [sha256] = result.split(" ");

          if (sha256 === undefined || !/^[a-f0-9]{64}$/u.test(sha256)) {
            return yield* new HostError({
              operation: "checksum",
              reason: "Malformed remote checksum.",
            });
          }

          return sha256;
        }),
        deleteCustody: instanceDeleteCustody(validated.home, layout),
        exec: Effect.fn("HostShell.exec")((argv, diagnostics) =>
          run(`exec ${argvText(argv)}`, undefined, diagnostics),
        ),
        mkdir: Effect.fn("HostShell.mkdir")(({ path, mode }) =>
          checked(argvText(["mkdir", "-m", mode.toString(8), "--", path])).pipe(Effect.asVoid),
        ),
        purgeRoots: [layout.dataRoot, layout.configuration, layout.binaryRoot],
        read: Effect.fn("HostShell.read")(function* operation(path) {
          const p = shellQuote(path);

          const result = yield* run(
            `if [ -L ${p} ]; then exit 1; elif [ ! -e ${p} ]; then exit 44; else test -f ${p} && base64 -- ${p}; fi`,
          );

          if (result.code === 44) {
            return absent;
          }

          if (result.code !== 0) {
            return yield* new HostError({
              operation: "read",
              reason: "Cannot read regular file.",
            });
          }

          return Buffer.from(result.stdout, "base64");
        }),
        remove: Effect.fn("HostShell.remove")(function* remove(path) {
          yield* assertDeletePath(shell, path, "files");

          return yield* checked(
            `test ! -L ${shellQuote(path)} && rm -f -- ${shellQuote(path)}`,
          ).pipe(Effect.asVoid);
        }),
        rmdir: Effect.fn("HostShell.rmdir")(function* rmdir(path) {
          yield* assertDeletePath(shell, path, "directories");

          return yield* checked(argvText(["rmdir", "--", path])).pipe(Effect.asVoid);
        }),
        stat: Effect.fn("HostShell.stat")(function* operation(path) {
          const p = shellQuote(path);

          const result = yield* run(
            `if [ -L ${p} ]; then exit 1; elif [ ! -e ${p} ]; then exit 44; elif [ -f ${p} ]; then printf 'file '; stat -c '%a' -- ${p}; elif [ -d ${p} ]; then printf 'directory '; stat -c '%a' -- ${p}; else exit 1; fi`,
          );

          if (result.code === 44) {
            return absent;
          }

          const [kind, mode] = result.stdout.trim().split(" ");

          if (
            result.code !== 0 ||
            (kind !== "file" && kind !== "directory") ||
            mode === undefined ||
            !/^[0-7]{3,4}$/u.test(mode)
          ) {
            return yield* new HostError({
              operation: "stat",
              reason: "Cannot stat regular file or directory.",
            });
          }

          return { kind, mode: Number.parseInt(mode, 8) };
        }),
        write: Effect.fn("HostShell.write")(function* operation({ path, bytes, mode }) {
          const p = shellQuote(path);
          yield* checked(
            `test ! -L ${p} && t=$(mktemp ${shellQuote(`${path}.XXXXXX`)}) && trap 'rm -f -- "$t"' EXIT && cat > "$t" && chmod ${shellQuote(mode.toString(8))} -- "$t" && mv -f -- "$t" ${p}`,
            bytes,
          );
        }),
      };

      return HostShell.of(shell);
    }),
  );

export const Ssh = { layer };
