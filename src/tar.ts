import { ArchiveRefused } from "./archive-error.ts";

const BLOCK = 512;

const KINDS = new Map<string, string>([
  ["1", "a hard link"],
  ["2", "a symlink"],
  ["3", "a character device"],
  ["4", "a block device"],
  ["5", "a directory"],
  ["6", "a FIFO"],
  ["7", "a contiguous file"],
  ["K", "a GNU long-link header"],
  ["L", "a GNU long-name header"],
  ["g", "a PAX global header"],
  ["x", "a PAX extended header"],
]);

const refuse = (message: string): ArchiveRefused => new ArchiveRefused({ message });

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const ascii = new TextDecoder("latin1");

const field = (block: Uint8Array, start: number, length: number): Uint8Array => {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);

  return end === -1 ? slice : slice.subarray(0, end);
};

const text = (block: Uint8Array, start: number, length: number): string => {
  try {
    return strict.decode(field(block, start, length));
  } catch {
    throw refuse("an entry name is not UTF-8");
  }
};

const octal = (block: Uint8Array, start: number, length: number, what: string): number => {
  const raw = block.subarray(start, start + length);

  if ((raw[0] ?? 0) >= 0x80) {
    throw refuse(`${what} is base-256 encoded`);
  }

  const digits = ascii
    .decode(raw)
    .replace(/[\0 ]+$/u, "")
    .replace(/^ +/u, "");

  if (!/^[0-7]+$/u.test(digits)) {
    throw refuse(`${what} is not octal: ${JSON.stringify(digits)}`);
  }

  return Number.parseInt(digits, 8);
};

const checksumHolds = (block: Uint8Array): boolean => {
  let sum = 0;

  for (let at = 0; at < BLOCK; at += 1) {
    sum += at >= 148 && at < 156 ? 0x20 : (block[at] ?? 0);
  }

  return sum === octal(block, 148, 8, "a header checksum");
};

const nameProblem = (name: string): string | undefined => {
  if (name === "") {
    return "has an empty name";
  }

  if (name.startsWith("/")) {
    return "is absolute";
  }

  if (name.split("/").includes("..")) {
    return 'climbs out of the archive with ".."';
  }

  return undefined;
};

export const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));

  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
};

export interface TarContents {
  readonly members: ReadonlyMap<string, Uint8Array>;

  readonly names: readonly string[];
}

export const tarReader = (wanted: ReadonlySet<string>, root?: string) => {
  const header = new Uint8Array(BLOCK);
  const members = new Map<string, Uint8Array>();
  const names: string[] = [];
  const seen = new Set<string>();
  let phase: "header" | "data" | "pad" | "end" = "header";
  let filled = 0;
  let remaining = 0;
  let padding = 0;
  let zeros = 0;
  let name = "";
  let parts: Uint8Array[] | undefined;
  let rootSeen = false;
  const rootPrefix = root === undefined ? undefined : `${root}/`;

  const endEntry = () => {
    if (parts !== undefined) {
      members.set(name, concatBytes(parts));
    }

    parts = undefined;
    phase = padding > 0 ? "pad" : "header";
  };

  const acceptRoot = (rawName: string): boolean => {
    if (rootPrefix === undefined || rawName !== rootPrefix) {
      return false;
    }

    if (rootSeen) {
      throw refuse("Declared root appears twice.");
    }

    const type = String.fromCodePoint(header[156] ?? 0);
    const size = octal(header, 124, 12, "root size");

    if (type !== "5" || size !== 0) {
      throw refuse("Declared root is not an empty directory.");
    }

    rootSeen = true;
    phase = "header";

    return true;
  };

  const stripRoot = (rawName: string): string => {
    if (rootPrefix === undefined) {
      return rawName;
    }

    if (!rawName.startsWith(rootPrefix)) {
      throw refuse("Entry is outside the declared root.");
    }

    const stripped = rawName.slice(rootPrefix.length);
    const problem = nameProblem(stripped);

    if (problem !== undefined) {
      throw refuse("Unsafe name under the declared root.");
    }

    return stripped;
  };

  const startEntry = () => {
    if (header.every((byte) => byte === 0)) {
      zeros += 1;

      if (zeros === 2) {
        phase = "end";
      }

      return;
    }

    if (zeros > 0) {
      throw refuse("a zero block sits between entries (truncated or spliced)");
    }

    if (!checksumHolds(header)) {
      throw refuse("an entry header fails its checksum");
    }

    const magic = ascii.decode(header.subarray(257, 265));
    const posix = magic === "ustar\u000000";

    if (!posix && magic !== "ustar  \u0000") {
      throw refuse("an entry header is neither ustar nor GNU");
    }

    const prefix = posix ? text(header, 345, 155) : "";

    const rawName = prefix === "" ? text(header, 0, 100) : `${prefix}/${text(header, 0, 100)}`;

    const problem = nameProblem(rawName);

    if (problem !== undefined) {
      throw refuse(`entry ${JSON.stringify(rawName)} ${problem}`);
    }

    if (acceptRoot(rawName)) {
      return;
    }

    name = stripRoot(rawName);
    const type = String.fromCodePoint(header[156] ?? 0);

    if (type !== "0" && type !== "\0") {
      const kind = KINDS.get(type) ?? `of unknown type ${JSON.stringify(type)}`;
      throw refuse(`entry "${rawName}" is ${kind}; only regular files are accepted`);
    }

    if (seen.has(name)) {
      throw refuse(`entry "${rawName}" appears twice`);
    }

    seen.add(name);
    names.push(name);
    remaining = octal(header, 124, 12, `entry "${rawName}"'s size`);
    padding = (BLOCK - (remaining % BLOCK)) % BLOCK;
    parts = wanted.has(name) ? [] : undefined;
    phase = "data";

    if (remaining === 0) {
      endEntry();
    }
  };

  const push = (chunk: Uint8Array): void => {
    let at = 0;

    while (at < chunk.length) {
      if (phase === "end") {
        if (chunk.subarray(at).some((byte) => byte !== 0)) {
          throw refuse("data follows the end-of-archive marker");
        }

        return;
      }

      if (phase === "header") {
        const take = Math.min(BLOCK - filled, chunk.length - at);
        header.set(chunk.subarray(at, at + take), filled);
        filled += take;
        at += take;

        if (filled === BLOCK) {
          filled = 0;
          startEntry();
        }
      } else if (phase === "data") {
        const take = Math.min(remaining, chunk.length - at);

        parts?.push(chunk.slice(at, at + take));
        remaining -= take;
        at += take;

        if (remaining === 0) {
          endEntry();
        }
      } else {
        const take = Math.min(padding, chunk.length - at);
        padding -= take;
        at += take;

        if (padding === 0) {
          phase = "header";
        }
      }
    }
  };

  const finish = (): TarContents => {
    if (phase !== "end") {
      throw refuse("the archive stops before its end-of-archive marker");
    }

    if (rootPrefix !== undefined && !rootSeen) {
      throw refuse(`the declared root "${rootPrefix}" never appears in the archive`);
    }

    return { members, names };
  };

  return { finish, push };
};
