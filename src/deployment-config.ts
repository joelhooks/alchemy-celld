import { Effect, Schema } from "effect";

import { BuildDiagnostic, RedactedEntrypoint } from "./build-diagnostics.ts";
import { ErrorDetails, errorMessage } from "./error-details.ts";

const bindingNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export const BindingName = Schema.String.check(Schema.isPattern(bindingNamePattern));

export const Declaration = Schema.Struct({
  compatibility_date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
  compatibility_flags: Schema.Array(Schema.String),
  durable_objects: Schema.Struct({
    bindings: Schema.Array(Schema.Struct({ class_name: Schema.String, name: BindingName })),
  }),
  migrations: Schema.Array(
    Schema.Struct({
      new_sqlite_classes: Schema.Array(Schema.String),
      tag: Schema.String,
    }),
  ),
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u)),
});

export const GeneratedConfiguration = Schema.Struct({
  ...Declaration.fields,
  main: Schema.Literal("worker.mjs"),
  no_bundle: Schema.Literal(true),
  vars: Schema.Record(Schema.String, Schema.String).check(Schema.isPropertyNames(BindingName)),
});

export interface DeploymentBuild {
  readonly version: string;
  readonly commit: string;
  readonly main: string;
  readonly vars: Readonly<Record<string, string>>;
}

const IdentityDigest = Schema.Struct({ version: Schema.String, commit: Schema.String });

export class DeploymentError extends Schema.TaggedError<DeploymentError>()("DeploymentError", {
  operation: Schema.tag("deployment"),
  reason: Schema.String,
  ...ErrorDetails,
  expected: Schema.optionalKey(IdentityDigest),
  actual: Schema.optionalKey(IdentityDigest),
  identityEncoding: Schema.optionalKey(Schema.Literal("sha256")),
  entrypoint: Schema.optionalKey(RedactedEntrypoint),
  diagnostics: Schema.optionalKey(Schema.Array(BuildDiagnostic)),
}) {
  override get message(): string {
    return errorMessage(this);
  }
}

export const wranglerConfiguration = Effect.fn("Celld.Deployment.configuration")(
  function* wranglerConfiguration(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This generator parses an untrusted declaration before use.
    declaration: unknown,
    build: DeploymentBuild,
  ) {
    const bindings = yield* Schema.decodeUnknownEffect(Declaration, {
      onExcessProperty: "error",
    })(declaration).pipe(
      Effect.mapError(
        () =>
          new DeploymentError({
            reason: "Unsupported deployment declaration",
            field: "declaration",
            expectedShape:
              "Declaration schema with compatibility_date, compatibility_flags, durable_objects, migrations and name; no extra keys",
            action:
              "Correct the declaration's fields and binding-name syntax before generating configuration.",
          }),
      ),
    );

    const names = bindings.durable_objects.bindings.map((binding) => binding.name);

    const classes = bindings.durable_objects.bindings.map((binding) => binding.class_name);

    const migrated = bindings.migrations.flatMap((migration) => migration.new_sqlite_classes);

    if (
      new Set(names).size !== names.length ||
      names.some((name) => Object.hasOwn(build.vars, name)) ||
      Object.keys(build.vars).some((name) => !bindingNamePattern.test(name)) ||
      classes.some((name) => !migrated.includes(name)) ||
      migrated.some((name) => !classes.includes(name))
    ) {
      return yield* new DeploymentError({
        reason: "Invalid deployment bindings",
        field:
          new Set(names).size !== names.length
            ? "durable_objects.bindings.name"
            : names.some((name) => Object.hasOwn(build.vars, name)) ||
                Object.keys(build.vars).some((name) => !bindingNamePattern.test(name))
              ? "build.vars"
              : classes.some((name) => !migrated.includes(name))
                ? "durable_objects.bindings.class_name"
                : "migrations.new_sqlite_classes",
        expectedShape:
          "Unique binding identifiers, no variable collisions, and exactly the declared classes in migrations",
        action:
          "Remove duplicate/colliding names and make binding classes and migration classes agree.",
      });
    }

    if (build.version.length === 0 || build.commit.length === 0 || build.main.length === 0) {
      return yield* new DeploymentError({
        reason: "Invalid bundle identity",
        field:
          build.version.length === 0
            ? "build.version"
            : build.commit.length === 0
              ? "build.commit"
              : "build.main",
        expectedShape: "A nonempty string",
        action:
          "Supply the missing bundle identity field before generating deployment configuration.",
      });
    }

    return { ...bindings, main: build.main, no_bundle: true, vars: build.vars };
  },
);

export const bundleDefines = (build: Pick<DeploymentBuild, "version" | "commit">) => ({
  __BUNDLE_COMMIT__: JSON.stringify(build.commit),
  __BUNDLE_VERSION__: JSON.stringify(build.version),
});
