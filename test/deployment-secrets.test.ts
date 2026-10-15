import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, FileSystem, Schema } from "effect";
import { expect } from "vitest";

import { bindingConfigurationScript, bindingConfigurationScriptFor } from "../src/deployment.ts";
import { localExec } from "../src/local-exec.ts";

const Names = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9]{0,15}_CREDENTIAL$/u));

const PrivateConfiguration = Schema.Struct({
  vars: Schema.Record(Schema.String, Schema.String),
});

it.live.prop(
  "a deployment admits only its declared secret names without changing public vars or returning secrets",
  { name: Arbitrary.schema(Names) },
  ({ name }) =>
    Effect.gen(function* privateBindings() {
      const fs = yield* FileSystem.FileSystem;

      const temporary = yield* fs.makeTempDirectoryScoped({
        prefix: "deployment-bindings-",
      });

      const directory = yield* fs.realPath(temporary);
      const shell = yield* localExec;
      const binding = `${directory}/bindings.json`;
      const publicPath = `${directory}/wrangler.public.json`;

      const publicConfiguration = JSON.stringify({
        vars: { PUBLIC_VALUE: "invented" },
      });

      yield* fs.writeFileString(publicPath, publicConfiguration);
      yield* fs.writeFileString(binding, JSON.stringify({ [name]: "invented-private-value" }));
      yield* fs.chmod(binding, 0o600);
      const script = bindingConfigurationScriptFor([name]);

      const run = () => shell.exec(["python3", "-c", script, directory, binding]);

      const created = yield* run();
      expect(created.code).toBe(0);
      expect(created.stdout).toBe("");
      expect(yield* fs.readFileString(publicPath)).toBe(publicConfiguration);

      const privateConfiguration = yield* Schema.decodeEffect(
        Schema.fromJsonString(PrivateConfiguration),
      )(yield* fs.readFileString(`${directory}/wrangler.json`));

      expect(privateConfiguration.vars[name]).toBe("invented-private-value");
      expect((yield* fs.stat(`${directory}/wrangler.json`)).mode % 0o1000).toBe(0o600);
      expect(
        (yield* shell.exec(["python3", "-c", bindingConfigurationScript, directory, binding])).code,
      ).toBe(1);
      yield* fs.writeFileString(binding, JSON.stringify({ [`X${name}`]: "invented" }));
      expect((yield* run()).code).toBe(1);
      yield* fs.writeFileString(binding, JSON.stringify({ [name]: "invented-private-value" }));
      yield* fs.writeFileString(publicPath, JSON.stringify({ vars: { [name]: "collision" } }));
      expect((yield* run()).code).toBe(1);
      yield* fs.writeFileString(publicPath, publicConfiguration);
      yield* fs.chmod(binding, 0o644);
      expect((yield* run()).code).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 12 } },
);

it.prop(
  "omitted or explicitly empty secret allowlists keep the fail-closed default script",
  { reverse: Arbitrary.schema(Schema.Boolean) },
  ({ reverse }) => {
    const names: readonly string[] = [];

    expect(bindingConfigurationScriptFor()).toContain("allowed = set()");
    expect(bindingConfigurationScriptFor()).toBe(bindingConfigurationScript);
    expect(bindingConfigurationScriptFor(reverse ? names.toReversed() : names)).toBe(
      bindingConfigurationScript,
    );
  },
);
