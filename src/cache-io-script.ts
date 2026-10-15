export const cacheIoScript = String.raw`
import os
CACHE_WINDOW = 8 * 1024 * 1024
PUBLISH_WINDOW = 32 * 1024 * 1024
COPY_CHUNK = 1024 * 1024
CACHE_PAGE = os.sysconf('SC_PAGESIZE')

def discard_cache(stream, start, end):
    # Linux ignores partial pages. Keep the last partial page for the next window.
    first = start - start % CACHE_PAGE
    last = end - end % CACHE_PAGE
    if last > first and hasattr(os, 'posix_fadvise'):
        os.posix_fadvise(stream.fileno(), first, last - first, os.POSIX_FADV_DONTNEED)
    return last

class CacheWriter:
    def __init__(self, stream, window=CACHE_WINDOW, digest=None):
        self.stream = stream
        self.window = window
        self.digest = digest
        self.synced = stream.tell()
    def tell(self):
        return self.stream.tell()
    def flush(self):
        self.stream.flush()
    def sync(self):
        self.stream.flush()
        os.fsync(self.stream.fileno())
        self.synced = discard_cache(self.stream, self.synced, self.stream.tell())
    def write(self, value):
        size, offset = len(value), 0
        while offset < size:
            remaining = self.window - (self.stream.tell() - self.synced)
            length = min(size - offset, COPY_CHUNK, remaining)
            piece = memoryview(value)[offset:offset + length]
            if self.stream.write(piece) != length:
                raise RuntimeError('Short archive write')
            if self.digest is not None:
                self.digest.update(piece)
            offset += length
            if self.stream.tell() - self.synced >= self.window:
                self.sync()
        return size

class CacheReader:
    def __init__(self, stream):
        self.stream = stream
        self.start = stream.tell()
    def tell(self):
        return self.stream.tell()
    def fileno(self):
        return self.stream.fileno()
    def release(self):
        self.start = discard_cache(self.stream, self.start, self.stream.tell())
    def seek(self, *args):
        self.release()
        position = self.stream.seek(*args)
        self.start = position
        return position
    def read(self, size=-1):
        value = self.stream.read(size)
        if self.stream.tell() - self.start >= CACHE_WINDOW or not value:
            self.release()
        return value
    def readable(self):
        return True
    def seekable(self):
        return self.stream.seekable()
    def __getattr__(self, name):
        return getattr(self.stream, name)

def cache_copy(source, destination, window=CACHE_WINDOW, hashed=True):
    import hashlib
    digest = hashlib.sha256() if hashed else None
    reader, writer = CacheReader(source), CacheWriter(destination, window, digest)
    for chunk in iter(lambda: reader.read(COPY_CHUNK), b''):
        writer.write(chunk)
    reader.release()
    writer.sync()
    return digest.hexdigest() if hashed else None

def cache_tar(path):
    import contextlib, gzip
    @contextlib.contextmanager
    def opened():
        with path.open('rb') as stream:
            compressed = stream.read(2) == b'\x1f\x8b'
            stream.seek(0)
            reader = CacheReader(stream)
            try:
                if compressed:
                    with gzip.GzipFile(fileobj=reader, mode='rb') as inflated:
                        with tarfile.open(fileobj=inflated, mode='r|') as archive:
                            yield archive
                        for chunk in iter(lambda: inflated.read(COPY_CHUNK), b''):
                            pass
                else:
                    with tarfile.open(fileobj=reader, mode='r:') as archive:
                        yield archive
            finally:
                reader.release()
    return opened()
`;
