import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vitest";

import { probeCommand, serviceCapGuard } from "./fixture.ts";
import { shellQuote } from "../src/ssh.ts";

it.prop(
  "default scope command remains byte-identical and service carries every cap",
  {
    args: Arbitrary.schema(Schema.Array(Schema.String)),
    name: Arbitrary.schema(Schema.String),
  },
  ({ args, name }) => {
    expect(probeCommand(name, args)).toEqual([
      "systemd-run",
      "--user",
      "--scope",
      "--quiet",
      `--unit=${name}`,
      "--slice=celld.slice",
      "--property=MemoryMax=64M",
      "--property=MemorySwapMax=0",
      "--property=CPUQuota=10%",
      "--property=TasksMax=64",
      "--",
      "nice",
      "-n",
      "10",
      ...args,
    ]);
    const service = probeCommand(name, args, "service");
    expect(service.slice(0, 12)).toEqual([
      "systemd-run",
      "--user",
      "--wait",
      "--pipe",
      "--collect",
      "--quiet",
      `--unit=${name}.service`,
      "--slice=celld.slice",
      "--property=MemoryMax=64M",
      "--property=MemorySwapMax=0",
      "--property=CPUQuota=10%",
      "--property=TasksMax=64",
    ]);
    expect(service.slice(12)).toEqual([
      "--",
      "sh",
      "-c",
      serviceCapGuard,
      "probe",
      `${name}.service`,
      ...args,
    ]);
  },
);

it.live.prop(
  "service refuses mismatched applied properties before executing payload",
  {
    changed: Arbitrary.schema(
      Schema.Literals(["MemoryMax", "MemorySwapMax", "CPUQuotaPerSecUSec", "TasksMax"]),
    ),
    readFails: Arbitrary.schema(Schema.Boolean),
    valid: Arbitrary.schema(Schema.Boolean),
  },
  ({ changed, valid, readFails }) =>
    Effect.gen(function* checkGuard() {
      const properties = [
        ["MemoryMax", "67108864"],
        ["MemorySwapMax", "0"],
        ["CPUQuotaPerSecUSec", "100ms"],
        ["TasksMax", "64"],
      ]
        .map(([key, value]) => `${key}=${!valid && key === changed ? "wrong" : value}`)
        .join("\n");

      const script = `systemctl() { printf '%s\\n' ${shellQuote(properties)}; return ${readFails ? 7 : 0}; };\n${serviceCapGuard}`;

      const process = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
        ChildProcess.make("sh", [
          "-c",
          script,
          "probe",
          "example.service",
          "printf",
          "PAYLOAD_EXECUTED",
        ]),
      );

      const result = yield* Effect.all(
        {
          code: process.exitCode,
          stderr: Stream.runDrain(process.stderr),
          stdout: Stream.runCollect(process.stdout),
        },
        { concurrency: "unbounded" },
      );

      const appliedCode = valid ? 0 : 1;

      expect(Number(result.code)).toBe(readFails ? 7 : appliedCode);
      expect(Buffer.concat(result.stdout).toString()).toBe(
        valid && !readFails ? "PAYLOAD_EXECUTED" : "",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
