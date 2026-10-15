import * as Test from "alchemy/Test/Vitest";
import { Context, Effect, Layer } from "effect";
import { expect } from "vitest";

import { makeFakeShell } from "../src/fake-shell.ts";
import { HostShell } from "../src/host-shell.ts";
import { SystemdUnit, SystemdUnitProvider } from "../src/providers.ts";
import { reconcileUnit, deleteUnit } from "../src/systemd.ts";
import { UnitStartup } from "../src/unit-startup.ts";
import { checkedStack } from "./checked-stack.ts";
import { service } from "./fixtures.ts";

class Fake extends Context.Service<
  Fake,
  Effect.Success<ReturnType<typeof makeFakeShell>> & {
    readonly startupCalls: string[];
  }
>()("Test/FakeShell") {}

const fake = Layer.effectContext(
  Effect.gen(function* makeTestShell() {
    const shell = yield* makeFakeShell();
    const startupCalls: string[] = [];

    return Context.make(Fake, { ...shell, startupCalls }).pipe(
      Context.add(HostShell, shell.shell),
      Context.add(UnitStartup, {
        afterStart: () =>
          Effect.sync(() => {
            startupCalls.push("after");
          }),
        beforeStart: () =>
          Effect.sync(() => {
            startupCalls.push("before");
          }),
      }),
    );
  }),
);

const { test } = Test.make({
  adopt: true,
  providers: SystemdUnitProvider().pipe(Layer.provideMerge(fake)),
  stage: "provider-tests",
});

test.provider(
  "Alchemy engine creates, updates, adopts, plans noop and deletes user units",
  (scratch) =>
    Effect.gen(function* provider() {
      const stack = checkedStack(scratch);

      const host = yield* Fake;
      const props = service();
      yield* stack.destroy().pipe(Effect.orDie);

      const deployed = yield* stack.deploy(SystemdUnit("unit", props)).pipe(Effect.orDie);

      expect(deployed.active).toBe(true);
      const trace = yield* Fake;
      expect(trace.startupCalls).toEqual(["before", "after"]);
      trace.startupCalls.length = 0;
      yield* host.clear();
      yield* stack.deploy(SystemdUnit("unit", props)).pipe(Effect.orDie);
      expect((yield* host.calls()).filter((call) => call.operation === "write")).toEqual([]);
      const next = service(undefined, undefined, "60M");

      const updated = yield* stack.deploy(SystemdUnit("unit", next)).pipe(Effect.orDie);

      expect(updated.sha256).not.toBe(deployed.sha256);
      expect(trace.startupCalls).toEqual(["before", "after"]);
      yield* stack.destroy().pipe(Effect.orDie);
      const seed = yield* reconcileUnit(host.shell, next, undefined, false);

      const adopt = Effect.gen(function* takeOver() {
        yield* host.clear();
        yield* stack.deploy(SystemdUnit("unit", next)).pipe(Effect.orDie);
        expect(
          (yield* host.calls()).filter(
            (call) =>
              call.operation === "write" || call.argv[2] === "restart" || call.argv[2] === "start",
          ),
        ).toEqual([]);

        const plan = yield* stack.plan(SystemdUnit("unit", next)).pipe(Effect.orDie);

        expect(Object.values(plan.resources).map((resource) => resource.action)).toEqual(["noop"]);
        yield* stack.destroy().pipe(Effect.orDie);
        expect(yield* host.shell.stat(seed.path)).toBeUndefined();
      });

      yield* adopt.pipe(Effect.ensuring(deleteUnit(host.shell, seed).pipe(Effect.orDie)));
    }),
);

test.provider("user service deletion disables, unlinks wants and unloads the unit", (scratch) =>
  Effect.gen(function* serviceDelete() {
    const stack = checkedStack(scratch);
    const host = yield* Fake;
    const props = service();
    const link = `${props.home}/.config/systemd/user/default.target.wants/${props.name}`;

    yield* stack.destroy().pipe(Effect.orDie);

    const output = yield* stack.deploy(SystemdUnit("service", props)).pipe(Effect.orDie);

    yield* host.symlink(link, output.path);
    yield* host.clear();
    yield* stack.destroy().pipe(Effect.orDie);

    expect(yield* host.shell.stat(output.path)).toBeUndefined();
    expect(yield* host.symlinkTarget(link)).toBeUndefined();

    const calls = yield* host.calls();

    expect(calls.some((call) => call.argv[2] === "disable" && call.argv[3] === props.name)).toBe(
      true,
    );
    expect(calls.some((call) => call.argv[2] === "daemon-reload")).toBe(true);

    const manager = yield* host.shell.exec(["systemctl", "--user", "show", props.name]);

    expect(manager.stdout).toContain("LoadState=not-found");
  }),
);
