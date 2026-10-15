import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { renderMaintenanceScript } from "../src/index.ts";
import { localExec } from "../src/local-exec.ts";
import { storageMaintenanceScript } from "../src/storage-maintenance-script.ts";

const fixture = String.raw`
import contextlib, io, json, sys, urllib.error, urllib.parse, urllib.request
scenario = sys.argv[1]
script = sys.argv[2]
free = int(sys.argv[3])
calls = []
class Reply:
    def __init__(self, value): self.body = json.dumps(value).encode()
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, limit): return self.body
class Store:
    def open(self, request, **kwargs):
        url, method = request.full_url, request.get_method()
        calls.append((method, url))
        parsed = urllib.parse.urlsplit(url)
        if method == 'DELETE':
            raise urllib.error.HTTPError(url, 404, 'missing day', {}, None)
        if parsed.path == '/topics/.system/log/':
            cursor = urllib.parse.parse_qs(parsed.query).get('lastFileName', [''])[0]
            if scenario == 'filerTransport': raise urllib.error.URLError('connection refused')
            if scenario == 'filer503': raise urllib.error.HTTPError(url, 503, 'unavailable', {}, None)
            if scenario == 'existing': return Reply({'Path': '/topics/.system/log', 'Entries': [], 'ShouldDisplayLoadMore': False})
            if scenario in ('delete404', 'page404') and not cursor:
                return Reply({'Path': '/topics/.system/log', 'Entries': [{'FullPath': '/topics/.system/log/2020-01-01', 'Mode': 1 << 31}], 'ShouldDisplayLoadMore': scenario == 'page404', 'LastFileName': '2020-01-01'})
            raise urllib.error.HTTPError(url, 404, 'missing root', {}, None)
        if parsed.path == '/vol/status':
            return Reply({'Version': '4.48', 'Volumes': {'Max': 64, 'Free': free, 'DataCenters': {'dc1': {'rack1': {'node1': [{'Id': 1, 'Collection': '', 'ReplicaPlacement': {}, 'Ttl': {'Count': 0, 'Unit': 0}}]}}}}})
        if parsed.path == '/dir/status':
            if scenario == 'masterTransport': raise urllib.error.URLError('connection refused')
            if scenario in ('master404', 'master503'):
                raise urllib.error.HTTPError(url, 404 if scenario == 'master404' else 503, 'unavailable', {}, None)
            return Reply({'Topology': {'Free': free, 'Max': 64, 'Layouts': [{'collection': '', 'replication': '000', 'ttl': '', 'writables': [1]}]}})
        raise AssertionError('unexpected request')
urllib.request.build_opener = lambda *args: Store()
named = sys.argv[4] == 'named'
sys.argv = ['maintenance', 'retain']
if named:
    sys.argv += ['--instance', 'mischief', '--master', 'http://127.0.0.1:28014', '--filer', 'http://127.0.0.1:28012', '--root', '/topics/.system/log']
stdout, stderr = io.StringIO(), io.StringIO()
with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
    try:
        exec(script, {'__name__': '__main__'})
    except SystemExit as result:
        code = result.code
records = [json.loads(line) for line in stdout.getvalue().splitlines()]
if scenario in ('fresh', 'existing'):
    assert code == 0, stdout.getvalue()
    assert type(records[0]['deletedLogDays']) is int, records[0]
    assert records[0]['deletedLogDays'] == 0
    assert records[-1]['alarm'] is False
    assert [urllib.parse.urlsplit(url).path for method, url in calls] == ['/topics/.system/log/', '/dir/status', '/vol/status']
else:
    assert code != 0, stdout.getvalue()
    assert records[-1]['alarm'] is True
if scenario not in ('delete404',):
    assert not any(method == 'DELETE' for method, url in calls)
print('FRESH_ROOT_AND_OUTAGE_BOUNDARIES_PASSED')
`;

it.effect.prop(
  "fresh and existing ROOT emit integer deletion counts while outages and interrupted listings still alarm",
  {
    free: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum: 64, minimum: 8 }))),
  },
  ({ free }) =>
    Effect.gen(function* retain() {
      const executor = yield* localExec;

      const named = renderMaintenanceScript(
        {
          dataRoot: "/srv/example/mailbox",
          home: "/home/example",
          ssh: "example",
          tailnetIPv4: "203.0.113.10",
        },
        {
          dataRoot: "/srv/example/mischief",
          instance: "mischief",
          portBase: 28_010,
          restartGate: false,
        },
      );

      for (const { mode, script } of [
        { mode: "default", script: storageMaintenanceScript },
        { mode: "named", script: named.text },
      ]) {
        for (const scenario of [
          "fresh",
          "existing",
          "filerTransport",
          "filer503",
          "masterTransport",
          "master404",
          "master503",
          "delete404",
          "page404",
        ]) {
          const result = yield* executor.exec([
            "python3",
            "-c",
            fixture,
            scenario,
            script,
            String(free),
            mode,
          ]);

          expect(result.code, result.stdout).toBe(0);
          expect(result.stdout.trim()).toBe("FRESH_ROOT_AND_OUTAGE_BOUNDARIES_PASSED");
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 8 } },
);
