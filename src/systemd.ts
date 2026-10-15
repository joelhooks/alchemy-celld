import { Effect, Schema } from "effect";

import { absent } from "./absent.ts";
import { ownedPath } from "./adoption.ts";
import { assertDeleteUnit } from "./delete-custody.ts";
import { AbsolutePath, readFile, refuse, textDigest } from "./files.ts";
import { must } from "./host-shell.ts";
import type { Interface } from "./host-shell.ts";
import { deleteFile } from "./instance-files.ts";
import { removeStoreSockets, wantsLink } from "./unit-cleanup.ts";

const directive = Schema.String.check(Schema.isPattern(/^[^\r\n\0]*$/u));

const section = Schema.Struct({
  lines: Schema.Array(
    Schema.Tuple([Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9]*$/u)), directive]),
  ),
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9]*$/u)),
});

export const UnitSchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  home: AbsolutePath,
  name: Schema.String.check(
    Schema.isPattern(
      /^[A-Za-z0-9][A-Za-z0-9_@:-]*(?:\.[A-Za-z0-9_@:-]+)*\.(?:service|slice|timer)$/u,
    ),
  ),
  prepared: Schema.optionalKey(Schema.Array(directive)),
  restartOn: Schema.optionalKey(Schema.Array(directive)),
  scope: Schema.Literal("user"),
  sections: Schema.NonEmptyArray(section),
  started: Schema.optionalKey(Schema.Boolean),
});

export type UnitProps = typeof UnitSchema.Type;

export interface UnitAttributes {
  readonly name: string;
  readonly home: string;
  readonly scope: "user";
  readonly path: string;
  readonly sha256: string;
  readonly configSha256: string;
  readonly active: boolean;
  readonly invocationId?: string;
  readonly enabled: boolean;
  readonly needDaemonReload: boolean;
}

export const renderUnit = (props: UnitProps): string =>
  `${props.sections.map((s) => [`[${s.name}]`, ...s.lines.map(([key, value]) => `${key}=${value}`)].join("\n")).join("\n\n")}\n`;

export const unitPath = (props: Pick<UnitProps, "home" | "name">): string =>
  `${props.home}/.config/systemd/user/${props.name}`;

const enabled = (props: UnitProps): boolean =>
  props.enabled ?? props.sections.some((s) => s.name === "Install");

const configDigest = (props: UnitProps): string => textDigest((props.restartOn ?? []).join("\n"));

export const withoutLegacyHelperInputs = <A extends UnitAttributes>(
  olds: UnitProps | undefined,
  news: UnitProps,
  output: A | undefined,
  prepared: boolean,
): A | undefined => {
  const previous = olds?.restartOn ?? [];
  const next = news.restartOn ?? [];

  if (
    !prepared ||
    olds === undefined ||
    output === undefined ||
    olds.prepared !== undefined ||
    previous.length <= 2 ||
    next.length !== 2 ||
    previous[0] !== next[0] ||
    previous[1] !== next[1] ||
    output.configSha256 !== configDigest(olds)
  ) {
    return output;
  }

  return {
    ...output,
    configSha256: configDigest({ ...olds, restartOn: next }),
  };
};

export const validateUnit = Effect.fn("SystemdUnit.validate")(function* validateUnit(
  props: UnitProps,
) {
  const valid = yield* Schema.decodeEffect(UnitSchema)(props).pipe(
    Effect.mapError(() => refuse("Invalid user unit declaration.")),
  );

  if (enabled(valid) && !valid.sections.some((s) => s.name === "Install")) {
    return yield* refuse("Enabled unit needs an Install section.");
  }

  if (valid.name.endsWith(".slice") && !valid.sections.some((s) => s.name === "Slice")) {
    return yield* refuse("Slice unit needs a Slice section.");
  }

  return valid;
});

const ctl = (shell: Interface, action: string, name?: string) =>
  must(shell, ["systemctl", "--user", action, ...(name === undefined ? [] : [name])]);

const status = Effect.fn("SystemdUnit.status")(function* status(
  shell: Interface,
  props: Pick<UnitProps, "home" | "name">,
) {
  const result = yield* shell.exec([
    "systemctl",
    "--user",
    "show",
    props.name,
    "--no-pager",
    "--property=LoadState,ActiveState,SubState,UnitFileState,NeedDaemonReload,FragmentPath,InvocationID",
  ]);

  const fields = new Map(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");

        return [line.slice(0, at), line.slice(at + 1)] as const;
      }),
  );

  const load = fields.get("LoadState");

  if (load === "not-found") {
    return { active: false, enabled: false, needDaemonReload: false };
  }

  if (
    result.code !== 0 ||
    load !== "loaded" ||
    !fields.has("ActiveState") ||
    !fields.has("NeedDaemonReload")
  ) {
    return yield* refuse("Unusable or malformed user unit status.");
  }

  const implicitSlice = props.name.endsWith(".slice") && fields.get("FragmentPath") === "";

  if (fields.get("FragmentPath") !== unitPath(props) && !implicitSlice) {
    return yield* refuse("Unit name resolves to a different fragment.");
  }

  return {
    active: fields.get("ActiveState") === "active" || fields.get("ActiveState") === "activating",
    enabled:
      fields.get("UnitFileState") === "enabled" ||
      fields.get("UnitFileState") === "enabled-runtime",
    invocationId: fields.get("InvocationID") ?? "",
    needDaemonReload: fields.get("NeedDaemonReload") === "yes",
  };
});

