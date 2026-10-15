// @effect-diagnostics nodeBuiltinImport:off -- Synthetic gzip fixtures exercise the Node archive decoder.
import { gzipSync } from "node:zlib";

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { digest } from "../src/files.ts";
import { verifiedBytes } from "../src/release.ts";
import type { BinaryProps } from "../src/release.ts";

interface Entry {
  readonly name: string;
  readonly type?: string;
  readonly bytes: Uint8Array;
}

const archive = (entries: readonly Entry[]): Uint8Array => {
  const chunks: Uint8Array[] = [];

  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf-8");
    header.write("0000755\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${entry.bytes.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    header.write("ustar\u000000", 257, 8, "ascii");
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(header, entry.bytes, Buffer.alloc((512 - (entry.bytes.length % 512)) % 512));
  }

  chunks.push(Buffer.alloc(1024));

  return gzipSync(Buffer.concat(chunks));
};

const props = (bytes: Uint8Array, member: Uint8Array): BinaryProps => ({
  asset: { format: "tar.gz", member: "tool", memberSha256: digest(member) },
  mode: 0o755,
  path: "/srv/example/binary",
  sha256: digest(bytes),
  size: bytes.length,
  url: "https://github.com/example/project/releases/download/v1/tool.tar.gz",
});

describe("checksummed release archives", () => {
  it.effect("verifies standalone gzip assets and their expanded binary", () =>
    Effect.gen(function* standalone() {
      const binary = new TextEncoder().encode("invented standalone binary");
      const bytes = gzipSync(binary);

      const input: BinaryProps = {
        ...props(bytes, binary),
        asset: { format: "gz", memberSha256: digest(binary) },
      };

      expect(yield* verifiedBytes(bytes, input)).toEqual(binary);
      expect(
        yield* verifiedBytes(bytes, {
          ...input,
          asset: { format: "gz", memberSha256: "0".repeat(64) },
        }).pipe(Effect.isFailure),
      ).toBe(true);
    }),
  );
  it.effect("verifies the archive before extracting and checks the exact member", () =>
    Effect.gen(function* checksum() {
      const binary = new TextEncoder().encode("invented binary");
      const bytes = archive([{ bytes: binary, name: "tool" }]);
      expect(yield* verifiedBytes(bytes, props(bytes, binary))).toEqual(binary);
      expect(
        yield* verifiedBytes(bytes, {
          ...props(bytes, binary),
          sha256: "0".repeat(64),
        }).pipe(Effect.isFailure),
      ).toBe(true);
      expect(
        yield* verifiedBytes(bytes, props(bytes, new Uint8Array([1]))).pipe(Effect.isFailure),
      ).toBe(true);
    }),
  );

  it.effect(
    "refuses traversal, symlinks, duplicate members, malformed gzip and missing members",
    () =>
      Effect.gen(function* unsafe() {
        const binary = new Uint8Array([1, 2, 3]);

        for (const entries of [
          [{ bytes: binary, name: "../tool" }],
          [{ bytes: binary, name: "tool", type: "2" }],
          [
            { bytes: binary, name: "tool" },
            { bytes: binary, name: "tool" },
          ],
          [{ bytes: binary, name: "different" }],
        ]) {
          const bytes = archive(entries);
          expect(yield* verifiedBytes(bytes, props(bytes, binary)).pipe(Effect.isFailure)).toBe(
            true,
          );
        }

        const invalid = new Uint8Array([1, 2, 3]);
        expect(yield* verifiedBytes(invalid, props(invalid, binary)).pipe(Effect.isFailure)).toBe(
          true,
        );
      }),
  );

  it.effect("accepts one explicitly declared archive root", () =>
    Effect.gen(function* root() {
      const binary = new Uint8Array([1, 2, 3]);

      const bytes = archive([
        { bytes: new Uint8Array(), name: "release/", type: "5" },
        { bytes: binary, name: "release/tool" },
      ]);

      const pinned = props(bytes, binary);
      expect(
        yield* verifiedBytes(bytes, {
          ...pinned,
          asset: {
            format: "tar.gz",
            member: "tool",
            memberSha256: digest(binary),
            root: "release",
          },
        }),
      ).toEqual(binary);
    }),
  );
});
