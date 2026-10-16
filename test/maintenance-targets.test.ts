import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { renderMaintenanceScript, renderUnits } from "../src/index.ts";
import { instanceLayout } from "./fixture.ts";
import { localExec } from "../src/local-exec.ts";
import { assertMaintenanceIsolation, MaintenanceRenderError } from "../src/maintenance-targets.ts";

const host = {
  dataRoot: "/srv/example/mailbox",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

it.prop(
  "maintenance rendering uses only explicit instance targets and rejects foreign target ports",
  {
    port: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum: 65_526, minimum: 1024 }))),
    prefix: Arbitrary.schema(Schema.String),
  },
  ({ port, prefix }) => {
    const props = {
      dataRoot: "/srv/example/mischief",
      instance: "mischief",
      portBase: port,
      restartGate: false,
      maintenanceGuard: { refuses: [] as const },
    };

    const layout = instanceLayout(host, props);

    for (const target of [
      `http://127.0.0.1:${port + 10}`,
      `http://203.0.113.10:${layout.ports.master}`,
      `http://127.0.0.1:${layout.ports.filer}`,
      `https://127.0.0.1:${layout.ports.master}`,
    ]) {
      expect(() => {
        assertMaintenanceIsolation(layout, `${prefix}\n--master ${target}`);
      }).toThrow(MaintenanceRenderError);
    }

    const units = renderUnits(host, props, { celld: { memoryMax: `${port}M` } });
    expect(units.map(({ text }) => text).join("\n")).toContain(
      `--master http://127.0.0.1:${layout.ports.master} --filer http://127.0.0.1:${layout.ports.filer}`,
    );
    expect(renderMaintenanceScript(host, props).text).not.toContain("http://127.0.0.1:");
  },
);

const fixture = String.raw`
import contextlib, io, json, sys, urllib.error, urllib.parse, urllib.request
script = sys.argv[1]
base = int(sys.argv[2])
root = '/topics/.system/log'
calls = []
expected = {}
class Reply:
    def __init__(self, value): self.body = json.dumps(value).encode()
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, limit): return self.body
class Store:
    def open(self, request, **kwargs):
        url = request.full_url
        calls.append(url)
        if urllib.parse.urlsplit(url).path == root + '/':
            assert url.startswith(expected['filer'] + root + '/?'), url
            raise urllib.error.HTTPError(url, 404, 'missing root', {}, None)
        if url == expected['master'] + '/vol/status':
            return Reply({'Version': '4.48', 'Volumes': {'Max': 64, 'Free': 16, 'DataCenters': {'dc1': {'rack1': {'node1': [{'Id': 1, 'Collection': '', 'ReplicaPlacement': {}, 'Ttl': {'Count': 0, 'Unit': 0}}]}}}}})
        assert url == expected['master'] + '/dir/status', url
        return Reply({'Topology': {'Free': 16, 'Max': 64, 'Layouts': [{'collection': '', 'replication': '000', 'ttl': '', 'writables': [1]}]}})
urllib.request.build_opener = lambda *args: Store()
def run(action, instance, master, filer, missing=None):
    global expected
    calls.clear()
    expected = {'master': master, 'filer': filer}
    flags = {'--instance': instance, '--master': master, '--filer': filer, '--root': root}
    flags.pop(missing, None)
    sys.argv = ['maintenance', action] + [part for pair in flags.items() for part in pair]
    stdout, stderr = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            exec(script, {'__name__': '__main__'})
        except SystemExit as result:
            return result.code, stdout.getvalue()
    raise AssertionError('script did not exit')
master, filer = 'http://127.0.0.1:' + str(base + 4), 'http://127.0.0.1:' + str(base + 2)
for action in ('retain', 'diagnose'):
    code, output = run(action, 'mischief', master, filer)
    assert code == 0, output
    assert json.loads(output.splitlines()[-1])['alarm'] is False
    assert len(calls) == (3 if action == 'retain' else 2)
for missing in ('--instance', '--master', '--filer', '--root'):
    code, _ = run('retain', 'mischief', master, filer, missing)
    assert code != 0 and not calls
for invalid in ('http://0.0.0.0:1234', 'https://127.0.0.1:1234', 'http://user@127.0.0.1:1234', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:1234/path'):
    for use_master in (False, True):
        code, output = run('retain', 'mischief', invalid if use_master else master, filer if use_master else invalid)
        assert code != 0 and not calls, output
print('EXPLICIT_TARGETS_DRIVE_REQUESTS_AND_REFUSE_UNSAFE_ENDPOINTS')
`;

it.effect.prop(
  "maintenance requires every target flag and rejects unsafe endpoints before network I/O",
  {
    base: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 30_100, minimum: 30_010 })),
    ),
  },
  ({ base }) =>
    Effect.gen(function* targets() {
      const executor = yield* localExec;

      const script = renderMaintenanceScript(host, {
        dataRoot: "/srv/example/mischief",
        instance: "mischief",
        portBase: base,
        restartGate: false,
        maintenanceGuard: { refuses: [] },
      });

      const result = yield* executor.exec(["python3", "-c", fixture, script.text, String(base)]);

      expect(result.code, result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe(
        "EXPLICIT_TARGETS_DRIVE_REQUESTS_AND_REFUSE_UNSAFE_ENDPOINTS",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 8 } },
);
