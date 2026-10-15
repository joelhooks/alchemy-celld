import * as Test from "alchemy/Test/Vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { stageDeploymentFiles, InstanceNameSchema, instanceLayout } from "./fixture.ts";
import { checkedStack } from "./checked-stack.ts";
import { Rendered, renderedSurface, renderProviders } from "./instance-render.ts";

const host = {
  dataRoot: "/srv/example/mailbox",
  home: "/home/example",
  ssh: "example",
  tailnetIPv4: "203.0.113.10",
};

const prepared = {
  bundle: "export default {};",
  configuration: '{"name":"invented"}',
};

const { test } = Test.make({
  providers: renderProviders,
  stage: "deployment-stage-tests",
});

test.provider("default staging paths, ids and bytes preserve main 920884e", (scratch) =>
  Effect.gen(function* compatibility() {
    for (const mailboxOnly of [true, false]) {
      const graph = stageDeploymentFiles(host.home, prepared, mailboxOnly);
      const plan = yield* checkedStack(scratch).plan(graph);
      expect(
        JSON.parse(
          JSON.stringify(plan.resources).replaceAll(
            /"instanceId":"[a-f0-9]+"/gu,
            '"instanceId":"scratch"',
          ),
        ),
      ).toMatchSnapshot();
      yield* checkedStack(scratch).deploy(graph);
      expect(renderedSurface(yield* Rendered)).toMatchSnapshot();
    }
  }),
);

test.provider(
  "actual staging declarations have disjoint directories and resource ids for distinct instances",
  (scratch) =>
    Effect.gen(function* stagingProperty() {
      const cases = Arbitrary.schema(
        Schema.Struct({
          names: Schema.Tuple([
            Schema.Union([InstanceNameSchema, Schema.Literal("mailbox")]),
            InstanceNameSchema,
          ]),
          withDefault: Schema.Boolean,
        }),
      ).pipe(Arbitrary.filter(({ names: [a, b] }) => a !== b));

      const result = yield* Arbitrary.checkEffect(
        cases,
        ({ names: [a, b], withDefault }) =>
          Effect.gen(function* disjoint() {
            const first = instanceLayout(host, {
              dataRoot: `/srv/example/named/${a}`,
              instance: a,
              portBase: 30_000,
            });

            const second = withDefault
              ? instanceLayout(host, {})
              : instanceLayout(host, {
                  dataRoot: `/srv/example/named/${b}`,
                  instance: b,
                  portBase: 50_000,
                });

            const stack = checkedStack(scratch);
            yield* stack.destroy();
            const rendered = yield* Rendered;
            rendered.directories.clear();
            rendered.files.clear();

            const graph = Effect.gen(function* graph() {
              yield* stageDeploymentFiles(host.home, prepared, false, first);

              return yield* stageDeploymentFiles(host.home, prepared, true, second);
            });

            const plan = yield* stack.plan(graph);
            yield* stack.deploy(graph);
            const paths = [...rendered.directories, ...rendered.files.keys()];

            return (
              Object.keys(plan.resources).length === 6 &&
              paths.length === 6 &&
              new Set(paths).size === 6 &&
              paths.filter((path) => path.startsWith(`${first.configuration}/`)).length === 3 &&
              paths.filter((path) => path.startsWith(`${second.configuration}/`)).length === 3
            );
          }),
        { runs: 40 },
      );

      expect(result._tag, Arbitrary.formatCheckFailure(result)).toBe("Passed");
    }),
);
