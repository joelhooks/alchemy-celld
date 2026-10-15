// @effect-diagnostics nodeBuiltinImport:off -- Provider adapters hash the exact bytes installed on Linux.
import { createHash } from "node:crypto";

import { Effect, Redacted, Schema } from "effect";

import { absent } from "./absent.ts";
import { HostError, must } from "./host-shell.ts";
import type { Interface } from "./host-shell.ts";
import { purgeScript, validatePurgePath } from "./purge.ts";

export const AbsolutePath = Schema.String.check(
  Schema.isPattern(
    /^\/(?!$)(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))(?!.*\/\/)[^\r\n\0]*[^/\r\n\0]$/u,
  ),
);

export const Mode = Schema.Int.check(Schema.isBetween({ maximum: 0o777, minimum: 0 }));

export const FileSchema = Schema.Struct({
  content: Schema.Union([Schema.String, Schema.Redacted(Schema.String)]),
  mode: Schema.optionalKey(Mode),
  path: AbsolutePath,
  rotationOwner: Schema.optionalKey(
    Schema.Struct({
      home: AbsolutePath,
      name: Schema.Literals(["celld-seaweedfs.service", "celld-celld.service"]),
      sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
    }),
  ),
});

export type FileProps = typeof FileSchema.Type;

export const fileText = (content: FileProps["content"]): string =>
  Redacted.isRedacted(content) ? Redacted.value(content) : content;

export interface FileAttributes {
  readonly path: string;
  readonly sha256: string;
  readonly mode: number;
}

export const DirectorySchema = Schema.Struct({
  mode: Schema.optionalKey(Mode),
  path: AbsolutePath,
  purgeOnDelete: Schema.optionalKey(Schema.Boolean),
  purgeRoot: Schema.optionalKey(AbsolutePath),
});

export type DirectoryProps = typeof DirectorySchema.Type;

export interface DirectoryAttributes {
  readonly path: string;
  readonly mode: number;
  readonly purgeRoot?: string;
}

export const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const textDigest = (text: string): string => digest(new TextEncoder().encode(text));

export const refuse = (reason: string) => new HostError({ operation: "provider", reason });

export const validateFile = Effect.fn("RemoteFile.validate")(function* validate(props: FileProps) {
  const valid = yield* Schema.decodeEffect(FileSchema)(props).pipe(
    Effect.mapError(() => refuse("Invalid file declaration.")),
  );

  if (Redacted.isRedacted(valid.content) && valid.mode !== 0o600) {
    return yield* refuse("Secret file content requires mode 600.");
  }

  return valid;
});

export const validateDirectory = Effect.fn("HostDirectory.validate")(function* validate(
  props: DirectoryProps,
) {
  const valid = yield* Schema.decodeEffect(DirectorySchema)(props).pipe(
    Effect.mapError(() => refuse("Invalid directory declaration.")),
  );

  if (
    valid.purgeOnDelete === true &&
    (valid.purgeRoot === undefined || !validatePurgePath(valid.path, valid.purgeRoot))
  ) {
    return yield* refuse("Purge target must be strictly under its declared owned root.");
  }

  return valid;
});

export const directoryPolicy = (
  props: DirectoryProps,
  live: DirectoryAttributes,
): DirectoryAttributes =>
  props.purgeOnDelete === true && props.purgeRoot !== undefined
    ? { ...live, purgeRoot: props.purgeRoot }
    : live;

export const readFile = Effect.fn("RemoteFile.read")(function* readFile(
  shell: Interface,
  path: string,
) {
  const entry = yield* shell.stat(path);

  if (entry === undefined) {
    return absent;
  }

  if (entry.kind !== "file") {
    return yield* refuse("Expected a regular file.");
  }

  if (shell.checksum !== undefined) {
    const sha256 = yield* shell.checksum(path);

    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      return yield* refuse("Malformed remote file checksum.");
    }

    return { mode: entry.mode, path, sha256 } satisfies FileAttributes;
  }

  const bytes = yield* shell.read(path);

  if (bytes === undefined) {
    return yield* refuse("File disappeared while reading.");
  }

  return {
    mode: entry.mode,
    path,
    sha256: digest(bytes),
  } satisfies FileAttributes;
});

