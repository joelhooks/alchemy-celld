import { NodePath } from "@effect/platform-node";
import { offlineLayer } from "../src/offline.ts";
import * as Test from "alchemy/Test/Vitest";
import { Effect, Layer, Schema } from "effect";
import { expect } from "vitest";

import { Celld, ObjectStore, renderMaintenanceScript } from "../src/index.ts";
import { ReleaseSource } from "../src/release.ts";
import { checkedStack } from "./checked-stack.ts";
import { Rendered, renderProviders, renderedSurface } from "./instance-render.ts";
import { mischief } from "./instance-stack.ts";

const PlanSurface = Schema.Record(
  Schema.String,
  Schema.Struct({
    props: Schema.optionalKey(
      Schema.Struct({
        endpoint: Schema.optionalKey(Schema.String),
        name: Schema.optionalKey(Schema.String),
        path: Schema.optionalKey(Schema.String),
        sections: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              lines: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
              name: Schema.String,
            }),
          ),
        ),
      }),
    ),
  }),
);

const host = {
  dataRoot: "/srv/example/mailbox",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

const { test } = Test.make({
  providers: Layer.merge(ObjectStore.providers(), Celld.providers()).pipe(
    Layer.provide(offlineLayer),
    Layer.provide(NodePath.layer),
    Layer.provide(
      Layer.succeed(ReleaseSource, {
        get: () => Effect.die("Offline plan must not download"),
      }),
    ),
  ),
  stage: "instance-tests",
});

const mailbox = Effect.gen(function* mailbox() {
  const props = { instance: "celld", portBase: 31_000, restartGate: false };
  const slice = yield* ObjectStore.Slice({ home: host.home, instance: props.instance });

  const bucket = yield* ObjectStore.Bucket("store", {
    ...props,
    host,
    name: "example-cells",
    slice: slice.sha256,
  });

  return yield* Celld.Node("celld", { ...props, bucket, host });
});

test.provider("default plan preserves baseline with structural storage alarms", (scratch) =>
  Effect.gen(function* baseline() {
    const plan = yield* checkedStack(scratch).plan(mailbox);
    expect(
      JSON.parse(
        JSON.stringify(plan.resources).replaceAll(
          /"instanceId":"[a-f0-9]+"/gu,
          '"instanceId":"scratch"',
        ),
      ),
    ).toMatchSnapshot();
  }),
);

const { test: renderTest } = Test.make({
  providers: renderProviders.pipe(Layer.provide(NodePath.layer)),
  stage: "instance-render-tests",
});

renderTest.provider(
  "default rendered bytes preserve baseline with structural storage alarms",
  (scratch) =>
    Effect.gen(function* baseline() {
      yield* checkedStack(scratch).deploy(mailbox);
      expect(renderedSurface(yield* Rendered)).toMatchSnapshot();
    }),
);

test.provider("mischief offline plan creates only its instance resources", (scratch) =>
  Effect.gen(function* offline() {
    const plan = yield* checkedStack(scratch).plan(mischief(host));

    const surface = yield* Schema.decodeEffect(Schema.fromJsonString(PlanSurface))(
      JSON.stringify(plan.resources),
    );

    const text = JSON.stringify(surface);

    for (const name of [
      "mischief-celld.service",
      "mischief-seaweedfs.service",
      "mischief.slice",
      "/home/example/.config/mischief",
      "/home/example/.local/share/mischief",
      "/srv/example/mischief",
      "http://127.0.0.1:32006",
    ]) {
      expect(text).toContain(name);
    }

    for (const name of [
      "celld-celld.service",
      "celld-seaweedfs.service",
      "celld.slice",
      "/home/example/.config/celld",
      "/home/example/.local/share/celld",
      "http://127.0.0.1:31006",
    ]) {
      expect(text).not.toContain(name);
    }

    expect(Object.values(plan.resources).every(({ action }) => action === "create")).toBe(true);
  }),
);

renderTest.provider(
  "mischief resolved files, credentials, retention and restart gates stay in its instance",
  (scratch) =>
    Effect.gen(function* rendered() {
      yield* checkedStack(scratch).deploy(mischief(host));
      const surface = renderedSurface(yield* Rendered);
      expect(surface.directories.every((path) => path.includes("mischief"))).toBe(true);
      expect(Object.keys(surface.files).every((path) => path.includes("mischief"))).toBe(true);

      const store = surface.files[`${host.home}/.config/systemd/user/mischief-seaweedfs.service`];

      const node = surface.files[`${host.home}/.config/systemd/user/mischief-celld.service`];

      expect(store).toContain("-volume.max=32");
      expect(store).toContain("Description=Mischief object storage");
      expect(node).toContain("Description=Mischief cell node");

      for (const text of [node, store]) {
        expect(text).toContain("MemoryMax=1.5G");
        expect(text).toContain("CPUQuota=100%");
        expect(text).toContain("OOMPolicy=continue");
      }

      expect(surface.files[`${host.home}/.config/systemd/user/mischief.slice`]).not.toContain(
        "OOMPolicy",
      );
      expect(node).toContain("--listen 203.0.113.10:32000 --internal-listen 127.0.0.1:32001");
      expect(node).toContain('before-node "mischief" 32000 "/srv/example/mischief"');
      expect(store).toContain('store "mischief" 32000 "/srv/example/mischief"');
      expect(surface.files[`${host.home}/.config/mischief/celld.env`]).toContain(
        'S3_ENDPOINT="http://127.0.0.1:32006"',
      );

      const maintenance = renderMaintenanceScript(host, {
        dataRoot: "/srv/example/mischief",
        instance: "mischief",
        portBase: 32_000,
        restartGate: true,
      });

      expect(surface.files[maintenance.path]).toBe(maintenance.text);
      expect(maintenance.text).not.toContain("http://127.0.0.1:32004");
      expect(maintenance.text).not.toContain("http://127.0.0.1:32002");
      expect(node).toContain(
        'diagnose --instance "mischief" --master http://127.0.0.1:32004 --filer http://127.0.0.1:32002 --root /topics/.system/log',
      );

      const retention =
        surface.files[`${host.home}/.config/systemd/user/mischief-storage-retention.service`];

      expect(retention).toContain(
        'retain --instance "mischief" --master http://127.0.0.1:32004 --filer http://127.0.0.1:32002 --root /topics/.system/log',
      );
      expect(retention).toContain("Restart=no");
      expect(retention).not.toContain("RestartSec=60");
      expect(retention).not.toContain("StartLimitIntervalSec=0");

      const identity = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            identities: Schema.Array(Schema.Struct({ name: Schema.String })),
          }),
        ),
      )(surface.files[`${host.home}/.config/mischief/s3.json`] ?? "");

      expect(identity.identities.map(({ name }) => name)).toEqual(["mischief"]);
      expect(surface.files[`${host.home}/.config/systemd/user/mischief.slice`]).toContain(
        "MemoryHigh=2.5G",
      );
    }),
);
