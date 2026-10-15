import { Effect, Schema } from "effect";

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

export class DeploymentError extends Schema.TaggedError<DeploymentError>()("DeploymentError", {
  reason: Schema.String,
}) {}

export const wranglerConfiguration = Effect.fn("Celld.Deployment.configuration")(
  function* wranglerConfiguration(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This generator parses an untrusted declaration before use.
    declaration: unknown,
    build: DeploymentBuild,
  ) {
    const bindings = yield* Schema.decodeUnknownEffect(Declaration, {
      onExcessProperty: "error",
    })(declaration).pipe(
      Effect.mapError(() => new DeploymentError({ reason: "Unsupported deployment declaration" })),
    );

    const names = bindings.durable_objects.bindings.map((binding) => binding.name);

    const classes = bindings.durable_objects.bindings.map((binding) => binding.class_name);

    const migrated = bindings.migrations.flatMap((migration) => migration.new_sqlite_classes);

    if (
      new Set(names).size !== names.length ||
      names.some((name) => Object.hasOwn(build.vars, name)) ||
      Object.keys(build.vars).some((name) => !bindingNamePattern.test(name)) ||
      classes.some((name) => !migrated.includes(name)) ||
      migrated.some((name) => !classes.includes(name)) ||
      build.version.length === 0 ||
      build.commit.length === 0 ||
      build.main.length === 0
    ) {
      return yield* new DeploymentError({
        reason: "Invalid deployment bindings or bundle identity",
      });
    }

    return { ...bindings, main: build.main, no_bundle: true, vars: build.vars };
  },
);

export const bundleDefines = (build: Pick<DeploymentBuild, "version" | "commit">) => ({
  __BUNDLE_COMMIT__: JSON.stringify(build.commit),
  __BUNDLE_VERSION__: JSON.stringify(build.version),
});
