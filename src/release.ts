// @effect-diagnostics nodeBuiltinImport:off -- Node's bounded gzip decoder adapts vendor release archives.
import { gunzipSync } from "node:zlib";

import { Context, Effect, Layer, Schema, Stream } from "effect";
import { HttpClient } from "effect/http";

import { AbsolutePath, Mode, digest, readFile, reconcileBytes, refuse } from "./files.ts";
import type { FileAttributes } from "./files.ts";
import type { Interface, HostError } from "./host-shell.ts";
import { tarReader } from "./tar.ts";

const sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

const memberName = Schema.String.check(
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\r\n\0]+$/u),
);

export const BinarySchema = Schema.Struct({
  asset: Schema.Union([
    Schema.Struct({ format: Schema.Literal("raw") }),
    Schema.Struct({
      format: Schema.Literal("gz"),
      memberSha256: sha256,
    }),
    Schema.Struct({
      format: Schema.Literal("tar.gz"),
      member: memberName,
      memberSha256: sha256,
      root: Schema.optionalKey(memberName),
    }),
  ]),
  mode: Schema.optionalKey(Mode),
  path: AbsolutePath,
  sha256,
  size: Schema.Int.check(Schema.isBetween({ maximum: 256 * 1024 * 1024, minimum: 1 })),
  url: Schema.String.check(
    Schema.isPattern(
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[^?#\s]+$/u,
    ),
  ),
});

export type BinaryProps = typeof BinarySchema.Type;

export class ReleaseSource extends Context.Service<
  ReleaseSource,
  {
    readonly get: (input: {
      readonly url: string;
      readonly size: number;
    }) => Effect.Effect<Uint8Array, HostError>;
  }
>()("@alchemy-celld/ReleaseSource") {}

export const sourceLayer = Layer.effect(
  ReleaseSource,
  Effect.gen(function* sourceLayer() {
    const client = yield* HttpClient.HttpClient;

    return ReleaseSource.of({
      get: Effect.fn("ReleaseSource.get")(
        function* get({ url, size }) {
          const response = yield* client.get(url);

          if (response.status !== 200) {
            return yield* refuse("Release download did not return HTTP 200.");
          }

          const bytes = new Uint8Array(size);
          let offset = 0;
          yield* Stream.runForEach(response.stream, (chunk) => {
            if (offset + chunk.length > size) {
              return Effect.fail(refuse("Release download exceeded pinned size."));
            }

            bytes.set(chunk, offset);
            offset += chunk.length;

            return Effect.void;
          });

          if (offset !== size) {
            return yield* refuse("Release download did not match pinned size.");
          }

          return bytes;
        },
        (effect) =>
          effect.pipe(
            Effect.timeoutOrElse({
              duration: "10 minutes",
              orElse: () => Effect.fail(refuse("Release download timed out.")),
            }),
            Effect.mapError(() => refuse("Release download failed; values redacted.")),
          ),
      ),
    });
  }),
);

export const validateBinary = (props: BinaryProps) =>
  Schema.decodeEffect(BinarySchema)(props).pipe(
    Effect.mapError(() =>
      refuse("Release assets require a pinned sha256, size and safe GitHub download URL."),
    ),
  );

export const binaryDigest = (props: BinaryProps): string =>
  props.asset.format === "raw" ? props.sha256 : props.asset.memberSha256;

export const verifiedBytes = Effect.fn("ReleaseBinary.verify")(function* verifiedBytes(
  bytes: Uint8Array,
  props: BinaryProps,
) {
  yield* validateBinary(props);

  if (bytes.length !== props.size || digest(bytes) !== props.sha256) {
    return yield* refuse("Release checksum or size mismatch.");
  }

  if (props.asset.format === "raw") {
    return bytes;
  }

  const { asset } = props;

  const binary = yield* Effect.try({
    catch: () => refuse("Release archive refused."),
    try: () => {
      const expanded = gunzipSync(bytes, {
        maxOutputLength: 512 * 1024 * 1024,
      });

      if (asset.format === "gz") {
        return new Uint8Array(expanded);
      }

      const tar = tarReader(new Set([asset.member]), asset.root);
      tar.push(expanded);

      return tar.finish().members.get(asset.member);
    },
  });

  if (binary === undefined || digest(binary) !== asset.memberSha256) {
    return yield* refuse("Release member checksum mismatch or member missing.");
  }

  return binary;
});

export const reconcileBinary = Effect.fn("ReleaseBinary.reconcile")(function* reconcileBinary(
  shell: Interface,
  source: typeof ReleaseSource.Service,
  props: BinaryProps,
  output: FileAttributes | undefined,
  adopt: boolean,
) {
  const valid = yield* validateBinary(props);

  if (output !== undefined && output.path !== valid.path) {
    return yield* refuse("Binary path changes require replacement.");
  }

  const before = yield* readFile(shell, valid.path);

  if (
    before !== undefined &&
    output === undefined &&
    (!adopt || before.sha256 !== binaryDigest(valid))
  ) {
    return yield* refuse("Only a matching binary may be explicitly adopted.");
  }

  if (before?.sha256 === binaryDigest(valid)) {
    if (before.mode !== (valid.mode ?? 0o755)) {
      return yield* reconcileBytes(
        shell,
        {
          bytes: (yield* shell.read(valid.path)) ?? new Uint8Array(),
          mode: valid.mode ?? 0o755,
          path: valid.path,
        },
        output,
        adopt,
      );
    }

    return before;
  }

  const bytes = yield* verifiedBytes(
    yield* source.get({ size: valid.size, url: valid.url }),
    valid,
  );

  return yield* reconcileBytes(
    shell,
    { bytes, mode: valid.mode ?? 0o755, path: valid.path },
    output,
    adopt,
  );
});
