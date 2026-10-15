import * as Provider from "alchemy/Provider";
import { Random } from "alchemy/Random";
import { Context, Effect, Layer, Redacted } from "effect";

import { BucketResource } from "../src/bucket-api.ts";
import { fileText, textDigest } from "../src/files.ts";
import { NodeResource } from "../src/node-provider.ts";
import { HostDirectory, ReleaseBinary, RemoteFile, SystemdUnit } from "../src/providers.ts";
import { renderUnit, unitPath } from "../src/systemd.ts";
import type { UnitProps } from "../src/systemd.ts";

export class Rendered extends Context.Service<
  Rendered,
  { readonly files: Map<string, string>; readonly directories: Set<string> }
>()("Test/Rendered") {}

const fileProvider = Provider.effect(
  RemoteFile,
  Effect.gen(function* provider() {
    const rendered = yield* Rendered;

    return RemoteFile.Provider.of({
      delete: () => Effect.void,
      list: () => Effect.succeed([]),
      read: ({ output }) => Effect.succeed(output),
      reconcile: ({ news }) =>
        Effect.sync(() => {
          const content = fileText(news.content);
          rendered.files.set(news.path, content);

          return {
            mode: news.mode ?? 0o644,
            path: news.path,
            sha256: textDigest(content),
          };
        }),
    });
  }),
);

const directoryProvider = Provider.effect(
  HostDirectory,
  Effect.gen(function* provider() {
    const rendered = yield* Rendered;

    return HostDirectory.Provider.of({
      delete: () => Effect.void,
      list: () => Effect.succeed([]),
      read: ({ output }) => Effect.succeed(output),
      reconcile: ({ news }) =>
        Effect.sync(() => {
          rendered.directories.add(news.path);

          return { mode: news.mode ?? 0o755, path: news.path };
        }),
    });
  }),
);

const binaryProvider = Provider.effect(
  ReleaseBinary,
  Effect.gen(function* provider() {
    const rendered = yield* Rendered;

    return ReleaseBinary.Provider.of({
      delete: () => Effect.void,
      list: () => Effect.succeed([]),
      read: ({ output }) => Effect.succeed(output),
      reconcile: ({ news }) =>
        Effect.sync(() => {
          rendered.files.set(news.path, `pinned binary ${news.sha256}`);

          return { mode: 0o700, path: news.path, sha256: news.sha256 };
        }),
    });
  }),
);

const renderedUnit = (rendered: typeof Rendered.Service, props: UnitProps) => {
  const path = unitPath(props);
  const text = renderUnit(props);
  rendered.files.set(path, text);

  return {
    active: true,
    configSha256: textDigest(text),
    enabled: props.enabled ?? true,
    home: props.home,
    name: props.name,
    needDaemonReload: false,
    path,
    scope: props.scope,
    sha256: textDigest(text),
  };
};

const unitProvider = Provider.effect(
  SystemdUnit,
  Effect.gen(function* provider() {
    const rendered = yield* Rendered;

    return SystemdUnit.Provider.of({
      delete: () => Effect.void,
      list: () => Effect.succeed([]),
      read: ({ output }) => Effect.succeed(output),
      reconcile: ({ news }) => Effect.sync(() => renderedUnit(rendered, news)),
    });
  }),
);

const nodeProvider = Provider.effect(
  NodeResource,
  Effect.gen(function* provider() {
    const rendered = yield* Rendered;

    return NodeResource.Provider.of({
      delete: () => Effect.void,
      list: () => Effect.succeed([]),
      read: ({ output }) => Effect.succeed(output),
      reconcile: ({ news }) =>
        Effect.sync(() => ({
          ...renderedUnit(rendered, news),
          internalUrl: news.internalUrl,
          publicUrl: news.publicUrl,
          version: news.version,
        })),
    });
  }),
);

export const renderProviders = Layer.mergeAll(
  fileProvider,
  directoryProvider,
  binaryProvider,
  unitProvider,
  nodeProvider,
  Provider.succeed(Random, {
    delete: () => Effect.void,
    list: () => Effect.succeed([]),
    read: ({ output }) => Effect.succeed(output),
    reconcile: ({ news }) =>
      Effect.succeed({
        text: Redacted.make("a".repeat((news.bytes ?? 32) * 2)),
      }),
  }),
  Provider.succeed(BucketResource, {
    delete: () => Effect.void,
    list: () => Effect.succeed([]),
    read: ({ output }) => Effect.succeed(output),
    reconcile: ({ news }) =>
      Effect.succeed({ ...news, purgeOnDelete: news.purgeOnDelete ?? false }),
  }),
).pipe(
  Layer.provideMerge(
    Layer.sync(Rendered, () => ({
      directories: new Set<string>(),
      files: new Map<string, string>(),
    })),
  ),
);

export const renderedSurface = (rendered: typeof Rendered.Service) => ({
  directories: [...rendered.directories].toSorted(),
  files: Object.fromEntries(
    [...rendered.files.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
  ),
});
