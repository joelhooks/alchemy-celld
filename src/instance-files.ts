import { Effect, Redacted, Schema } from "effect";

import { cleanupBootstrapDirectories } from "./bootstrap-cleanup.ts";
import { assertDeletePath } from "./delete-custody.ts";
import {
  AbsolutePath,
  deleteDirectory as deleteMailboxDirectory,
  deleteFile as deleteMailboxFile,
  FileSchema as MailboxFileSchema,
  reconcileBytes,
  refuse,
} from "./files.ts";
import type { DirectoryAttributes, FileAttributes } from "./files.ts";
import type { Interface } from "./host-shell.ts";

export {
  AbsolutePath,
  DirectorySchema,
  directoryPolicy,
  fileText,
  readDirectory,
  readFile,
  reconcileDirectory,
  textDigest,
  validateDirectory,
} from "./files.ts";

export type { DirectoryAttributes, DirectoryProps, FileAttributes } from "./files.ts";

export const deleteFile = Effect.fn("InstanceFile.delete")(function* remove(
  shell: Interface,
  output: FileAttributes,
) {
  yield* assertDeletePath(shell, output.path, "files");

  return yield* deleteMailboxFile(shell, output);
});

export const deleteDirectory = Effect.fn("InstanceDirectory.delete")(function* remove(
  shell: Interface,
  output: DirectoryAttributes,
) {
  yield* assertDeletePath(shell, output.path, "directories");

  if (
    shell.deleteCustody !== undefined &&
    output.path === shell.deleteCustody.layout.configuration
  ) {
    yield* cleanupBootstrapDirectories(shell, output.path);
  }

  return yield* deleteMailboxDirectory(shell, output);
});

export const FileSchema = Schema.Struct({
  ...MailboxFileSchema.fields,
  rotationOwner: Schema.optionalKey(
    Schema.Struct({
      home: AbsolutePath,
      name: Schema.String.check(
        Schema.isPattern(/^[a-z][a-z0-9-]{0,15}-(?:seaweedfs|celld)\.service$/u),
      ),
      sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
    }),
  ),
});

export type FileProps = typeof FileSchema.Type;

export const validateFile = Effect.fn("RemoteFile.validate")(function* validate(props: FileProps) {
  const valid = yield* Schema.decodeEffect(FileSchema)(props).pipe(
    Effect.mapError(() => refuse("Invalid file declaration.")),
  );

  if (Redacted.isRedacted(valid.content) && valid.mode !== 0o600) {
    return yield* refuse("Secret file content requires mode 600.");
  }

  return valid;
});

export const reconcileFile = Effect.fn("RemoteFile.reconcile")(function* reconcile(
  shell: Interface,
  props: FileProps,
  output: FileAttributes | undefined,
  adopt: boolean,
) {
  const valid = yield* validateFile(props);

  return yield* reconcileBytes(
    shell,
    {
      bytes: new TextEncoder().encode(
        Redacted.isRedacted(valid.content) ? Redacted.value(valid.content) : valid.content,
      ),
      mode: valid.mode ?? 0o644,
      path: valid.path,
    },
    output,
    adopt,
  );
});
