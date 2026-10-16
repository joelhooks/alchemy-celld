// @effect-diagnostics nodeBuiltinImport:off -- This test drives a real Node consumer and creates isolated workspace links.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const fixture = join(root, "test/consumer/surface.ts");

it("examples cannot bypass the package surface with relative source imports", () => {
  for (const name of readdirSync(join(root, "examples"))) {
    if (!name.endsWith(".ts")) continue;
    expect(readFileSync(join(root, "examples", name), "utf8")).not.toMatch(/\.\.\/src\//u);
  }
});

const consumer = (directory: string, target: string) => {
  mkdirSync(join(directory, "node_modules"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  cpSync(fixture, join(directory, "surface.ts"));
  symlinkSync(target, join(directory, "node_modules/alchemy-celld"), "dir");
  symlinkSync(join(root, "node_modules/effect"), join(directory, "node_modules/effect"), "dir");
  const options = {
    cwd: directory,
    encoding: "utf8" as const,
    env: { ...process.env, ALCHEMY_TELEMETRY_DISABLED: "1" },
    timeout: 30_000,
  };
  // Check erased imports too, without a tsconfig paths alias or a source-path import.
  const types = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/lib/tsc.js"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--target",
      "ES2023",
      "--allowImportingTsExtensions",
      "--types",
      "node",
      "--typeRoots",
      join(root, "node_modules/@types"),
      "surface.ts",
    ],
    options,
  );
  return { types, runtime: spawnSync(process.execPath, ["surface.ts"], options) };
};

it("an external workspace consumer imports and exercises all 57 public symbol occurrences", () => {
  const temporary = mkdtempSync(join(tmpdir(), "alchemy-celld-consumer-"));
  try {
    const { types, runtime } = consumer(join(temporary, "consumer"), root);
    expect(types.error).toBeUndefined();
    expect(types.status, types.stdout + types.stderr).toBe(0);
    expect(runtime.error).toBeUndefined();
    expect(runtime.status, runtime.stderr).toBe(0);
    expect(runtime.stdout).toContain("CONSUMER_SURFACE_OK 30 modules 57 symbols");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

it("the same consumer fails when validateInstance is withdrawn from a package snapshot", () => {
  const temporary = mkdtempSync(join(tmpdir(), "alchemy-celld-regression-"));
  try {
    // Mutate only a throwaway package. Never edit the working tree during a test.
    const snapshot = join(temporary, "package");
    mkdirSync(snapshot);
    cpSync(join(root, "src"), join(snapshot, "src"), { recursive: true });
    cpSync(join(root, "package.json"), join(snapshot, "package.json"));
    symlinkSync(join(root, "node_modules"), join(snapshot, "node_modules"), "dir");
    const index = join(snapshot, "src/index.ts");
    const before = readFileSync(index, "utf8");
    // Works regardless of how the named re-export is wrapped by the formatter.
    const after = before.replace(/\bvalidateInstance\s*,?\s*/u, "");
    expect(after).not.toBe(before);
    writeFileSync(index, after);
    const { types, runtime } = consumer(join(temporary, "consumer"), snapshot);
    expect(types.error).toBeUndefined();
    expect(types.status).not.toBe(0);
    expect(types.stdout).toMatch(/has no exported member 'validateInstance'/u);
    expect(runtime.error).toBeUndefined();
    expect(runtime.status).not.toBe(0);
    expect(runtime.stderr).toMatch(/does not provide an export named 'validateInstance'/u);
    expect(runtime.stdout).not.toContain("CONSUMER_SURFACE_OK");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
