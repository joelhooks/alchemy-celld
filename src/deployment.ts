import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Effect, Result, Schedule, Schema } from "effect";
import { HttpClient } from "effect/http";

import { absent } from "./absent.ts";
import { ownedPath } from "./adoption.ts";
import { deploymentDeleteRoot } from "./delete-custody.ts";
import { DeploymentError, GeneratedConfiguration } from "./deployment-config.ts";
import { AbsolutePath, digest, textDigest } from "./files.ts";
import { HostShell, must } from "./host-shell.ts";
import type { Interface } from "./host-shell.ts";
import { deleteDirectory } from "./instance-files.ts";
import { shellQuote } from "./ssh.ts";

export interface DeploymentProps {
  readonly bundle: string;
  readonly configuration: string;
  readonly version: string;
  readonly commit: string;
  readonly directory: string;
  readonly binary: string;
  readonly environmentFile: string;
  readonly internalUrl: string;
  readonly workerUrl: string;
  readonly versionPath?: string;
  readonly bindingsFile?: string;
  readonly secretNames?: readonly string[];
}

export interface DeploymentAttributes extends DeploymentProps {
  readonly sha256: string;
}

export type DeploymentResource = Resource<
  "Celld.Deployment",
  DeploymentProps,
  DeploymentAttributes
>;

export const Deployment = Resource<DeploymentResource>("Celld.Deployment");

export const bindingConfigurationScript = String.raw`
import json, pathlib, stat, sys
try:
    directory, binding = map(pathlib.Path, sys.argv[1:3])
    for path in [directory, binding, directory/"wrangler.public.json", directory/"wrangler.json"]:
        if any(part.is_symlink() for part in [path, *path.parents]):
            raise ValueError()
    if stat.S_IMODE(binding.stat().st_mode) != 0o600:
        raise ValueError()
    config = json.loads((directory/"wrangler.public.json").read_text())
    secrets = json.loads(binding.read_text())
    allowed = set()
    if not secrets or not set(secrets).issubset(allowed) or set(secrets).intersection(config["vars"]):
        raise ValueError()
    config["vars"].update(secrets)
    target = directory/"wrangler.json"
    target.touch(mode=0o600, exist_ok=True)
    target.chmod(0o600)
    target.write_text(json.dumps(config))
except Exception:
    print("Private binding generation refused", file=sys.stderr)
    sys.exit(1)
`;

const SecretNames = Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u)));

const usesDefaultSecretNames = (names: readonly string[] | undefined) =>
  names === undefined || names.length === 0;

export const bindingConfigurationScriptFor = (secretNames?: readonly string[]) =>
  usesDefaultSecretNames(secretNames)
    ? bindingConfigurationScript
    : bindingConfigurationScript.replace(
        / {4}allowed = set\(\)/u,
        `    allowed = set(json.loads(${JSON.stringify(JSON.stringify(secretNames))}))`,
      );

const identity = Schema.Struct({
  commit: Schema.String,
  version: Schema.String,
});

const fingerprint = (props: DeploymentProps) => {
  const values: (string | readonly string[] | undefined)[] = [
    props.bundle,
    props.configuration,
    props.version,
    props.commit,
    props.directory,
    props.binary,
    props.environmentFile,
    props.internalUrl,
    props.workerUrl,
    props.versionPath ?? "/",
    props.bindingsFile,
  ];

  if (props.secretNames !== undefined && !usesDefaultSecretNames(props.secretNames)) {
    values.push(props.secretNames.toSorted());
  }

  return textDigest(JSON.stringify(values));
};

