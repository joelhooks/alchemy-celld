import { Context, Effect, Option } from "effect";

import { fileText, readDirectory, readFile, refuse } from "./files.ts";
import type { Interface } from "./host-shell.ts";
import type { FileProps } from "./instance-files.ts";

export class StateRecovery extends Context.Service<StateRecovery, boolean>()(
  "@alchemy-celld/StateRecovery",
) {}

export const recovering = Effect.serviceOption(StateRecovery).pipe(
  Effect.map(Option.getOrElse(() => false)),
);

export const ownedPath = Effect.fn("Nest.adopt.ownedPath")(function* ownedPath(
  shell: Interface,
  path: string,
) {
  const root = shell.purgeRoots.find((entry) => path === entry || path.startsWith(`${entry}/`));

  if (root === undefined) {
    return false;
  }

  const directory = yield* readDirectory(shell, root);

  if (directory?.mode !== 0o700) {
    return yield* refuse("Adoption requires the inventory-owned mode-700 root.");
  }

  const parents = path
    .slice(root.length + 1)
    .split("/")
    .slice(0, -1);

  let parent = root;

  for (const part of parents) {
    parent = `${parent}/${part}`;
    const entry = yield* shell.stat(parent);

    if (entry?.kind !== "directory" || entry.mode !== 0o700) {
      return yield* refuse("Adoption refuses non-private or redirected parent directories.");
    }
  }

  return true;
});

export const rotationScript = String.raw`
import json, pathlib, re, stat, sys
try:
    path = pathlib.Path(sys.argv[1])
    if any(p.is_symlink() for p in [path, *path.parents]):
        raise ValueError()
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise ValueError()
    if path.name == "s3.json":
        obj = json.loads(path.read_text())
        identity, = obj["identities"]
        credential, = identity["credentials"]
        if set(obj) != {"identities"} or set(identity) != {"name", "actions", "credentials"} or identity["name"] != sys.argv[2] or identity["actions"] != ["Admin", "Read", "Write", "List", "Tagging"] or set(credential) != {"accessKey", "secretKey"} or not re.fullmatch("[a-f0-9]{32}", credential["accessKey"]) or not re.fullmatch("[a-f0-9]{64}", credential["secretKey"]):
            raise ValueError()
    elif path.name == "celld.env":
        if not re.fullmatch(r'AWS_ACCESS_KEY_ID="[a-f0-9]{32}"\nAWS_SECRET_ACCESS_KEY="[a-f0-9]{64}"\nAWS_REGION=us-east-1\nS3_ENDPOINT="http://127\.0\.0\.1:' + re.escape(sys.argv[3]) + r'"\nCELLD_BUCKET="s3://[a-z0-9][a-z0-9-]{1,61}[a-z0-9]"\nCELLD_OTEL=0\n', path.read_text()):
            raise ValueError()
    else:
        raise ValueError()
except Exception:
    sys.exit(1)
`;

export const rotatingFile = Effect.fn("Nest.adopt.rotatingFile")(function* rotatingFile(
  shell: Interface,
  props: FileProps,
) {
  const { path, rotationOwner: owner } = props;

  if (!(yield* recovering)) {
    return false;
  }

  if (owner === undefined) {
    return false;
  }

  const instance = owner.name.replace(/-(?:seaweedfs|celld)\.service$/u, "");

  const root = shell.purgeRoots.find((entry) => entry === `${owner.home}/.config/${instance}`);

  if (root === undefined || ![`${root}/s3.json`, `${root}/celld.env`].includes(path)) {
    return false;
  }

  if (!(yield* ownedPath(shell, path))) {
    return false;
  }

  const name = path.endsWith("/s3.json")
    ? `${instance}-seaweedfs.service`
    : `${instance}-celld.service`;

  if (owner === undefined || owner.name !== name || `${owner.home}/.config/${instance}` !== root) {
    return yield* refuse("Credential rotation requires its declared owner unit.");
  }

  const unit = yield* readFile(shell, `${owner.home}/.config/systemd/user/${owner.name}`);

  if (unit?.mode !== 0o644 || unit.sha256 !== owner.sha256) {
    return yield* refuse("Credential rotation refuses a foreign owner unit.");
  }

  const endpoint = /S3_ENDPOINT="http:\/\/127\.0\.0\.1:(?<port>\d+)"/u.exec(fileText(props.content))
    ?.groups?.port;

  const result = yield* shell.exec([
    "python3",
    "-c",
    rotationScript,
    path,
    instance,
    endpoint ?? "invalid",
  ]);

  if (result.code !== 0) {
    return yield* refuse("Credential rotation refuses a foreign configuration.");
  }

  return true;
});
