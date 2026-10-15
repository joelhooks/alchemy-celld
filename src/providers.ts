import { Resource } from "alchemy";
import { AdoptPolicy, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Config, Effect, Layer, Option, Schema } from "effect";

import { absent } from "./absent.ts";
import { ownedPath, recovering, rotatingFile } from "./adoption.ts";
import { legacyDeploymentFile } from "./deployment-file-adoption.ts";
import { HostShell, HostError } from "./host-shell.ts";
import {
  deleteDirectory,
  deleteFile,
  fileText,
  FileSchema,
  DirectorySchema,
  directoryPolicy,
  readDirectory,
  readFile,
  reconcileDirectory,
  reconcileFile,
  textDigest,
  validateDirectory,
  validateFile,
} from "./instance-files.ts";
import type {
  DirectoryAttributes,
  DirectoryProps,
  FileAttributes,
  FileProps,
} from "./instance-files.ts";
import {
  BinarySchema,
  binaryDigest,
  reconcileBinary,
  ReleaseSource,
  validateBinary,
} from "./release.ts";
import type { BinaryProps } from "./release.ts";
import {
  needsUpdate,
  readUnit,
  reconcileUnit,
  deleteUnit,
  unitPath,
  validateUnit,
  withoutLegacyHelperInputs,
  ownedUnit,
  UnitSchema,
} from "./systemd.ts";
import type { UnitAttributes, UnitProps } from "./systemd.ts";
import { UnitStartup } from "./unit-startup.ts";

export type RemoteFileResource = Resource<"LinuxHost.RemoteFile", FileProps, FileAttributes>;

export const RemoteFile = Resource<RemoteFileResource>("LinuxHost.RemoteFile");

export type HostDirectoryResource = Resource<
  "LinuxHost.HostDirectory",
  DirectoryProps,
  DirectoryAttributes
>;

export const HostDirectory = Resource<HostDirectoryResource>("LinuxHost.HostDirectory");

export type SystemdUnitResource = Resource<"LinuxHost.SystemdUnit", UnitProps, UnitAttributes>;

export const SystemdUnit = Resource<SystemdUnitResource>("LinuxHost.SystemdUnit");

export type ReleaseBinaryResource = Resource<
  "LinuxHost.ReleaseBinary",
  BinaryProps,
  FileAttributes
>;

export const ReleaseBinary = Resource<ReleaseBinaryResource>("LinuxHost.ReleaseBinary");

const adoption = Effect.serviceOption(AdoptPolicy).pipe(Effect.map(Option.getOrElse(() => false)));

export const RemoteFileProvider = () =>
  Provider.effect(
    RemoteFile,
    Effect.gen(function* makeRemoteFileProvider() {
      const shell = yield* HostShell;

      return RemoteFile.Provider.of({
        delete: ({ output }) => (output === undefined ? Effect.void : deleteFile(shell, output)),
        diff: Effect.fn("RemoteFile.provider.diff")(function* operation({ news, output }) {
          if (!isResolved(news)) {
            return absent;
          }

          yield* validateFile(news);

          if (output === undefined) {
            return { action: "update" };
          }

          if (news.path !== output.path) {
            return { action: "replace" };
          }

          const live = yield* readFile(shell, news.path);

          return {
            action:
              live?.sha256 === textDigest(fileText(news.content)) &&
              live.mode === (news.mode ?? 0o644)
                ? "noop"
                : "update",
          };
        }),
        list: () => Effect.succeed([]),
        read: Effect.fn("RemoteFile.provider.read")(function* operation({ fqn, olds, output }) {
          if (output === undefined && !Schema.is(FileSchema)(olds)) {
            return absent;
          }

          yield* validateFile(olds);
          const live = yield* readFile(shell, olds.path);

          if (live === undefined || output !== undefined) {
            return live;
          }

          const rotation = yield* rotatingFile(shell, olds);
          const transferred = yield* legacyDeploymentFile(shell, fqn, live);

          if (
            !rotation &&
            !transferred &&
            (live.sha256 !== textDigest(fileText(olds.content)) ||
              live.mode !== (olds.mode ?? 0o644))
          ) {
            return yield* new HostError({
              operation: "adopt",
              reason: `Only a matching file may be adopted (resource ${fqn}).`,
            });
          }

          return (yield* ownedPath(shell, olds.path)) ? live : Unowned(live);
        }),
        reconcile: Effect.fn("RemoteFile.provider.reconcile")(function* operation({
          news,
          output,
        }) {
          return yield* reconcileFile(shell, news, output, yield* adoption);
        }),
      });
    }),
  );

