import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { makeFakeShell } from "../src/fake-shell.ts";
import type { Interface } from "../src/host-shell.ts";
import { reconcileUnit } from "../src/systemd.ts";
import { sliceUnit } from "./fixture.ts";
import { service } from "./fixtures.ts";

it.effect("a changed slice reloads without any service lifecycle command", () =>
  Effect.gen(function* reload() {
    const fake = yield* makeFakeShell();
    const before = yield* reconcileUnit(
      fake.shell,
      sliceUnit("/home/example", "64M"),
      undefined,
      false,
    );
    yield* fake.clear();
    yield* reconcileUnit(fake.shell, sliceUnit("/home/example", "96M"), before, false);
    const calls = (yield* fake.calls()).map((call) => call.argv);
    expect(calls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
    expect(
      calls.filter(
        (argv) => argv[0] === "systemctl" && ["restart", "start", "stop"].includes(argv[2] ?? ""),
      ),
    ).toEqual([]);
  }),
);

it.effect("an activating service times out after 150 seconds without a restart", () =>
  Effect.gen(function* timeout() {
    const fake = yield* makeFakeShell();
    const before = yield* reconcileUnit(fake.shell, service(), undefined, false);
    yield* fake.clear();
    const shell: Interface = {
      ...fake.shell,
      exec: (argv, diagnostics) =>
        argv.includes("--property=ActiveState") && argv.includes("--value")
          ? Effect.succeed({ code: 0, stdout: "activating\n" })
          : fake.shell.exec(argv, diagnostics),
    };
    const child = yield* Effect.forkChild(
      reconcileUnit(shell, service(undefined, undefined, "96M"), before, false).pipe(Effect.flip),
    );
    yield* TestClock.adjust("151 seconds");
    expect((yield* Fiber.join(child)).reason).toBe("Unit stayed activating; restart refused.");
    expect((yield* fake.calls()).filter((call) => call.argv[2] === "restart")).toEqual([]);
  }),
);

for (const response of [
  { code: 1, stdout: "active\n" },
  { code: 0, stdout: "" },
]) {
  it.effect(
    `an unusable settlement read (${response.code}, ${JSON.stringify(response.stdout)}) refuses restart`,
    () =>
      Effect.gen(function* failedRead() {
        const fake = yield* makeFakeShell();
        const before = yield* reconcileUnit(fake.shell, service(), undefined, false);
        yield* fake.clear();
        const shell: Interface = {
          ...fake.shell,
          exec: (argv, diagnostics) =>
            argv.includes("--property=ActiveState") && argv.includes("--value")
              ? Effect.succeed(response)
              : fake.shell.exec(argv, diagnostics),
        };
        const failure = yield* reconcileUnit(
          shell,
          service(undefined, undefined, "96M"),
          before,
          false,
        ).pipe(Effect.flip);
        expect(failure._tag).toBe("HostError");
        expect((yield* fake.calls()).filter((call) => call.argv[2] === "restart")).toEqual([]);
      }),
  );
}
