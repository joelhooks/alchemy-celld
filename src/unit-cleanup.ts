import { Effect } from "effect";

import { assertDeleteUnit } from "./delete-custody.ts";
import { refuse } from "./files.ts";
import { must } from "./host-shell.ts";
import type { Interface } from "./host-shell.ts";

export const wantsLinkScript = String.raw`
import os, pathlib, sys
home, name, operation = sys.argv[1:4]
root = pathlib.Path(home)/'.config/systemd/user'
link = root/'default.target.wants'/name
for parent in [root, link.parent]:
    if parent.is_symlink():
        raise ValueError('Unit parent symlink refused')
if os.path.lexists(link):
    if not link.is_symlink() or os.path.realpath(link) != str(root/name):
        raise ValueError('Different wants link refused')
    if operation == 'remove':
        link.unlink()
print('ready')
`;

export const storeSocketScript = String.raw`
import os, pathlib, stat, subprocess
paths = [pathlib.Path('/tmp/seaweedfs-s3-31006.sock'),
         pathlib.Path('/tmp/seaweedfs-s3-grpc-31007.sock')]
listeners = subprocess.run(['ss', '-H', '-lxnp'], check=True,
                           capture_output=True, text=True).stdout
for path in paths:
    if str(path) in listeners:
        raise ValueError('Listening socket refused')
    if os.path.lexists(path):
        info = path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError('Unowned or non-socket path refused')
for path in paths:
    if os.path.lexists(path):
        path.unlink()
print('ready')
`;

export const wantsLink = Effect.fn("SystemdUnit.wantsLink")(function* link(
  shell: Interface,
  home: string,
  name: string,
  operation: "check" | "remove",
) {
  yield* assertDeleteUnit(shell, { home, name });
  yield* must(shell, ["python3", "-c", wantsLinkScript, home, name, operation]);
});

export const removeStoreSockets = Effect.fn("SystemdUnit.storeSockets")(function* sockets(
  shell: Interface,
  ports?: { readonly s3: number; readonly s3Grpc: number },
) {
  if (
    shell.deleteCustody !== undefined &&
    (ports?.s3 !== shell.deleteCustody.layout.ports.s3 ||
      ports.s3Grpc !== shell.deleteCustody.layout.ports.s3Grpc)
  ) {
    return yield* refuse("Socket delete escapes its instance custody.");
  }

  const script =
    ports === undefined
      ? storeSocketScript
      : storeSocketScript
          .replace("seaweedfs-s3-31006.sock", `seaweedfs-s3-${ports.s3}.sock`)
          .replace("seaweedfs-s3-grpc-31007.sock", `seaweedfs-s3-grpc-${ports.s3Grpc}.sock`);

  return yield* must(shell, ["python3", "-c", script]).pipe(Effect.asVoid);
});
