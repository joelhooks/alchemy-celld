import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { cacheIoScript } from "../src/cache-io-script.ts";
import { localExec } from "../src/local-exec.ts";

const cacheFixture = String.raw`
import hashlib, json, os, pathlib, resource, sys, tempfile, time
script, windows, tail = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
namespace = {}
exec(script, namespace)
window, chunk = namespace['CACHE_WINDOW'], namespace['COPY_CHUNK']
prefix = int(sys.argv[4]) if len(sys.argv) > 4 else 0
size = windows * window + tail
publish = len(sys.argv) > 5 and sys.argv[5] == 'true'
active_window = window
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    syncs, advices, synced = [], [], {}
    original_sync = os.fsync
    original_advice = getattr(os, 'posix_fadvise', None)
    os.POSIX_FADV_DONTNEED = getattr(os, 'POSIX_FADV_DONTNEED', 4)
    def sync(fd):
        end = os.lseek(fd, 0, os.SEEK_CUR)
        assert end - synced.get(fd, 0) <= active_window, 'Dirty write exceeded window'
        original_sync(fd)
        synced[fd] = end
        syncs.append(end)
    def advise(fd, offset, length, kind):
        assert kind == os.POSIX_FADV_DONTNEED
        assert offset % namespace['CACHE_PAGE'] == length % namespace['CACHE_PAGE'] == 0
        assert offset + length <= synced.get(fd, 0), 'Discard attempted before fsync'
        if original_advice: original_advice(fd, offset, length, kind)
        advices.append((offset, length))
    os.fsync, os.posix_fadvise = sync, advise
    began = time.monotonic()
    with (root/'spool').open('wb') as stream:
        stream.write(b'p' * prefix)
        stream.flush()
        original_sync(stream.fileno())
        synced[stream.fileno()] = prefix
        writer = namespace['CacheWriter'](stream)
        remaining = size
        while remaining:
            # One caller write can cross a window; the writer must split it.
            value = b'x' * min(remaining, chunk + 123)
            writer.write(value)
            remaining -= len(value)
        writer.sync()
    assert len(syncs) == windows + 1
    assert len(advices) >= windows
    write_syncs = list(syncs)
    write_advices = len(advices)
    syncs.clear()
    active_window = namespace['PUBLISH_WINDOW'] if publish else window
    with (root/'spool').open('rb') as source, (root/'published').open('xb') as target:
        synced[source.fileno()] = size + prefix
        synced[target.fileno()] = 0
        copied = namespace['cache_copy'](source, target, window=active_window)
    assert len(syncs) == (size + prefix) // active_window + 1, 'Publisher copy skipped writeback cadence'
    assert (root/'published').stat().st_size == size + prefix
    def digest(path):
        h = hashlib.sha256()
        with path.open('rb') as stream:
            for value in iter(lambda: stream.read(chunk), b''): h.update(value)
        return h.hexdigest()
    assert copied == digest(root/'spool') == digest(root/'published')
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    rss_bytes = rss if sys.platform == 'darwin' else rss * 1024
    print(json.dumps({'bytes':size + prefix,'syncPositions':write_syncs,'discardCalls':write_advices,'seconds':round(time.monotonic()-began,3),'rssBytes':rss_bytes}))
`;

it.effect.prop(
  "real file-backed writes fsync before page-aligned discard at every eight MiB and copy without changing bytes",
  {
    prefix: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum: 4095, minimum: 0 }))),
    publish: Arbitrary.schema(Schema.Boolean),
    tail: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ maximum: 4095, minimum: 0 }))),
    windows: Arbitrary.schema(Schema.Literals([0, 1, 2, 3, 5])),
  },
  ({ prefix, publish, tail, windows }) =>
    Effect.gen(function* fileWriteCadence() {
      const shell = yield* localExec;

      const result = yield* shell.exec([
        "python3",
        "-c",
        cacheFixture,
        cacheIoScript,
        String(windows),
        String(tail),
        String(prefix),
        String(publish),
      ]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        bytes: windows * 8 * 1024 * 1024 + tail + prefix,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 12 } },
);
