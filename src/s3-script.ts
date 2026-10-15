import { cacheIoScript } from "./cache-io-script.ts";
import { objectArchiveScript } from "./object-archive-script.ts";

export const s3Script = String.raw`
import concurrent.futures, datetime, hashlib, hmac, http.client, io, json, os, pathlib, sys, tarfile, threading, urllib.parse, uuid, xml.etree.ElementTree as ET
config, endpoint, bucket, operation = sys.argv[1:5]
with open(config) as f:
    credential = json.load(f)['identities'][0]['credentials'][0]
access, secret = credential['accessKey'], credential['secretKey']
if bucket == '@environment' and operation == 'import':
    lines = (pathlib.Path(config).parent / 'celld.env').read_text().splitlines()
    values = {line.split('=', 1)[0]: line.split('=', 1)[1] for line in lines if '=' in line}
    location = json.loads(values['CELLD_BUCKET'])
    if not location.startswith('s3://'):
        raise RuntimeError('Expected store bucket')
    bucket = location[5:]
    if json.loads(values['S3_ENDPOINT']) != endpoint:
        raise RuntimeError('Backup endpoint mismatch')
base = urllib.parse.urlsplit(endpoint)

def request(method, key='', query='', conditional=False, payload=None, sink=None, payload_hash=None):
    path = '/' + bucket + ('/' + urllib.parse.quote(key, safe='/~') if key else '')
    now = datetime.datetime.now(datetime.timezone.utc)
    stamp, day = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
    if payload is None:
        payload = b'proof' if method == 'PUT' and key else b''
    hashed = payload_hash or hashlib.sha256(payload).hexdigest()
    headers = {'host': base.netloc, 'x-amz-content-sha256': hashed, 'x-amz-date': stamp}
    if payload_hash:
        current = payload.tell()
        payload.seek(0, 2)
        headers['content-length'] = str(payload.tell() - current)
        payload.seek(current)
    if conditional:
        headers['if-none-match'] = '*'
    names = sorted(headers)
    signed = ';'.join(names)
    canonical = '\n'.join([method, path, query, ''.join(n + ':' + headers[n] + '\n' for n in names), signed, hashed])
    scope = day + '/us-east-1/s3/aws4_request'
    string = '\n'.join(['AWS4-HMAC-SHA256', stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    k = ('AWS4' + secret).encode()
    for value in [day, 'us-east-1', 's3', 'aws4_request']:
        k = hmac.new(k, value.encode(), hashlib.sha256).digest()
    signature = hmac.new(k, string.encode(), hashlib.sha256).hexdigest()
    headers['authorization'] = 'AWS4-HMAC-SHA256 Credential=' + access + '/' + scope + ', SignedHeaders=' + signed + ', Signature=' + signature
    connection = http.client.HTTPConnection(base.hostname, base.port, timeout=2 if operation in ('ready', 'writable') else 30)
    try:
        connection.request(method, path + ('?' + query if query else ''), payload, headers)
        response = connection.getresponse()
        if sink is not None:
            h, size, tail = hashlib.sha256(), 0, b''
            overlap = max(len(access.encode()), len(secret.encode())) - 1
            for chunk in iter(lambda: response.read(1024 * 1024), b''):
                scanned = tail + chunk
                if access.encode() in scanned or secret.encode() in scanned:
                    raise RuntimeError('Backup object contains store credentials')
                tail = scanned[-overlap:] if overlap else b''
                sink.write(chunk)
                h.update(chunk)
                size += len(chunk)
            return response.status, (size, h.hexdigest(), response.getheader('ETag', ''))
        body = response.read(8 * 1024 * 1024 + 1)
        if len(body) > 8 * 1024 * 1024:
            raise RuntimeError('Oversized S3 response')
        return response.status, body
    finally:
        connection.close()

${cacheIoScript}
${objectArchiveScript}

if operation == 'import':
    source = pathlib.Path(sys.argv[5])
    import tempfile
    with cache_tar(source) as archive:
        validate_export(archive)
    def restore_object(entry, value):
        status, _ = request('PUT', entry['key'], payload=value, payload_hash=entry['sha256'])
        if status != 200:
            raise RuntimeError('Object restore write failed')
        with tempfile.TemporaryFile() as copied:
            code, result = request('GET', entry['key'], sink=copied)
        if code != 200 or result[1] != entry['sha256']:
            raise RuntimeError('Object restore readback mismatch')
    with cache_tar(source) as archive:
        count = walk_export(archive, restore_object)
    print('LOGICAL_OBJECT_IMPORT_PASSED ' + str(count))
elif operation == 'race':
    key = 'celld-probe/' + str(uuid.uuid4())
    barrier = threading.Barrier(50)
    def put(_):
        barrier.wait(timeout=30)
        return request('PUT', key, conditional=True)[0]
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=50) as pool:
            codes = list(pool.map(put, range(50)))
        print(json.dumps({'winners': codes.count(200), 'preconditions': codes.count(412), 'statuses': codes}))
    finally:
        status, _ = request('DELETE', key)
        if status != 204:
            raise RuntimeError('probe key cleanup failed')
elif operation == 'writable':
    key = 'celld-probe/' + str(uuid.uuid4())
    status, _ = request('PUT', key, conditional=True)
    if status == 200:
        cleanup, _ = request('DELETE', key)
        status = 200 if cleanup == 204 else cleanup
    print(json.dumps({'status': status, 'version': ''}))
elif operation == 'purge':
    token = ''
    while True:
        parameters = {'list-type': '2', 'max-keys': '1000'}
        if token:
            parameters['continuation-token'] = token
        query = urllib.parse.urlencode(sorted(parameters.items()), quote_via=urllib.parse.quote, safe='~')
        status, body = request('GET', query=query)
        if status == 404:
            break
        if status != 200:
            raise RuntimeError('bucket listing failed')
        page = ET.fromstring(body)
        for item in page.findall('./{*}Contents/{*}Key'):
            code, _ = request('DELETE', item.text or '')
            if code not in (204, 404):
                raise RuntimeError('owned object deletion failed')
        if page.findtext('./{*}IsTruncated', 'false') != 'true':
            break
        continuation = page.findtext('./{*}NextContinuationToken', '')
        if not continuation or continuation == token:
            raise RuntimeError('invalid listing cursor')
        token = continuation
    status, _ = request('DELETE')
    print(json.dumps({'status': status, 'version': ''}))
else:
    method = {'read': 'HEAD', 'create': 'PUT', 'delete': 'DELETE', 'version': 'GET', 'pointer': 'HEAD', 'ready': 'HEAD'}[operation]
    status, body = request(method, key='deploy/current.json' if operation == 'pointer' else '', query='versioning=' if operation == 'version' else '')
    version = ''
    if operation == 'version' and status == 200:
        root = ET.fromstring(body)
        version = next((item.text or '' for item in root.iter() if item.tag.split('}')[-1] == 'Status'), '')
    print(json.dumps({'status': status, 'version': version}))
`;
