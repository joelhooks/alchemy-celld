export const maintenancePrelude = String.raw`import datetime
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

`;

export const maintenanceImplementation = String.raw`DAYS = 7
THRESHOLD = 8

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('storage diagnostic/retention refuses redirects')

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

def request(url, method='GET'):
    req = urllib.request.Request(url, method=method, headers={'Accept': 'application/json'})
    with opener.open(req, timeout=30) as response:
        body = response.read(8 * 1024 * 1024 + 1)
        if len(body) > 8 * 1024 * 1024:
            raise RuntimeError('storage response too large')
        result = json.loads(body) if body else {}
        if result.get('error'):
            raise RuntimeError('storage request failed: ' + str(result['error']))
        return result

def retention(call=request, now=None):
    today = (now or datetime.datetime.now(datetime.timezone.utc)).date()
    cutoff = today - datetime.timedelta(days=DAYS)
    cursor = ''
    targets = []
    # Bound work and refuse incomplete or non-advancing listings before deleting.
    for _ in range(100):
        query = urllib.parse.urlencode({'limit': 1000, 'lastFileName': cursor})
        try:
            page = call(FILER + ROOT + '/?' + query)
        except urllib.error.HTTPError as error:
            if error.code == 404 and not cursor:
                return 0
            raise
        if page.get('Path') != ROOT or not isinstance(page.get('Entries'), (list, type(None))):
            raise RuntimeError('unexpected metadata log listing')
        for entry in page['Entries'] or []:
            path = entry.get('FullPath', '')
            if not isinstance(path, str) or not re.fullmatch(re.escape(ROOT) + r'/[0-9]{4}-[0-9]{2}-[0-9]{2}', path):
                continue
            mode = entry.get('Mode', 0)
            if not isinstance(mode, int) or not mode & (1 << 31):
                continue
            try:
                date = datetime.date.fromisoformat(path[len(ROOT) + 1:])
            except ValueError:
                continue
            if date < cutoff:
                targets.append(path)
        if page.get('ShouldDisplayLoadMore') is False:
            break
        next_cursor = page.get('LastFileName')
        if not isinstance(next_cursor, str) or next_cursor <= cursor:
            raise RuntimeError('non-advancing metadata log listing')
        cursor = next_cursor
    else:
        raise RuntimeError('metadata log listing exceeded page budget')
    for path in sorted(set(targets)):
        call(FILER + path + '?recursive=true', 'DELETE')
    return len(set(targets))

def default_volume_count(call):
    status = call(MASTER + '/vol/status')
    if not isinstance(status, dict) or not isinstance(status.get('Version'), str) or not isinstance(status.get('Volumes'), dict):
        raise RuntimeError('invalid volume status')
    maximum, free = status['Volumes'].get('Max'), status['Volumes'].get('Free')
    if type(maximum) is not int or type(free) is not int or maximum <= 0 or free < 0 or free > maximum:
        raise RuntimeError('invalid volume slot counters')
    centers = status['Volumes'].get('DataCenters')
    if not isinstance(centers, dict):
        raise RuntimeError('invalid volume data centers')
    volumes = set()
    for racks in centers.values():
        if not isinstance(racks, dict):
            raise RuntimeError('invalid volume racks')
        for nodes in racks.values():
            if not isinstance(nodes, dict):
                raise RuntimeError('invalid volume nodes')
            for entries in nodes.values():
                if not isinstance(entries, list):
                    raise RuntimeError('invalid volume entries')
                for volume in entries:
                    if not isinstance(volume, dict) or type(volume.get('Id')) is not int or volume['Id'] <= 0 or not isinstance(volume.get('Collection'), str):
                        raise RuntimeError('invalid volume identity')
                    replica, ttl = volume.get('ReplicaPlacement'), volume.get('Ttl')
                    if not isinstance(replica, dict) or set(replica) - {'node', 'rack', 'dc'} or any(type(value) is not int or value < 0 or value > 9 for value in replica.values()):
                        raise RuntimeError('invalid volume replication')
                    if 100 * replica.get('dc', 0) + 10 * replica.get('rack', 0) + replica.get('node', 0) > 255:
                        raise RuntimeError('invalid volume replication encoding')
                    if not isinstance(ttl, dict) or set(ttl) != {'Count', 'Unit'} or type(ttl['Count']) is not int or not 0 <= ttl['Count'] <= 255 or type(ttl['Unit']) is not int or not 0 <= ttl['Unit'] <= 6:
                        raise RuntimeError('invalid volume ttl')
                    if volume['Collection'] == '' and not any(replica.values()) and (ttl['Count'] == 0 or ttl['Unit'] == 0):
                        volumes.add(volume['Id'])
    return len(volumes)

def diagnostic(call=request):
    topo = call(MASTER + '/dir/status')['Topology']
    free, maximum = topo['Free'], topo['Max']
    if type(free) is not int or type(maximum) is not int or maximum <= 0 or free < 0 or free > maximum:
        raise RuntimeError('invalid storage slot counters')
    layouts = topo['Layouts']
    if layouts is None:
        layouts = []
    if not isinstance(layouts, list):
        raise RuntimeError('invalid storage layouts')
    writable = set()
    for layout in layouts:
        if not isinstance(layout, dict) or any(not isinstance(layout.get(key), str) for key in ('collection', 'replication', 'ttl')) or (layout.get('writables') is not None and not isinstance(layout.get('writables'), list)):
            raise RuntimeError('invalid storage layout')
        # Match the metadata log's default collection / replication / no TTL.
        if layout['collection'] == '' and layout['replication'] == '000' and layout['ttl'] == '':
            for volume in layout['writables'] or []:
                if type(volume) is not int or volume <= 0:
                    raise RuntimeError('invalid writable volume id')
                writable.add(volume)
    default_volumes = default_volume_count(call)
    return {'freeVolumeSlots': free, 'maxVolumeSlots': maximum,
            'defaultCollectionWritableVolumes': len(writable),
            'alarm': free < THRESHOLD or (default_volumes > 0 and not writable),
            'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}

def main():
    if sys.argv[1:] not in (['retain'], ['diagnose']):
        raise RuntimeError('expected retain or diagnose')
    if sys.argv[1] == 'retain':
        print(json.dumps({'deletedLogDays': retention(), 'retentionDays': DAYS}), flush=True)
    signal = diagnostic()
    print(json.dumps(signal), flush=True)
    if signal['freeVolumeSlots'] < THRESHOLD:
        print('storage free-volume slots below threshold 8', file=sys.stderr, flush=True)
    elif signal['alarm']:
        print('storage has no writable volume in the default collection; node authority writes may fail', file=sys.stderr, flush=True)
    elif not signal['defaultCollectionWritableVolumes']:
        print('no writable default-collection volume yet; will grow on first write', file=sys.stderr, flush=True)
    return 1 if signal['alarm'] else 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'alarm': True, 'diagnosticUnavailable': True, 'error': str(error)}), flush=True)
        sys.exit(1)
`;

export const legacyMaintenanceScript = (master: number, filer: number) =>
  `${maintenancePrelude}ROOT = '/topics/.system/log'\nMASTER = 'http://127.0.0.1:${master}'\nFILER = 'http://127.0.0.1:${filer}'\n${maintenanceImplementation}`;

export const storageMaintenanceScript = legacyMaintenanceScript(31_004, 31_002);