export const HostDirectoryProvider = () =>
  Provider.effect(
    HostDirectory,
    Effect.gen(function* makeHostDirectoryProvider() {
      const shell = yield* HostShell;

      return HostDirectory.Provider.of({
        delete: ({ output }) =>
          output === undefined ? Effect.void : deleteDirectory(shell, output),
        diff: Effect.fn("HostDirectory.provider.diff")(function* operation({ news, output }) {
          if (!isResolved(news)) {
            return absent;
          }

          yield* validateDirectory(news);

          if (output === undefined) {
            return { action: "update" };
          }

          if (news.path !== output.path) {
            return { action: "replace" };
          }

          const live = yield* readDirectory(shell, news.path);

          return {
            action:
              live?.mode === (news.mode ?? 0o755) &&
              output.purgeRoot === (news.purgeOnDelete === true ? news.purgeRoot : undefined)
                ? "noop"
                : "update",
          };
        }),
        list: () => Effect.succeed([]),
        read: Effect.fn("HostDirectory.provider.read")(function* operation({ olds, output }) {
          if (output === undefined && !Schema.is(DirectorySchema)(olds)) {
            return absent;
          }

          yield* validateDirectory(olds);
          const observed = yield* readDirectory(shell, olds.path);

          if (observed !== undefined && output === undefined && olds.purgeOnDelete === true) {
            return yield* new HostError({
              operation: "adopt",
              reason: "Existing data directory cannot gain purge authority by adoption.",
            });
          }

          const live = observed === undefined ? undefined : directoryPolicy(olds, observed);

          if (live === undefined || output !== undefined) {
            return live;
          }

          if (live.mode !== (olds.mode ?? 0o755)) {
            return yield* new HostError({
              operation: "adopt",
              reason: "Only a matching directory may be adopted.",
            });
          }

          return (yield* ownedPath(shell, olds.path)) ? live : Unowned(live);
        }),
        reconcile: Effect.fn("HostDirectory.provider.reconcile")(function* operation({
          news,
          output,
        }) {
          return yield* reconcileDirectory(shell, news, output, yield* adoption);
        }),
      });
    }),
  );