export const reconcileBytes = Effect.fn("RemoteFile.reconcileBytes")(function* reconcileBytes(
  shell: Interface,
  input: {
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly mode: number;
  },
  output: FileAttributes | undefined,
  adopt: boolean,
) {
  if (output !== undefined && output.path !== input.path) {
    return yield* refuse("Path changes require replacement.");
  }

  const before = yield* readFile(shell, input.path);
  const sha256 = digest(input.bytes);

  if (before !== undefined && output === undefined && !adopt) {
    return yield* refuse("Existing file requires explicit adoption.");
  }

  if (before?.sha256 !== sha256) {
    yield* shell.write(input);
  } else if (before.mode !== input.mode) {
    yield* must(shell, ["chmod", input.mode.toString(8), "--", input.path]);
  }

  const after = yield* readFile(shell, input.path);

  if (after === undefined || after.sha256 !== sha256 || after.mode !== input.mode) {
    return yield* refuse("Installed file failed readback.");
  }

  return after;
});

export const reconcileFile = Effect.fn("RemoteFile.reconcile")(function* reconcileFile(
  shell: Interface,
  props: FileProps,
  output: FileAttributes | undefined,
  adopt: boolean,
) {
  const valid = yield* validateFile(props);

  return yield* reconcileBytes(
    shell,
    {
      bytes: new TextEncoder().encode(fileText(valid.content)),
      mode: valid.mode ?? 0o644,
      path: valid.path,
    },
    output,
    adopt,
  );
});

export const deleteFile = Effect.fn("RemoteFile.delete")(function* deleteFile(
  shell: Interface,
  output: FileAttributes,
) {
  const live = yield* readFile(shell, output.path);

  if (live !== undefined) {
    yield* shell.remove(output.path);
  }
});

export const readDirectory = Effect.fn("HostDirectory.read")(function* readDirectory(
  shell: Interface,
  path: string,
) {
  const entry = yield* shell.stat(path);

  if (entry === undefined) {
    return absent;
  }

  if (entry.kind !== "directory") {
    return yield* refuse("Expected a directory.");
  }

  return { mode: entry.mode, path } satisfies DirectoryAttributes;
});

export const reconcileDirectory = Effect.fn("HostDirectory.reconcile")(function* reconcileDirectory(
  shell: Interface,
  props: DirectoryProps,
  output: DirectoryAttributes | undefined,
  adopt: boolean,
) {
  const valid = yield* validateDirectory(props);

  if (
    valid.purgeOnDelete === true &&
    (valid.purgeRoot === undefined || !shell.purgeRoots.includes(valid.purgeRoot))
  ) {
    return yield* refuse("Purge root is outside the inventory-derived owned roots.");
  }

  if (output !== undefined && output.path !== valid.path) {
    return yield* refuse("Path changes require replacement.");
  }

  const before = yield* readDirectory(shell, valid.path);
  const mode = valid.mode ?? 0o755;

  if (before !== undefined && output === undefined && (!adopt || valid.purgeOnDelete === true)) {
    return yield* refuse("Existing directory cannot gain purge authority by adoption.");
  }

  if (before === undefined) {
    yield* shell.mkdir({ mode, path: valid.path });
  } else if (before.mode !== mode) {
    yield* must(shell, ["chmod", mode.toString(8), "--", valid.path]);
  }

  const after = yield* readDirectory(shell, valid.path);

  if (after === undefined || after.mode !== mode) {
    return yield* refuse("Directory failed readback.");
  }

  return directoryPolicy(valid, after);
});

export const deleteDirectory = Effect.fn("HostDirectory.delete")(function* deleteDirectory(
  shell: Interface,
  output: DirectoryAttributes,
) {
  if ((yield* readDirectory(shell, output.path)) !== undefined) {
    if (output.purgeRoot === undefined) {
      yield* shell.rmdir(output.path);
    } else {
      if (
        !shell.purgeRoots.includes(output.purgeRoot) ||
        !validatePurgePath(output.path, output.purgeRoot)
      ) {
        return yield* refuse("Purge target escapes its owned root.");
      }

      yield* must(shell, ["python3", "-c", purgeScript, output.purgeRoot, output.path]);
    }
  }

  return yield* Effect.void;
});