export const startOwnedUnit = Effect.fn("SystemdUnit.startOwned")(function* startOwned(
  shell: Interface,
  output: Pick<UnitAttributes, "home" | "name" | "sha256">,
) {
  const file = yield* readFile(shell, unitPath(output));

  if (file === undefined || file.mode !== 0o644 || file.sha256 !== output.sha256) {
    return yield* refuse("Owned unit file changed or absent; start refused.");
  }

  const live = yield* status(shell, output);

  if (live.needDaemonReload) {
    return yield* refuse("Owned unit needs daemon reload; start refused.");
  }

  return yield* ctl(shell, "start", output.name);
});

export const readUnit = Effect.fn("SystemdUnit.read")(function* readUnit(
  shell: Interface,
  props: UnitProps,
) {
  yield* validateUnit(props);
  const file = yield* readFile(shell, unitPath(props));
  const live = yield* status(shell, props);

  if (file === undefined) {
    if (live.active || live.enabled) {
      return yield* refuse("Unit file is absent but the manager still holds it.");
    }

    return absent;
  }

  return {
    configSha256: configDigest(props),
    home: props.home,
    name: props.name,
    path: file.path,
    scope: props.scope,
    sha256: file.sha256,
    ...live,
  } satisfies UnitAttributes;
});

export const ownedUnit = Effect.fn("SystemdUnit.adopt.owned")(function* ownedUnit(
  shell: Interface,
  props: UnitProps,
  live: UnitAttributes,
) {
  const file = yield* readFile(shell, unitPath(props));

  if (file?.mode !== 0o644 || live.sha256 !== textDigest(renderUnit(props))) {
    return yield* refuse("Only the exact declared unit may be adopted.");
  }

  const layout = shell.deleteCustody?.layout;

  const instance =
    layout?.instance ??
    props.name.replace(
      /(?:-(?:celld|seaweedfs|storage-retention))?\.(?:service|slice|timer)$/u,
      "",
    );

  const slice = `${instance}.slice`;

  const inSlice =
    props.name === slice ||
    props.name.endsWith(".timer") ||
    props.sections.some((part) =>
      part.lines.some(([key, value]) => key === "Slice" && value === slice),
    );

  return inSlice && (yield* ownedPath(shell, `${props.home}/.config/${instance}`));
});

export const needsUpdate = (
  props: UnitProps,
  output: UnitAttributes,
  live: UnitAttributes | undefined,
): boolean =>
  live === undefined ||
  live.sha256 !== textDigest(renderUnit(props)) ||
  output.sha256 !== live.sha256 ||
  output.configSha256 !== configDigest(props) ||
  live.enabled !== enabled(props) ||
  live.active !== (props.started ?? true) ||
  live.needDaemonReload;

const validSocketPort = (port: number) =>
  Number.isSafeInteger(port) && port >= 1024 && port <= 65_535;

export const deleteUnit = Effect.fn("SystemdUnit.delete")(function* deleteUnit(
  shell: Interface,
  output: UnitAttributes,
) {
  yield* assertDeleteUnit(shell, output);
  const live = yield* status(shell, output);
  const store = output.name.endsWith("-seaweedfs.service");

  const text = store ? new TextDecoder().decode(yield* shell.read(output.path)) : "";

  const s3 = Number(/-s3\.port=(?<port>\d+)/u.exec(text)?.groups?.port);

  const s3Grpc = Number(/-s3\.port\.grpc=(?<port>\d+)/u.exec(text)?.groups?.port);

  if (
    store &&
    (textDigest(text) !== output.sha256 ||
      !validSocketPort(s3) ||
      !validSocketPort(s3Grpc) ||
      (shell.deleteCustody !== undefined &&
        (s3 !== shell.deleteCustody.layout.ports.s3 ||
          s3Grpc !== shell.deleteCustody.layout.ports.s3Grpc)))
  ) {
    return yield* refuse("Store socket cleanup requires its declared ports.");
  }

  yield* wantsLink(shell, output.home, output.name, "check");

  if (live.active) {
    yield* ctl(shell, "stop", output.name);
  }

  if (live.enabled) {
    yield* ctl(shell, "disable", output.name);
  }

  yield* deleteFile(shell, {
    mode: 0o644,
    path: output.path,
    sha256: output.sha256,
  });
  yield* wantsLink(shell, output.home, output.name, "remove");
  yield* ctl(shell, "daemon-reload");

  if (store) {
    yield* removeStoreSockets(shell, { s3, s3Grpc });
  }

  return yield* Effect.void;
});