export const SystemdUnitProvider = () =>
  Provider.effect(
    SystemdUnit,
    Effect.gen(function* makeSystemdUnitProvider() {
      const shell = yield* HostShell;
      const startup = yield* Effect.serviceOption(UnitStartup);

      return SystemdUnit.Provider.of({
        delete: ({ output }) => (output === undefined ? Effect.void : deleteUnit(shell, output)),
        diff: Effect.fn("SystemdUnit.provider.diff")(function* operation({ olds, news, output }) {
          if (Output.isExpr(news) || Effect.isEffect(news) || Config.isConfig(news)) {
            return absent;
          }

          if (Symbol.iterator in news) {
            return absent;
          }

          const operational = { ...news, prepared: [] };

          if (!isResolved<UnitProps>(operational)) {
            return absent;
          }

          yield* validateUnit(operational);

          const previous = withoutLegacyHelperInputs(
            olds,
            operational,
            output,
            "prepared" in news && operational.name.endsWith("-seaweedfs.service"),
          );

          if (output === undefined) {
            return { action: "update" };
          }

          if (unitPath(operational) !== output.path) {
            if ((yield* readUnit(shell, operational)) !== undefined) {
              return yield* new HostError({
                operation: "replace",
                reason: "Replacement unit target already exists.",
              });
            }

            return { action: "replace", deleteFirst: true };
          }

          return {
            action: needsUpdate(
              operational,
              previous ?? output,
              yield* readUnit(shell, operational),
            )
              ? "update"
              : "noop",
          };
        }),
        list: () => Effect.succeed([]),
        read: Effect.fn("SystemdUnit.provider.read")(function* operation({ olds, output }) {
          if (output === undefined && !Schema.is(UnitSchema)(olds)) {
            return absent;
          }

          const live = yield* readUnit(shell, olds);

          if (live === undefined) {
            return absent;
          }

          if (output === undefined) {
            const owned = yield* ownedUnit(shell, olds, live);

            const recovered =
              (yield* recovering) && olds.name.endsWith("-seaweedfs.service")
                ? { ...live, configSha256: "" }
                : live;

            return owned ? recovered : Unowned(recovered);
          }

          return {
            ...live,
            configSha256: output.configSha256,
            sha256: output.sha256,
          };
        }),
        reconcile: Effect.fn("SystemdUnit.provider.reconcile")(function* operation({
          olds,
          news,
          output,
        }) {
          yield* validateUnit(news);

          const existed = yield* shell.stat(unitPath(news));

          if (Option.isSome(startup)) {
            yield* startup.value.beforeStart(news.name, news.home);
          }

          const attributes = yield* reconcileUnit(
            shell,
            news,
            withoutLegacyHelperInputs(
              olds,
              news,
              output,
              news.prepared !== undefined && news.name.endsWith("-seaweedfs.service"),
            ),
            yield* adoption,
          );

          if (Option.isSome(startup)) {
            yield* startup.value
              .afterStart(news.name)
              .pipe(
                Effect.onError(() =>
                  existed === undefined
                    ? deleteUnit(shell, attributes).pipe(Effect.orDie)
                    : Effect.void,
                ),
              );
          }

          return attributes;
        }),
      });
    }),
  );

export const ReleaseBinaryProvider = () =>
  Provider.effect(
    ReleaseBinary,
    Effect.gen(function* makeReleaseBinaryProvider() {
      const shell = yield* HostShell;
      const source = yield* ReleaseSource;

      return ReleaseBinary.Provider.of({
        delete: ({ output }) => (output === undefined ? Effect.void : deleteFile(shell, output)),
        diff: Effect.fn("ReleaseBinary.provider.diff")(function* operation({ news, output }) {
          if (!isResolved(news)) {
            return absent;
          }

          yield* validateBinary(news);

          if (output === undefined) {
            return { action: "update" };
          }

          if (news.path !== output.path) {
            return { action: "replace" };
          }

          const live = yield* readFile(shell, news.path);

          return {
            action:
              live?.sha256 === binaryDigest(news) && live.mode === (news.mode ?? 0o755)
                ? "noop"
                : "update",
          };
        }),
        list: () => Effect.succeed([]),
        read: Effect.fn("ReleaseBinary.provider.read")(function* operation({ olds, output }) {
          if (output === undefined && !Schema.is(BinarySchema)(olds)) {
            return absent;
          }

          yield* validateBinary(olds);
          const live = yield* readFile(shell, olds.path);

          if (live === undefined || output !== undefined) {
            return live;
          }

          if (live.sha256 !== binaryDigest(olds) || live.mode !== (olds.mode ?? 0o755)) {
            return yield* new HostError({
              operation: "adopt",
              reason: "Only the pinned binary may be adopted.",
            });
          }

          return (yield* ownedPath(shell, olds.path)) ? live : Unowned(live);
        }),
        reconcile: Effect.fn("ReleaseBinary.provider.reconcile")(function* operation({
          news,
          output,
        }) {
          return yield* reconcileBinary(shell, source, news, output, yield* adoption);
        }),
      });
    }),
  );

export const providers = () =>
  Layer.mergeAll(
    RemoteFileProvider(),
    HostDirectoryProvider(),
    SystemdUnitProvider(),
    ReleaseBinaryProvider(),
  );
