// @effect-diagnostics nodeBuiltinImport:off -- The Python fixture evaluates argument guards without any network or service calls.
import { spawnSync } from "node:child_process";

import { it } from "@effect/vitest";
import {
  MaintenanceGuardSchema,
  renderMaintenanceScript,
  renderUnits,
  validateInstance,
} from "alchemy-celld";
import type { MaintenanceGuard } from "alchemy-celld";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { assertMaintenanceIsolation } from "../src/maintenance-targets.ts";

const host = {
  dataRoot: "/srv/example/cells",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};
const props = { instance: "example", portBase: 33_000, restartGate: false };
const maintenanceGuard: MaintenanceGuard = {
  base: 41_000,
  offsets: [11, 22, 33],
  exemptInstance: "example-old",
};

it("omission refuses to render, while an explicit empty tuple renders no guard", () => {
  // @ts-expect-error Plant: omission must fail at runtime too, not silently become the empty branch.
  expect(() => renderMaintenanceScript(host, props)).toThrow(/maintenanceGuard.*refuses/u);
  // @ts-expect-error The unit-rendering entry point must enforce the same requirement.
  expect(() => renderUnits(host, props)).toThrow(/maintenanceGuard.*refuses/u);
  const script = renderMaintenanceScript(host, { ...props, maintenanceGuard: { refuses: [] } });
  expect(script.text).not.toContain("mailbox_ports");
  expect(renderUnits(host, { ...props, maintenanceGuard: { refuses: [] } })).toHaveLength(5);
  // @ts-expect-error An empty tuple is not a list-based alternative for defining protected ports.
  const unsupported: MaintenanceGuard = { refuses: [41_011] };
  expect(Schema.is(MaintenanceGuardSchema)(unsupported)).toBe(false);
  expect(() =>
    renderMaintenanceScript(host, { ...props, maintenanceGuard: unsupported }),
  ).toThrow();
});

it.effect(
  "structured guard data renders canonical Python bytes and isolation detects a withdrawn block",
  () =>
    Effect.gen(function* protectedScript() {
      const selected = { ...props, maintenanceGuard };
      const layout = yield* validateInstance(host, selected);
      const script = renderMaintenanceScript(host, selected).text;
      const declaration = "mailbox_ports = {41000 + offset for offset in (11, 22, 33)}\n";
      const condition =
        '    if args.instance != "example-old" and port in mailbox_ports:\n        parser.error("named maintenance refuses mailbox ports")\n';
      expect(script).toContain(`args = parser.parse_args()\n${declaration}\ndef target`);
      expect(script).toContain(`${condition}    return value.rstrip("/")`);
      expect(() => assertMaintenanceIsolation(layout, script, "script")).not.toThrow();
      expect(() =>
        assertMaintenanceIsolation(layout, script.replace(declaration, ""), "script"),
      ).toThrow();
      expect(() =>
        assertMaintenanceIsolation(layout, script.replace(condition, ""), "script"),
      ).toThrow();
      const invalid: readonly unknown[] = [
        undefined,
        null,
        {},
        { refuses: [1] },
        { refuses: [], extra: true },
        { base: 41_000, offsets: [] },
        { base: 41_000, offsets: [11] },
        { base: 65_535, offsets: [1], exemptInstance: "example-old" },
        { base: -1, offsets: [11], exemptInstance: "example-old" },
        { base: 41_000, offsets: [1.5], exemptInstance: "example-old" },
        { base: 41_000, offsets: [11], exemptInstance: 'example"; raise Exception()' },
      ];
      for (const input of invalid) {
        // @ts-expect-error Deliberately simulate malformed untyped maintenance declarations.
        const malformed: MaintenanceGuard = input;
        expect(() =>
          renderMaintenanceScript(host, { ...props, maintenanceGuard: malformed }),
        ).toThrow(/maintenanceGuard/u);
      }
      expect(
        renderMaintenanceScript(host, {
          ...props,
          maintenanceGuard: { base: 41_000, offsets: [11], exemptInstance: "example-old" },
        }).text,
      ).toContain("(11,)}");
    }),
);

const harness = String.raw`
import contextlib, io, sys
script = sys.argv[1]
def run(instance, master, filer):
    sys.argv = ['maintenance', 'diagnose', '--instance', instance, '--master', 'http://127.0.0.1:' + str(master), '--filer', 'http://127.0.0.1:' + str(filer), '--root', '/topics/.system/log']
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            exec(script, {'__name__': 'guard_fixture'})
        except SystemExit as result:
            return result.code
    return 0
assert run('example', 33004, 33002) == 0
assert run('example', 41011, 33002) == 2
assert run('example', 33004, 41022) == 2
assert run('example-old', 41011, 41022) == 0
print('MAINTENANCE_GUARD_AND_EXEMPTION_OK')
`;

it("Python refuses protected targets for a neighbour and accepts the injected exemption", () => {
  const script = renderMaintenanceScript(host, { ...props, maintenanceGuard }).text;
  const result = spawnSync("python3", ["-c", harness, script], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("MAINTENANCE_GUARD_AND_EXEMPTION_OK");
});