export const deleteDeclaredUnit = Effect.fn("SystemdUnit.deleteDeclared")(function* removeDeclared(
  shell: Interface,
  props: UnitProps,
) {
  yield* assertDeleteUnit(shell, props);
  const output = yield* readUnit(shell, props);

  if (output === undefined) {
    return yield* Effect.void;
  }

  if (output.sha256 !== textDigest(renderUnit(props))) {
    return yield* refuse("Declared unit changed; delete refused.");
  }

  return yield* deleteUnit(shell, output);
});

const cleanupCreatedUnit = Effect.fn("SystemdUnit.cleanupCreated")(function* cleanup(
  shell: Interface,
  props: UnitProps,
  sha256: string,
) {
  yield* assertDeleteUnit(shell, props);
  const path = unitPath(props);
  const file = yield* readFile(shell, path);

  if (file === undefined) {
    return yield* Effect.void;
  }

  if (file.sha256 !== sha256 || file.mode !== 0o644) {
    return yield* refuse("Failed-create unit changed; cleanup refused.");
  }

  yield* shell.exec(["systemctl", "--user", "stop", props.name]);
  yield* shell.exec(["systemctl", "--user", "disable", props.name]);
  yield* deleteFile(shell, { mode: 0o644, path, sha256 });
  yield* ctl(shell, "daemon-reload");

  return yield* Effect.void;
});

const cascadeChanged = (
  output: UnitAttributes | undefined,
  live: Pick<UnitAttributes, "active" | "invocationId" | "needDaemonReload">,
  wrote: boolean,
) =>
  output?.invocationId !== undefined &&
  output.invocationId !== "" &&
  live.invocationId !== undefined &&
  live.invocationId !== "" &&
  live.invocationId !== output.invocationId &&
  live.active &&
  !wrote &&
  !live.needDaemonReload;

export const reconcileUnit = Effect.fn("SystemdUnit.reconcile")(function* reconcileUnit(
  shell: Interface,
  props: UnitProps,
  output: UnitAttributes | undefined,
  adopt: boolean,
  processMatches: Effect.Effect<boolean> = Effect.succeed(false),
) {
  const valid = yield* validateUnit(props);
  const path = unitPath(valid);

  if (output !== undefined && output.path !== path) {
    return yield* refuse("Unit identity changes require delete-first replacement.");
  }

  const before = yield* readFile(shell, path);
  const live = yield* status(shell, valid);

  if (before === undefined && live.active && output === undefined) {
    return yield* refuse("Active unit without its declared file cannot be claimed.");
  }

  const text = renderUnit(valid);
  const sha256 = textDigest(text);

  if (before !== undefined && output === undefined) {
    if (!adopt) {
      return yield* refuse("Existing unit requires explicit adoption.");
    }

    if (before.sha256 !== sha256) {
      return yield* refuse("Only a matching unit may be adopted.");
    }
  }

  const wrote = before?.sha256 !== sha256;

  const cascadeApplied = cascadeChanged(output, live, wrote) && (yield* processMatches);

  const changed =
    !cascadeApplied &&
    (wrote ||
      live.needDaemonReload ||
      (output !== undefined &&
        (output.sha256 !== sha256 || output.configSha256 !== configDigest(valid))));

  const apply = Effect.gen(function* apply() {
    if (wrote) {
      yield* shell.write({
        bytes: new TextEncoder().encode(text),
        mode: 0o644,
        path,
      });
    }

    if (wrote || live.needDaemonReload) {
      yield* ctl(shell, "daemon-reload");
    }

    if (live.enabled !== enabled(valid)) {
      yield* ctl(shell, enabled(valid) ? "enable" : "disable", valid.name);
    }

    if (valid.started !== false) {
      if (!live.active) {
        yield* ctl(shell, "start", valid.name);
      } else if (changed) {
        yield* ctl(shell, "restart", valid.name);
      }
    } else if (live.active) {
      yield* ctl(shell, "stop", valid.name);
    }

    const after = yield* readUnit(shell, valid);

    if (
      after === undefined ||
      after.sha256 !== sha256 ||
      after.active !== (valid.started ?? true) ||
      after.enabled !== enabled(valid) ||
      after.needDaemonReload
    ) {
      return yield* refuse("User unit failed readback.");
    }

    return after;
  });

  return yield* apply.pipe(
    Effect.onError(() =>
      before === undefined
        ? cleanupCreatedUnit(shell, valid, sha256).pipe(Effect.orDie)
        : Effect.void,
    ),
  );
});
