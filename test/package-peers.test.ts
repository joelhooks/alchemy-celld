// @effect-diagnostics nodeBuiltinImport:off -- This fixture packs and installs the real package offline to check the host/provider peer boundary.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { it } from "@effect/vitest";
import { Console, Effect } from "effect";
import { afterAll, beforeAll, expect } from "vitest";

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
  readonly devDependencies: Record<string, string>;
}

const root = resolve(import.meta.dirname, "..");
const manifest: Manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const peers = { alchemy: ">=2.0.0-beta.81 <2.0.0-beta.84", effect: "^4.0.0" };
let temporary: string;
let tarball: string;

const pnpm = (cwd: string, args: readonly string[], expectedStatus = 0) => {
  const result = spawnSync("pnpm", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true", ALCHEMY_TELEMETRY_DISABLED: "1" },
    timeout: 90_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(expectedStatus);
  return result.stdout + result.stderr;
};

beforeAll(() => {
  temporary = mkdtempSync(join(tmpdir(), "alchemy-celld-peers-"));
  tarball = join(temporary, `${manifest.name}-${manifest.version}.tgz`);
  pnpm(root, ["pack", "--out", tarball]);
});

afterAll(() => {
  if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
});

it("publishes required shared-runtime peers, exact development pins and only internal dependencies", () => {
  expect(manifest.version).toBe("0.1.3");
  expect(manifest.peerDependencies).toEqual(peers);
  expect(manifest.peerDependenciesMeta?.effect?.optional).not.toBe(true);
  expect(manifest.peerDependenciesMeta?.alchemy?.optional).not.toBe(true);
  expect(manifest.dependencies).toEqual({ "@effect/platform-node": "4.0.0", esbuild: "0.28.2" });
  expect(manifest.devDependencies.effect).toBe("4.0.1");
  expect(manifest.devDependencies.alchemy).toBe("2.0.0-beta.81");
});

const consumer = (name: string, suppliedPeers: Record<string, string> = {}) => {
  const directory = join(temporary, name);
  mkdirSync(directory);
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "alchemy-celld": `file:${tarball}`, ...suppliedPeers },
    }),
  );
  // These are consumer policies, not settings that a library manifest can impose.
  writeFileSync(
    join(directory, "pnpm-workspace.yaml"),
    "packages: ['.']\nautoInstallPeers: false\nstrictPeerDependencies: false\nnodeLinker: isolated\nminimumReleaseAge: 0\n# Pin only internal transitive packages to this fixture's cached versions.\noverrides:\n  '@effect/platform-node-shared': 4.0.1\n  undici: 8.11.2\n",
  );
  return directory;
};

it("an offline bare tarball consumer warns about both missing peers without installing private copies", () => {
  const directory = consumer("bare");
  const output = pnpm(directory, [
    "install",
    "--offline",
    "--ignore-scripts",
    "--reporter=append-only",
  ]);
  expect(output).toContain("Issues with peer dependencies");
  const diagnostics = pnpm(directory, ["peers", "check"], 1);
  expect(diagnostics).toMatch(/missing peer alchemy\b/u);
  expect(diagnostics).toMatch(/missing peer effect\b/u);
  const host = createRequire(join(directory, "package.json"));
  const provider = createRequire(host.resolve("alchemy-celld"));
  for (const dependency of ["effect", "alchemy"]) {
    expect(() => host.resolve(dependency)).toThrow(/Cannot find module/u);
    expect(() => provider.resolve(dependency)).toThrow(/Cannot find module/u);
  }
  const installed: Manifest = JSON.parse(
    readFileSync(join(directory, "node_modules/alchemy-celld/package.json"), "utf8"),
  );
  expect(installed.peerDependencies).toEqual(peers);
  expect(installed.dependencies.effect).toBeUndefined();
  expect(installed.dependencies.alchemy).toBeUndefined();
});

it.live(
  "a tarball consumer supplying the supported peers shares their physical modules with the provider",
  () =>
    Effect.gen(function* sharedPeers() {
      const directory = consumer("host", { alchemy: "2.0.0-beta.81", effect: "4.0.1" });
      // Reuse the pinned transitive graph for this offline fixture, not the bare-peer plant.
      cpSync(join(root, "pnpm-lock.yaml"), join(directory, "pnpm-lock.yaml"));
      cpSync(join(root, "pnpm-workspace.yaml"), join(directory, "pnpm-workspace.yaml"));
      pnpm(directory, [
        "install",
        "--offline",
        "--no-frozen-lockfile",
        "--ignore-scripts",
        "--config.auto-install-peers=false",
        "--config.strict-peer-dependencies=false",
        "--reporter=append-only",
      ]);
      const host = createRequire(join(directory, "package.json"));
      const provider = createRequire(host.resolve("alchemy-celld"));
      const resolutions = ["effect", "alchemy"].map((dependency) => ({
        dependency,
        host: realpathSync(host.resolve(dependency)),
        provider: realpathSync(provider.resolve(dependency)),
      }));
      for (const entry of resolutions) expect(entry.provider).toBe(entry.host);
      yield* Console.log("PEER_IDENTITY_OK", JSON.stringify(resolutions));
      const receipt = process.env.CELLD_PEER_RECEIPT;
      if (receipt !== undefined)
        writeFileSync(
          receipt,
          JSON.stringify(
            {
              version: manifest.version,
              peers,
              pnpm: pnpm(directory, ["--version"]).trim(),
              baseline: { effect: "4.0.1", alchemy: "2.0.0-beta.81" },
              tarballSha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"),
              resolutions,
            },
            null,
            2,
          ),
        );
    }),
);
