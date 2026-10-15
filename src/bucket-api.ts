import { Resource } from "alchemy";
import { AdoptPolicy, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Effect, Option, Result as EffectResult, Schedule, Schema } from "effect";

import { absent } from "./absent.ts";
import { ownedPath } from "./adoption.ts";
import { AbsolutePath, readFile, refuse } from "./files.ts";
import { HostError, HostShell } from "./host-shell.ts";
import type { Interface } from "./host-shell.ts";
import { s3Script } from "./s3-script.ts";
import { startOwnedUnit } from "./systemd.ts";

const OwnedStore = Schema.Struct({
  home: AbsolutePath,
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,15}-seaweedfs\.service$/u)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});

const Props = Schema.Struct({
  config: AbsolutePath,
  endpoint: Schema.String.check(Schema.isPattern(/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/u)),
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u)),
  ownedStore: Schema.optionalKey(OwnedStore),
  purgeOnDelete: Schema.optionalKey(Schema.Boolean),
  ready: Schema.String,
  region: Schema.Literal("us-east-1"),
});

export type BucketProps = typeof Props.Type;

export interface BucketAttributes {
  readonly endpoint: string;
  readonly name: string;
  readonly region: "us-east-1";
  readonly config: string;
  readonly purgeOnDelete: boolean;
  readonly ownedStore?: typeof OwnedStore.Type;
}

export type S3BucketResource = Resource<"ObjectStore.Bucket", BucketProps, BucketAttributes>;

export const BucketResource = Resource<S3BucketResource>("ObjectStore.Bucket");

const Result = Schema.Struct({ status: Schema.Int, version: Schema.String });

export const bucketRequest = Effect.fn("ObjectStore.request")(function* request(
  shell: Interface,
  props: Pick<BucketProps, "config" | "endpoint" | "name">,
  operation: "read" | "create" | "delete" | "version" | "purge",
) {
  const result = yield* shell.exec([
    "python3",
    "-c",
    s3Script,
    props.config,
    props.endpoint,
    props.name,
    operation,
  ]);

  if (result.code !== 0) {
    return yield* refuse("S3 operation failed; credentials redacted.");
  }

  return yield* Schema.decodeEffect(Schema.fromJsonString(Result))(result.stdout).pipe(
    Effect.mapError(() => refuse("Malformed S3 response; values redacted.")),
  );
});

const validate = (props: BucketProps) =>
  Schema.decodeEffect(Props)(props).pipe(
    Effect.mapError(() => refuse("Invalid bucket declaration.")),
  );

const read = Effect.fn("ObjectStore.read")(function* read(shell: Interface, props: BucketProps) {
  yield* validate(props);

  const result = yield* bucketRequest(shell, props, "read").pipe(
    Effect.retry(Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 20 }))),
  );

  if (result.status === 404) {
    return absent;
  }

  if (result.status !== 200) {
    return yield* refuse("Bucket read failed.");
  }

  const version = yield* bucketRequest(shell, props, "version");

  if (version.status !== 200 || version.version !== "") {
    return yield* refuse("Bucket must have never enabled versioning.");
  }

  const attributes = {
    config: props.config,
    endpoint: props.endpoint,
    name: props.name,
    purgeOnDelete: props.purgeOnDelete ?? false,
    region: props.region,
  } satisfies BucketAttributes;

  return props.ownedStore === undefined
    ? attributes
    : { ...attributes, ownedStore: props.ownedStore };
});

const recoveryError = () =>
  new HostError({
    operation: "bucket-delete-recovery",
    reason:
      "Store unavailable for bucket drain; recovery of the owned user unit failed or ownership was not proven.",
  });

const deleteVersion = Effect.fn("ObjectStore.deleteVersion")(function* deleteVersion(
  shell: Interface,
  output: BucketAttributes,
  _olds: BucketProps,
) {
  const before = yield* bucketRequest(shell, output, "version").pipe(Effect.result);

  if (EffectResult.isSuccess(before) && before.success.status < 500) {
    return before.success;
  }

  const owned = yield* Schema.decodeUnknownEffect(OwnedStore)(output.ownedStore).pipe(
    Effect.mapError(recoveryError),
  );

  yield* startOwnedUnit(shell, owned).pipe(Effect.mapError(recoveryError));

  return yield* bucketRequest(shell, output, "version").pipe(
    Effect.filterOrFail((response) => response.status < 500, recoveryError),
    Effect.retry(Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 20 }))),
    Effect.mapError(recoveryError),
  );
});

