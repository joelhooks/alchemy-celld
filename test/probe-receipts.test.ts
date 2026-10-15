import { it } from "@effect/vitest";
import type { ResourceStatusChanged } from "alchemy/Report";
import { Arbitrary, Data, Effect, Schema } from "effect";
import { expect } from "vitest";

import {
  InstanceNameSchema,
  instanceLayout,
  storageRetentionTimer,
  storageRetentionUnit,
} from "./fixture.ts";
import { withDestroyReceipt } from "../src/probe-receipts.ts";
import { renderUnit } from "../src/systemd.ts";

const statusEvent = Data.taggedEnum<ResourceStatusChanged>()["apply.resource.status"];

it.effect.prop(
  "destroy receipt prints one terminal result for every resource even when a dependent fails",
  { failure: Arbitrary.schema(Schema.Boolean) },
  ({ failure }) =>
    Effect.gen(function* receipt() {
      const lines: string[] = [];

      const resources = [
        "worker",
        "store/server",
        "slice",
        "store/storage-retention",
        "store/storage-retention-timer",
      ];

      yield* withDestroyReceipt(
        resources,
        (session) =>
          Effect.gen(function* apply() {
            for (const name of resources) {
              let status: ResourceStatusChanged["status"] = "deleted";

              if (failure && name === "worker") {
                status = "fail";
              } else if (failure && ["store/server", "slice"].includes(name)) {
                status = "skipped";
              }

              yield* session.emit(
                statusEvent({
                  fqn: name,
                  id: name,
                  status,
                  type: "Example.Resource",
                }),
              );
            }

            if (failure) {
              return yield* Effect.fail("modeled delete failure");
            }

            return yield* Effect.void;
          }),
        (line) =>
          Effect.sync(() => {
            lines.push(line);
          }),
      ).pipe(Effect.result);

      const expected = failure
        ? [
            "skipped slice",
            "skipped store/server",
            "deleted store/storage-retention",
            "deleted store/storage-retention-timer",
            "failed worker",
          ]
        : resources.toSorted().map((name) => `deleted ${name}`);

      expect(lines).toEqual(expected);
    }),
);

it.effect.prop(
  "retention descriptions identify named instances while default rendered bytes remain unchanged",
  {
    name: Arbitrary.schema(InstanceNameSchema.check(Schema.makeFilter((name) => name !== "celld"))),
  },
  ({ name }) =>
    Effect.sync(() => {
      const host = {
        dataRoot: "/srv/example/mailbox",
        home: "/home/example",
        ssh: "example",
        tailnetIPv4: "203.0.113.10",
      };

      const legacy = instanceLayout(host, {});

      const named = instanceLayout(host, {
        dataRoot: `/srv/example/${name}`,
        instance: name,
        portBase: 28_010,
      });

      const path = "/opt/example/maintenance.py";
      const unit = storageRetentionUnit(host.home, path, []);

      const timer = storageRetentionTimer(host.home, []);

      expect(renderUnit(storageRetentionUnit(host.home, path, [], legacy))).toBe(renderUnit(unit));
      expect(renderUnit(storageRetentionTimer(host.home, [], legacy))).toBe(renderUnit(timer));
      expect(renderUnit(unit)).toContain(
        "Description=celld filer metadata log retention and storage alarm",
      );
      expect(renderUnit(timer)).toContain("Description=celld hourly filer log retention");
      expect(renderUnit(storageRetentionUnit(host.home, path, [], named))).toContain(
        `Description=${name} filer metadata log retention and storage alarm`,
      );
      expect(renderUnit(storageRetentionTimer(host.home, [], named))).toContain(
        `Description=${name} hourly filer log retention`,
      );
    }),
);
