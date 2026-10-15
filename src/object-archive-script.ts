export const objectArchiveScript = String.raw`
def forbidden_key(key):
    name = pathlib.PurePosixPath(key).name.lower()
    return name in {'peer-auth.json', 's3.json', 's3.config', 'celld.env', 'credentials', 'credentials.json', '.env', '.dev.vars'} or name.endswith(('.jwk', '.pem', '.key'))

def require_safe_key(key):
    if not isinstance(key, str) or not key or key.startswith('/') or '..' in key.split('/') or forbidden_key(key):
        raise RuntimeError('Backup refuses known credential/key object pattern')

def object_member(key):
    return 'objects/' + hashlib.sha256(key.encode()).hexdigest() + '.blob'

def walk_export(archive, consume=None):
    # Python tarfile caches even r| members unless explicitly released.
    import sqlite3, tempfile
    first = archive.next()
    if first is None:
        raise RuntimeError('Empty object export')
    if first.name != 'format.json':
        # Compatibility with the old format, whose index was bounded to 16 MiB.
        index = validate_legacy_export(archive)
        for entry in index['objects']:
            if consume:
                consume(entry, archive.extractfile(entry['member']))
        return len(index['objects'])
    if not first.isfile() or first.size > 1024 or json.load(archive.extractfile(first)) != {'format': 2}:
        raise RuntimeError('Unsupported object export')
    count = 0
    with tempfile.TemporaryDirectory() as tmp, sqlite3.connect(str(pathlib.Path(tmp) / 'seen.sqlite')) as seen:
        seen.execute('PRAGMA cache_size=-2048')
        seen.execute('CREATE TABLE keys (key TEXT PRIMARY KEY)')
        while True:
            archive.members.clear()
            meta = archive.next()
            if meta is None:
                return count
            if meta.name != 'entry.json' or not meta.isfile() or meta.size > 16384:
                raise RuntimeError('Invalid streaming object metadata')
            entry = json.load(archive.extractfile(meta))
            key = entry['key']
            require_safe_key(key)
            if entry['member'] != object_member(key):
                raise RuntimeError('Invalid object member')
            seen.execute('INSERT INTO keys VALUES (?)', (key,))
            archive.members.clear()
            info = archive.next()
            if info is None or not info.isfile() or info.name != entry['member']:
                raise RuntimeError('Missing object payload')
            h = hashlib.sha256()
            # The callback only sees verified data; bounded RAM even for a large object.
            with tempfile.TemporaryFile() as payload:
                writer = CacheWriter(payload)
                stream = archive.extractfile(info)
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    h.update(chunk)
                    if consume:
                        writer.write(chunk)
                if h.hexdigest() != entry['sha256']:
                    raise RuntimeError('Object export checksum mismatch')
                if consume:
                    writer.sync()
                    payload.seek(0)
                    reader = CacheReader(payload)
                    consume(entry, reader)
                    reader.release()
            count += 1
            if count % 1000 == 0:
                seen.commit()

def validate_export(archive):
    return walk_export(archive)

def validate_legacy_export(archive):
    member = archive.getmember('index.json')
    if not member.isfile() or member.size > 16 * 1024 * 1024:
        raise RuntimeError('Invalid object index')
    index = json.load(archive.extractfile(member))
    if index.get('format') != 1 or not isinstance(index.get('objects'), list):
        raise RuntimeError('Unsupported object export')
    seen = set()
    for entry in index['objects']:
        key, member = entry['key'], entry['member']
        require_safe_key(key)
        if key in seen or member != object_member(key):
            raise RuntimeError('Invalid object export member')
        seen.add(key)
        info = archive.getmember(member)
        if not info.isfile():
            raise RuntimeError('Special object member refused')
        h = hashlib.sha256()
        stream = archive.extractfile(info)
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
        if h.hexdigest() != entry['sha256']:
            raise RuntimeError('Object export checksum mismatch')
    expected = {'index.json', *(entry['member'] for entry in index['objects'])}
    members = archive.getmembers()
    if len(members) != len(expected) or {member.name for member in members} != expected or any(not member.isfile() for member in members):
        raise RuntimeError('Unexpected object export member')
    return index
`;
