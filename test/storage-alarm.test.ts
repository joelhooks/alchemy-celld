import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { renderMaintenanceScript } from "../src/index.ts";
import { localExec } from "../src/local-exec.ts";
import { storageMaintenanceScript } from "../src/storage-maintenance-script.ts";

const fixture = String.raw`
import contextlib, io, json, sys, urllib.error, urllib.request
legacy, named, free = sys.argv[1], sys.argv[2], int(sys.argv[3])
fields = ['freeVolumeSlots', 'maxVolumeSlots', 'defaultCollectionWritableVolumes', 'alarm', 'observedAt']
current = {}
calls = []
def volume(identifier, collection='', replica=None, ttl=None):
    return {'Id': identifier, 'Collection': collection, 'ReplicaPlacement': {} if replica is None else replica,
            'Ttl': {'Count': 0, 'Unit': 0} if ttl is None else ttl, 'ReadOnly': False, 'Size': 0 if identifier <= current['writable'] else 32000000000}
def status(entries):
    return {'Version': '4.48', 'Volumes': {'Max': current['max'], 'Free': current['free'], 'DataCenters': {'dc1': {'rack1': {'example-node': entries}}}}}
class Reply:
    def __init__(self, value): self.body = json.dumps(value).encode()
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, limit): return self.body
class Store:
    def open(self, request, **kwargs):
        assert request.get_method() == 'GET'
        url = request.full_url
        calls.append(url)
        if '/topics/.system/log/' in url:
            raise urllib.error.HTTPError(url, 404, 'no log root', {}, None)
        if url.endswith('/dir/status'):
            layouts = [{'collection': 'example', 'replication': '000', 'ttl': '', 'writables': [100]},
                       {'collection': '', 'replication': '001', 'ttl': '', 'writables': [101]},
                       {'collection': '', 'replication': '000', 'ttl': '7d', 'writables': [102]}]
            if not current['volumes'] and not current.get('failure') and current.get('name') != 'foreign-only':
                layouts = []
            if current['layout']:
                layouts.append({'collection': '', 'replication': '000', 'ttl': '', 'writables': list(range(1, current['writable'] + 1)) or None})
            if current.get('name') == 'fresh': layouts = None
            return Reply({'Topology': {'Free': current['free'], 'Max': current['max'], 'Layouts': layouts}})
        assert url.endswith('/vol/status'), url
        failure = current.get('failure')
        if failure == 'http': raise urllib.error.HTTPError(url, 503, 'unavailable', {}, None)
        if failure == 'transport': raise urllib.error.URLError('connection refused')
        if failure == 'timeout': raise TimeoutError('timed out')
        if failure == 'shape': return Reply({})
        entries = [volume(i) for i in range(1, current['volumes'] + 1)]
        if current['volumes'] or current.get('name') == 'foreign-only':
            entries += [volume(100, 'example'), volume(101, replica={'node': 1}), volume(102, ttl={'Count': 7, 'Unit': 3})]
        if current.get('name') == 'mailbox':
            entries += [volume(i, 'example') for i in range(103, 171)]
            assert len(entries) == 103
        data = status(entries)
        if failure == 'centers': data['Volumes']['DataCenters'] = None
        if failure == 'racks': data['Volumes']['DataCenters']['dc1'] = []
        if failure == 'nodes': data['Volumes']['DataCenters']['dc1']['rack1'] = []
        if failure == 'entries': data['Volumes']['DataCenters']['dc1']['rack1']['example-node'] = {}
        if failure == 'collection': entries[0]['Collection'] = None
        if failure == 'replication': entries[0]['ReplicaPlacement'] = {'unexpected': 0}
        if failure == 'ttl': entries[0]['Ttl'] = {'count': 0, 'unit': 0}
        if failure == 'id': entries[0]['Id'] = True
        return Reply(data)
urllib.request.build_opener = lambda *args: Store()
cases = [
    ('fresh', 32, 32, 0, 0, False, False),
    ('empty-layout', 32, 32, 0, 0, True, False),
    ('foreign-only', 32, 64, 0, 0, True, False),
    ('cliff', 0, 32, 0, 0, False, True),
    ('low-free-writable', 7, 32, 1, 1, True, True),
    ('threshold', 8, 32, 0, 0, True, False),
    ('mature', free, 256, 8, 4, True, False),
    ('blocked', free, 256, 8, 0, True, True),
    ('mailbox', 153, 256, 32, 4, True, False)]
for failure in ('http', 'transport', 'timeout', 'shape', 'centers', 'racks', 'nodes', 'entries', 'collection', 'replication', 'ttl', 'id'):
    cases.append((failure, 32, 32, 1, 0, True, True))
for name, slots, maximum, count, writable, layout, alarm in cases:
    for action in ('retain', 'diagnose'):
        for script, is_named in ((legacy, False), (named, True)):
            current = {'name': name, 'free': slots, 'max': maximum, 'volumes': count, 'writable': writable, 'layout': layout}
            if name not in ('fresh', 'empty-layout', 'foreign-only', 'cliff', 'low-free-writable', 'threshold', 'mature', 'blocked', 'mailbox'):
                current['failure'] = name
            calls.clear()
            sys.argv = ['maintenance', action]
            if is_named:
                sys.argv += ['--instance', 'mischief', '--master', 'http://127.0.0.1:28014', '--filer', 'http://127.0.0.1:28012', '--root', '/topics/.system/log']
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try:
                    exec(script, {'__name__': '__main__'})
                except SystemExit as result:
                    code = result.code
            records = [json.loads(line) for line in out.getvalue().splitlines()]
            signal = records[-1]
            assert code == int(alarm), (name, action, is_named, out.getvalue(), err.getvalue())
            assert signal['alarm'] is alarm, (name, signal)
            if current.get('failure'):
                assert signal['diagnosticUnavailable'] is True, signal
            else:
                assert list(signal) == fields, signal
                assert signal['freeVolumeSlots'] == slots and signal['maxVolumeSlots'] == maximum
                assert signal['defaultCollectionWritableVolumes'] == writable, (name, signal)
                if name in ('fresh', 'empty-layout', 'foreign-only', 'threshold'):
                    assert 'no writable default-collection volume yet; will grow on first write' in err.getvalue()
                if name == 'mailbox':
                    assert err.getvalue() == ''
                    assert json.dumps(list(signal), separators=(',', ':')) == '["freeVolumeSlots","maxVolumeSlots","defaultCollectionWritableVolumes","alarm","observedAt"]'
            master = 'http://127.0.0.1:' + ('28014' if is_named else '31004')
            filer = 'http://127.0.0.1:' + ('28012' if is_named else '31002')
            expected = [master + '/dir/status', master + '/vol/status']
            if action == 'retain': expected.insert(0, filer + '/topics/.system/log/?limit=1000&lastFileName=')
            assert calls == expected, (name, calls)
print('STRUCTURAL_ALARMS_AND_FIVE_FIELD_WIRE_CONTRACT_PASSED')
`;

it.effect.prop(
  "actual retain/diagnose distinguish fresh, blocked and healthy stores and fail closed on volume-status errors",
  {
    free: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum: 256, minimum: 8 }))),
  },
  ({ free }) =>
    Effect.gen(function* alarm() {
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
          maintenanceGuard: { refuses: [] },
        },
      );

      const result = yield* executor.exec([
        "python3",
        "-c",
        fixture,
        storageMaintenanceScript,
        named.text,
        String(free),
      ]);

      expect(result.code, result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("STRUCTURAL_ALARMS_AND_FIVE_FIELD_WIRE_CONTRACT_PASSED");
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 4 } },
);
