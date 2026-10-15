import { it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { expect } from "vitest";

import { wranglerConfiguration } from "../src/deployment-config.ts";

const declaration = {
  compatibility_date: "2026-10-04",
  compatibility_flags: ["nodejs_compat"],
  durable_objects: {
    bindings: [
      { class_name: "Mailbox", name: "MAILBOX" },
      { class_name: "AuthTokens", name: "AUTH_TOKENS" },
    ],
  },
  migrations: [{ new_sqlite_classes: ["Mailbox", "AuthTokens"], tag: "v1" }],
  name: "celld-mailbox",
};

const build = {
  commit: "1234567",
  main: "worker.mjs",
  vars: {
    DID_DOCUMENTS: "[]",
    SERVICE_DID: "did:web:service.example",
  },
  version: "0.1.0-proof",
};

it.effect("refuses unknown top-level and nested keys, unsupported classes and collisions", () =>
  Effect.gen(function* refusedConfiguration() {
    for (const input of [
      { ...declaration, routes: [] },
      { ...declaration, define: {} },
      { ...declaration, kv_namespaces: [] },
      {
        ...declaration,
        durable_objects: {
          bindings: [{ class_name: "Mailbox", name: "MAILBOX", script_name: "other" }],
        },
      },
      {
        ...declaration,
        migrations: [{ new_classes: ["Mailbox"], tag: "v1" }],
      },
      { ...declaration, migrations: [] },
      { ...declaration, name: "Bad Name" },
    ]) {
      expect(Result.isFailure(yield* wranglerConfiguration(input, build).pipe(Effect.result))).toBe(
        true,
      );
    }

    expect(
      Result.isFailure(
        yield* wranglerConfiguration(declaration, {
          ...build,
          vars: { MAILBOX: "collision" },
        }).pipe(Effect.result),
      ),
    ).toBe(true);
  }),
);