export const BucketProvider = () =>
  Provider.effect(
    BucketResource,
    Effect.gen(function* provider() {
      const shell = yield* HostShell;

      return BucketResource.Provider.of({
        delete: Effect.fn("ObjectStore.provider.delete")(function* operation({ output, olds }) {
          if (output === undefined) {
            return yield* Effect.void;
          }

          const custody = shell.deleteCustody;

          if (
            custody !== undefined &&
            (output.config !== `${custody.layout.configuration}/s3.json` ||
              output.endpoint !== `http://127.0.0.1:${custody.layout.ports.s3}` ||
              output.ownedStore?.home !== custody.home ||
              output.ownedStore.name !== custody.layout.storeUnit)
          ) {
            return yield* refuse("Bucket delete escapes its instance custody.");
          }

          const version = yield* deleteVersion(shell, output, olds);

          if (version.status !== 404 && (version.status !== 200 || version.version !== "")) {
            return yield* refuse("Purge refuses a bucket with versioning drift.");
          }

          const result = yield* bucketRequest(
            shell,
            output,
            output.purgeOnDelete ? "purge" : "delete",
          );

          if (result.status !== 204 && result.status !== 404) {
            return yield* refuse("Bucket delete refused; drain owned objects first.");
          }

          return yield* Effect.void;
        }),
        diff: Effect.fn("ObjectStore.provider.diff")(function* operation({ news, output }) {
          if (!isResolved(news)) {
            return absent;
          }

          yield* validate(news);

          if (
            output !== undefined &&
            (news.name !== output.name ||
              news.endpoint !== output.endpoint ||
              news.config !== output.config)
          ) {
            if ((yield* read(shell, news)) !== undefined) {
              return yield* refuse("Replacement bucket already exists.");
            }

            return { action: "replace", deleteFirst: true };
          }

          return {
            action:
              (yield* read(shell, news)) === undefined ||
              output?.purgeOnDelete !== (news.purgeOnDelete ?? false) ||
              output?.ownedStore?.sha256 !== news.ownedStore?.sha256 ||
              output?.ownedStore?.home !== news.ownedStore?.home
                ? "update"
                : "noop",
          };
        }),
        list: () => Effect.succeed([]),
        read: Effect.fn("ObjectStore.provider.read")(function* operation({ olds, output }) {
          if (output === undefined && !Schema.is(Props)(olds)) {
            return absent;
          }

          const live = yield* read(shell, olds);

          if (live !== undefined && output === undefined && olds.purgeOnDelete === true) {
            return yield* refuse("Existing bucket cannot gain purge authority by adoption.");
          }

          if (live === undefined || output !== undefined) {
            return live;
          }

          const store = olds.ownedStore;

          if (store !== undefined) {
            const unit = yield* readFile(shell, `${store.home}/.config/systemd/user/${store.name}`);

            if (
              unit?.sha256 !== store.sha256 ||
              unit.mode !== 0o644 ||
              olds.config !==
                `${store.home}/.config/${store.name.slice(0, -"-seaweedfs.service".length)}/s3.json` ||
              !(yield* ownedPath(shell, olds.config))
            ) {
              return yield* refuse(
                "Bucket adoption requires its exact owned store and configuration.",
              );
            }

            return live;
          }

          return Unowned(live);
        }),
        reconcile: Effect.fn("ObjectStore.provider.reconcile")(function* operation({
          news,
          output,
        }) {
          yield* validate(news);
          const live = yield* read(shell, news);

          const adopt = yield* Effect.serviceOption(AdoptPolicy).pipe(
            Effect.map(Option.getOrElse(() => false)),
          );

          if (live !== undefined) {
            if (output === undefined && (!adopt || news.purgeOnDelete === true)) {
              return yield* refuse("Existing bucket needs explicit adoption.");
            }

            return live;
          }

          const created = yield* bucketRequest(shell, news, "create");

          if (created.status !== 200) {
            return yield* refuse("Bucket create failed.");
          }

          const after = yield* read(shell, news);

          if (after === undefined) {
            return yield* refuse("Bucket create failed readback.");
          }

          return after;
        }),
      });
    }),
  );
