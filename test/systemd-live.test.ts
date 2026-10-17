import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { hostname, homedir } from "node:os";
import { Crypto, Effect, FileSystem } from "effect";
import { describe, expect } from "vitest";

import { HostShell, must } from "../src/host-shell.ts";
import type { HostError, Interface } from "../src/host-shell.ts";
import { sliceUnit } from "../src/service-units.ts";
import { layer as sshLayer } from "../src/ssh.ts";
import { deleteUnit, readUnit, reconcileUnit, unitPath } from "../src/systemd.ts";
import type { UnitProps } from "../src/systemd.ts";

const enabled =
  process.env.FLEET_LIVE_NODE !== undefined && process.env.FLEET_START_APPROVED === "true";

const withUnits = (
  run: (shell: Interface, slice: UnitProps, service: UnitProps) => Effect.Effect<void, HostError>,
) =>
  Effect.gen(function* fixture() {
    const crypto = yield* Crypto.Crypto;
    const instance = `cdt${(yield* crypto.randomUUIDv4).replaceAll("-", "").slice(0, 12)}`;
    const home = homedir();
    const slice = sliceUnit(home, "64M", undefined, { instance });
    const service: UnitProps = {
      enabled: false,
      home,
      name: `${instance}-celld.service`,
      scope: "user",
      sections: [
        {
          name: "Service",
          lines: [
            ["ExecStart", "/bin/sleep infinity"],
            ["Slice", slice.name],
          ],
        },
      ],
    };
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${home}/.config/systemd/user`, { recursive: true });
    const connection = sshLayer(
      {
        dataRoot: `${home}/.cache/celld-systemd-test/${instance}`,
        home,
        ssh: hostname().split(".")[0]!,
        tailnetIPv4: "127.0.0.1",
      },
      { instance, portBase: 33000, restartGate: false },
      { transport: "local" },
    );

    yield* Effect.gen(function* connected() {
      const shell = yield* HostShell;
      for (const props of [service, slice]) {
        expect(yield* shell.stat(unitPath(props))).toBeUndefined();
        expect(
          (yield* must(shell, [
            "systemctl",
            "--user",
            "show",
            props.name,
            "--property=ActiveState",
            "--value",
          ])).trim(),
        ).toBe("inactive");
      }
      const cleanup = Effect.gen(function* cleanup() {
        for (const props of [service, slice]) {
          const output = yield* readUnit(shell, props);
          if (output !== undefined) {
            yield* deleteUnit(shell, output);
          }
          expect(yield* shell.stat(unitPath(props))).toBeUndefined();
          expect(
            (yield* must(shell, [
              "systemctl",
              "--user",
              "show",
              props.name,
              "--property=ActiveState",
              "--value",
            ])).trim(),
          ).toBe("inactive");
        }
      });
      yield* run(shell, slice, service).pipe(Effect.ensuring(cleanup.pipe(Effect.orDie)));
    }).pipe(Effect.provide(connection));
  }).pipe(Effect.provide(NodeServices.layer));

describe.skipIf(!enabled)(
  "real user-systemd reconciliation (FLEET_LIVE_NODE and FLEET_START_APPROVED=true)",
  () => {
    it.live(
      "a changed slice applies MemoryMax without restarting its member",
      () =>
        withUnits((shell, slice, service) =>
          Effect.gen(function* reload() {
            const before = yield* reconcileUnit(shell, slice, undefined, false);
            yield* reconcileUnit(shell, service, undefined, false);
            const identity = () =>
              must(shell, [
                "systemctl",
                "--user",
                "show",
                service.name,
                "--property=InvocationID,MainPID",
              ]);
            const original = yield* identity();
            expect(original).toMatch(/MainPID=[1-9]\d*/u);
            expect(original).toMatch(/InvocationID=[a-f0-9]{32}/u);
            const next = sliceUnit(slice.home, "96M", undefined, {
              instance: slice.name.slice(0, -6),
            });
            yield* reconcileUnit(shell, next, before, false);
            expect(yield* identity()).toBe(original);
            expect(
              (yield* must(shell, [
                "systemctl",
                "--user",
                "show",
                slice.name,
                "--property=MemoryMax",
                "--value",
              ])).trim(),
            ).toBe(String(96 * 1024 * 1024));
          }),
        ),
      30_000,
    );

    it.live(
      "a changed activating service settles before its single restart",
      () =>
        withUnits((shell, slice, service) =>
          Effect.gen(function* activation() {
            yield* reconcileUnit(shell, slice, undefined, false);
            const slow: UnitProps = {
              ...service,
              started: false,
              sections: [
                {
                  name: "Service",
                  lines: [
                    ["ExecStartPre", "/bin/sleep 2"],
                    ["ExecStart", "/bin/sleep infinity"],
                    ["Slice", slice.name],
                  ],
                },
              ],
            };
            const before = yield* reconcileUnit(shell, slow, undefined, false);
            yield* must(shell, ["systemctl", "--user", "start", "--no-block", service.name]);
            expect(
              (yield* must(shell, [
                "systemctl",
                "--user",
                "show",
                service.name,
                "--property=ActiveState",
                "--value",
              ])).trim(),
            ).toBe("activating");
            const states: string[] = [];
            const observing = {
              ...shell,
              exec: (argv: readonly string[]) =>
                Effect.gen(function* exec() {
                  if (argv[2] === "restart") {
                    states.push(
                      (yield* must(shell, [
                        "systemctl",
                        "--user",
                        "show",
                        service.name,
                        "--property=ActiveState",
                        "--value",
                      ])).trim(),
                    );
                  }
                  return yield* shell.exec(argv);
                }),
            };
            yield* reconcileUnit(
              observing,
              { ...slow, started: true, restartOn: ["changed"] },
              before,
              false,
            );
            expect(states).toEqual(["active"]);
          }),
        ),
      30_000,
    );
  },
);