const validate = Effect.fn("Celld.Deployment.validate")(function* validate(props: DeploymentProps) {
  yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GeneratedConfiguration), {
    onExcessProperty: "error",
  })(props.configuration).pipe(
    Effect.mapError(
      () =>
        new DeploymentError({
          reason: "Invalid generated deployment configuration",
          field: "configuration",
          expectedShape:
            "JSON matching GeneratedConfiguration, including main=worker.mjs and no_bundle=true, without extra keys",
          action:
            "Regenerate the configuration with wranglerConfiguration before reconciling deployment.",
        }),
    ),
  );

  yield* Schema.decodeEffect(Schema.String.check(Schema.isPattern(/^\/(?!\/)[^\\\r\n\0?#]*$/u)))(
    props.versionPath ?? "/",
  ).pipe(
    Effect.mapError(
      () =>
        new DeploymentError({
          reason: "Version path must be an origin-relative path.",
          field: "versionPath",
          expectedShape:
            "A single-leading-slash path without backslash, CR, LF, NUL, query or fragment",
          action: "Set versionPath to the worker's origin-relative identity route, not a full URL.",
        }),
    ),
  );

  if (props.secretNames !== undefined) {
    yield* Schema.decodeEffect(SecretNames)(props.secretNames).pipe(
      Effect.mapError(
        () =>
          new DeploymentError({
            reason: "Invalid deployment secret names",
            field: Array.isArray(props.secretNames)
              ? `secretNames[${props.secretNames.findIndex((name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/u.test(name))}]`
              : "secretNames",
            expectedShape:
              "An array of strings matching ^[A-Z][A-Z0-9_]*$; offending value redacted",
            action:
              "Correct the identified entry's syntax; keep secret values in the private bindings file.",
          }),
      ),
    );
  }

  for (const path of [props.directory, props.binary, props.environmentFile]) {
    yield* Schema.decodeEffect(AbsolutePath)(path);
  }

  if (props.bindingsFile !== undefined) {
    yield* Schema.decodeEffect(AbsolutePath)(props.bindingsFile);
  }

  const internal = yield* Effect.try({
    catch: () =>
      new DeploymentError({
        reason: "Invalid internal listener URL",
        field: "internalUrl",
        expectedShape: "A valid loopback HTTP operator URL with root pathname",
        action: "Correct internalUrl in the private deployment declaration; do not log its value.",
      }),
    try: () => new URL(props.internalUrl),
  });

  if (
    internal.protocol !== "http:" ||
    internal.hostname !== "127.0.0.1" ||
    internal.pathname !== "/"
  ) {
    return yield* new DeploymentError({
      reason: "Reload must use the loopback operator listener",
      field: "internalUrl",
      expectedShape: "HTTP on 127.0.0.1 with pathname /",
      action:
        "Point internalUrl at the declared loopback operator listener, not the worker's public URL.",
    });
  }

  return yield* Effect.void;
});

export const deleteDeployment = Effect.fn("Celld.Deployment.delete")(function* remove(
  shell: Interface,
  input: {
    readonly olds?: Partial<DeploymentProps>;
    readonly output?: Pick<DeploymentAttributes, "directory">;
  },
) {
  if (input.output === undefined) {
    return yield* Effect.void;
  }

  const root = deploymentDeleteRoot(shell, input.output.directory);

  if (root === undefined) {
    return yield* new DeploymentError({
      reason: "Deployment delete escapes owned configuration",
      field: "output.directory",
      expectedShape: "A directory within the instance's inventory-derived configuration custody",
      action:
        "Restore the correct owned deployment directory in state; do not widen delete authority.",
    });
  }

  return yield* deleteDirectory(shell, {
    mode: 0o700,
    path: input.output.directory,
    purgeRoot: root,
  });
});

export const DeploymentProvider = () =>
  Provider.effect(
    Deployment,
    Effect.gen(function* makeDeploymentProvider() {
      const shell = yield* HostShell;
      const http = yield* HttpClient.HttpClient;

      const version = Effect.fn("Celld.Deployment.version")(function* version(
        props: DeploymentProps,
      ) {
        const response = yield* http.get(new URL(props.versionPath ?? "/", props.workerUrl).href);

        if (response.status !== 200) {
          return yield* new DeploymentError({
            reason: "Version readback failed",
            field: "versionPath",
            expectedShape: "An HTTP 200 response from the worker identity route",
            action:
              "Check worker health and the configured identity route before retrying deployment.",
          });
        }

        const current = Schema.decodeEffect(Schema.fromJsonString(identity))(yield* response.text);

        const decoded = yield* current.pipe(Effect.result);

        if (Result.isFailure(decoded)) {
          return false;
        }

        const observed = decoded.success;

        if (observed.version !== props.version || observed.commit !== props.commit) {
          return yield* new DeploymentError({
            reason: "Bundle identity does not match",
            field: "bundleIdentity",
            expectedShape:
              "The declared version and commit; expected/actual fields contain SHA-256 digests, not raw values",
            expected: { version: textDigest(props.version), commit: textDigest(props.commit) },
            actual: { version: textDigest(observed.version), commit: textDigest(observed.commit) },
            identityEncoding: "sha256",
            action:
              "Compare the differing identity fields locally and deploy the declared bundle before accepting readback.",
          });
        }

        return true;
      });

      const installed = Effect.fn("Celld.Deployment.installed")(function* installed(
        props: DeploymentProps,
      ) {
        const bundleMode = yield* shell.stat(`${props.directory}/worker.mjs`);

        const configurationMode = yield* shell.stat(
          `${props.directory}/${props.bindingsFile === undefined ? "wrangler.json" : "wrangler.public.json"}`,
        );

        const bundle = yield* shell.read(`${props.directory}/worker.mjs`);

        const configuration = yield* shell.read(
          `${props.directory}/${props.bindingsFile === undefined ? "wrangler.json" : "wrangler.public.json"}`,
        );

        return (
          bundleMode?.mode === 0o600 &&
          configurationMode?.mode === 0o600 &&
          bundle !== undefined &&
          configuration !== undefined &&
          digest(bundle) === textDigest(props.bundle) &&
          digest(configuration) === textDigest(props.configuration)
        );
      });

      return Deployment.Provider.of({
        delete: ({ olds, output }) => deleteDeployment(shell, { olds, output }),
        diff: Effect.fn("Celld.Deployment.diff")(function* diff({ news, output }) {
          if (!isResolved(news)) {
            return absent;
          }

          yield* validate(news);

          if (output !== undefined && output.directory !== news.directory) {
            return { action: "replace" };
          }

          if (
            output === undefined ||
            output.sha256 !== fingerprint(news) ||
            !(yield* installed(news))
          ) {
            return { action: "update" };
          }

          const observed = yield* version(news).pipe(Effect.result);

          return {
            action: Result.isSuccess(observed) && observed.success ? "noop" : "update",
          };
        }),
        list: () => Effect.succeed([]),
        read: Effect.fn("Celld.Deployment.read")(function* read({ olds, output }) {
          if (olds === undefined) {
            return output === undefined
              ? absent
              : yield* new DeploymentError({
                  reason: "Recorded deployment output requires previous props",
                  field: "olds",
                  expectedShape: "Previous DeploymentProps for recorded output",
                  action:
                    "Restore the matching previous props from provider state before reading this deployment.",
                });
          }

          const valid = yield* validate(olds).pipe(Effect.result);

          if (Result.isFailure(valid)) {
            return output === undefined ? absent : yield* valid.failure;
          }

          if (!(yield* installed(olds))) {
            if (output === undefined && (yield* shell.stat(olds.directory)) !== undefined) {
              return yield* new DeploymentError({
                reason: "Only the exact declared deployment may be adopted",
                field: "directory",
                expectedShape:
                  "Existing worker/configuration bytes and modes matching the declaration exactly",
                action:
                  "Compare the complete declared artifacts before adopting; do not claim a differing deployment.",
              });
            }

            return absent;
          }

          if (!(yield* version(olds))) {
            return absent;
          }

          if (output !== undefined) {
            return output;
          }

          const attrs = { ...olds, sha256: fingerprint(olds) };

          if (!(yield* ownedPath(shell, olds.directory))) {
            return Unowned(attrs);
          }

          const directory = yield* shell.stat(olds.directory);
          const bundle = yield* shell.stat(`${olds.directory}/worker.mjs`);

          const config = yield* shell.stat(
            `${olds.directory}/${olds.bindingsFile === undefined ? "wrangler.json" : "wrangler.public.json"}`,
          );

          if (directory?.mode !== 0o700 || bundle?.mode !== 0o600 || config?.mode !== 0o600) {
            return yield* new DeploymentError({
              reason: "Deployment adoption requires private file modes",
              field: "directory/worker.mjs/configuration modes",
              expectedShape: "Directory mode 0700 and worker/configuration file modes 0600",
              action:
                "Correct permissions on the verified owned artifacts before explicit adoption.",
            });
          }

          return attrs;
        }),
        reconcile: Effect.fn("Celld.Deployment.reconcile")(function* reconcile({ news, output }) {
          yield* validate(news);
          const directory = yield* shell.stat(news.directory);

          if (
            output?.sha256 === fingerprint(news) &&
            (yield* installed(news)) &&
            (yield* version(news))
          ) {
            return output;
          }

          if (output === undefined && directory !== undefined && !(yield* installed(news))) {
            return yield* new DeploymentError({
              reason: "Existing deployment directory requires explicit adoption",
              field: "directory",
              expectedShape:
                "An absent directory or an exactly matching explicitly adopted deployment",
              action:
                "Verify existing artifacts and use explicit adoption instead of overwriting an unrelated directory.",
            });
          }

          if (directory === undefined) {
            yield* shell.mkdir({ mode: 0o700, path: news.directory });
          } else if (directory.kind !== "directory" || directory.mode !== 0o700) {
            return yield* new DeploymentError({
              reason: "Deployment directory must have mode 700",
              field: "directory",
              expectedShape: "A regular directory with mode 0700",
              action:
                "Correct the type and mode of the owned deployment directory before reconciling.",
            });
          }

          if (!(yield* installed(news))) {
            yield* shell.write({
              bytes: new TextEncoder().encode(news.bundle),
              mode: 0o600,
              path: `${news.directory}/worker.mjs`,
            });
            yield* shell.write({
              bytes: new TextEncoder().encode(news.configuration),
              mode: 0o600,
              path: `${news.directory}/${news.bindingsFile === undefined ? "wrangler.json" : "wrangler.public.json"}`,
            });
          }

          if (news.bindingsFile !== undefined) {
            yield* must(shell, [
              "python3",
              "-c",
              bindingConfigurationScriptFor(news.secretNames),
              news.directory,
              news.bindingsFile,
            ]);
          }

          yield* must(shell, [
            "sh",
            "-c",
            `set -a; . ${shellQuote(news.environmentFile)}; set +a; exec ${shellQuote(news.binary)} deploy ${shellQuote(news.directory)} --json`,
          ]);
          yield* must(shell, [
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "30",
            "-X",
            "POST",
            new URL("/reload", news.internalUrl).href,
          ]);
          yield* version(news).pipe(
            Effect.flatMap(
              Effect.fn(function* requireInstalled(found) {
                if (!found) {
                  return yield* new DeploymentError({
                    reason: "Installed worker has no version identity",
                    field: "versionPath response",
                    expectedShape: "JSON containing string version and commit fields",
                    action:
                      "Expose the worker's declared identity on the configured route and retry readback.",
                  });
                }

                return yield* Effect.void;
              }),
            ),
            Effect.retry(Schedule.spaced("1 second")),
            Effect.timeout("60 seconds"),
          );

          return { ...news, sha256: fingerprint(news) };
        }),
      });
    }),
  );
