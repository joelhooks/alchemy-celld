import { Effect, Schema } from "effect";

import { assertDeletePath, isBootstrapDirectory } from "./delete-custody.ts";
import { refuse } from "./files.ts";
import type { Interface } from "./host-shell.ts";
import { must } from "./host-shell.ts";

export const bootstrapCleanupScript = String.raw`
import json, os, re, stat, sys
root = sys.argv[1]
pattern = re.compile(r"bootstrap-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
paths = []
if os.path.lexists(root):
    if not stat.S_ISDIR(os.lstat(root).st_mode):
        raise RuntimeError("Configuration root is not a real directory")
    for name in sorted(os.listdir(root)):
        if pattern.fullmatch(name) is None:
            continue
        path = os.path.join(root, name)
        if not stat.S_ISDIR(os.lstat(path).st_mode):
            raise RuntimeError("Bootstrap path is not a real directory")
        for child in os.listdir(path):
            if child not in {"index.js", "wrangler.json"} or not stat.S_ISREG(os.lstat(os.path.join(path, child)).st_mode):
                raise RuntimeError("Unexpected bootstrap child")
        paths.append(path)
print(json.dumps(paths))
`;

export const cleanupBootstrapDirectories = Effect.fn("Instance.cleanupBootstrapDirectories")(
  function* cleanup(shell: Interface, root: string) {
    yield* assertDeletePath(shell, root, "directories");

    const output = yield* must(shell, ["python3", "-c", bootstrapCleanupScript, root]);

    const paths = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
      output,
    ).pipe(Effect.mapError(() => refuse("Malformed bootstrap directory listing.")));

    for (const path of paths) {
      if (!isBootstrapDirectory(root, path)) {
        return yield* refuse("Bootstrap directory listing escapes its config root.");
      }

      yield* assertDeletePath(shell, path, "directories");
    }

    for (const path of paths) {
      for (const name of ["index.js", "wrangler.json"]) {
        const file = `${path}/${name}`;
        yield* assertDeletePath(shell, file, "files");
        yield* shell.remove(file);
      }

      yield* shell.rmdir(path);
    }

    return yield* Effect.void;
  },
);
