import { NodeServices } from "@effect/platform-node";
import { Stack, localState } from "alchemy";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import * as Apply from "alchemy/Apply";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { deploy } from "alchemy/Deploy";
import { layerNonInteractive } from "alchemy/Interaction";
import * as Plan from "alchemy/Plan";
import { evalStack } from "alchemy/Stack";
import { Config, Console, Effect, FileSystem, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { Celld } from "./celld.ts";
import { refuse } from "./files.ts";
import { HostShell, must } from "./host-shell.ts";
import { Host, layer as inventoryLayer } from "./host.ts";
import { mailboxPidScript } from "./instance-probe-scripts.ts";
import {
  instanceProbeProgram,
  probeIdentity,
  probeInstance,
  probePortBase,
  probeUnitLimits,
} from "./instance-probe-stack.ts";
import { startupLayer } from "./instance-startup-contract.ts";
import { renderUnits } from "./instance-units.ts";
import { validateInstance } from "./instance.ts";
import { ObjectStore } from "./object-store.ts";
import { verifyInstanceGone, withDestroyReceipt } from "./probe-receipts.ts";
import { sourceLayer } from "./release.ts";
import { layer as sshLayer } from "./ssh.ts";

const Pids = Schema.Struct({
  "celld-celld.service": Schema.Int,
  "celld-seaweedfs.service": Schema.Int,
});

const Baseline = Schema.Struct({
  dataRoot: Schema.String,
  home: Schema.String,
  node: Schema.String,
  pids: Pids,
});

const baselineFile = "instance-probe-baseline.json";

export const runInstanceProbe = (
  action:
    | "plan"
    | "deploy"
    | "health"
    | "destroy-plan"
    | "destroy"
    | "verify-gone"
    | "render-units",
) =>
  Effect.gen(function* run() {
    const alias = yield* Config.String("FLEET_LIVE_NODE");
    const hosts = yield* Host;
    const host = yield* hosts.node(alias);
    const dataRoot = yield* Config.String("FLEET_PROBE_DATA_ROOT");

    const layout = yield* validateInstance(host, {
      dataRoot,
      instance: probeInstance,
      portBase: probePortBase,
      restartGate: true,
    });

    if (action === "render-units") {
      return yield* Console.log(
        JSON.stringify(
          renderUnits(
            { ...host, tailnetIPv4: "127.0.0.1" },
            {
              dataRoot,
              instance: probeInstance,
              portBase: probePortBase,
              restartGate: true,
              maintenanceGuard: { refuses: [] },
            },
            probeUnitLimits,
          ),
          null,
          2,
        ),
      );
    }

    const connection = sshLayer(host, {
      dataRoot,
      instance: probeInstance,
      portBase: probePortBase,
      restartGate: true,
    });

    const http = Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* remoteHttp() {
        const shell = yield* HostShell;

        return HttpClient.make((request) =>
          must(shell, [
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "10",
            request.url,
          ]).pipe(
            Effect.map((body) => HttpClientResponse.fromWeb(request, new Response(body))),
            Effect.mapError(
              (cause) =>
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    cause,
                    request,
                  }),
                }),
            ),
          ),
        );
      }),
    );

    const startup = startupLayer("127.0.0.1", layout, "scope");

    const providers = Layer.mergeAll(
      ObjectStore.providers(),
      Celld.providers(),
      Celld.deploymentProvider(),
    ).pipe(
      Layer.provide(startup),
      Layer.provide(http),
      Layer.provideMerge(connection),
      Layer.provide(sourceLayer.pipe(Layer.provide(FetchHttpClient.layer))),
    );

    const stack = Stack(
      "celld-instance-mischiefrb-rollback",
      { providers: providers.pipe(Layer.orDie), state: localState() },
      instanceProbeProgram(host, dataRoot).pipe(Effect.orDie),
    );

    const fs = yield* FileSystem.FileSystem;

    const readBaseline = Effect.gen(function* readBaseline() {
      const saved = yield* Schema.decodeEffect(Schema.fromJsonString(Baseline))(
        yield* fs.readFileString(baselineFile),
      );

      if (saved.home !== host.home || saved.dataRoot !== dataRoot || saved.node !== alias) {
        return yield* refuse("Probe baseline belongs to another host or data root.");
      }

      return saved;
    });

    const probe = Effect.gen(function* probe() {
      const shell = yield* HostShell;

      if (action === "deploy") {
        if (!(yield* Config.Boolean("FLEET_START_APPROVED").pipe(Config.withDefault(false)))) {
          return yield* refuse("Probe deploy needs owner approval.");
        }

        const pids = yield* Schema.decodeEffect(Schema.fromJsonString(Pids))(
          yield* must(shell, ["python3", "-c", mailboxPidScript]),
        );

        if (yield* fs.exists(baselineFile)) {
          const saved = yield* readBaseline;

          if (JSON.stringify(saved.pids) !== JSON.stringify(pids)) {
            return yield* refuse("Mailbox PIDs changed since the original probe baseline.");
          }
        } else {
          for (const path of [layout.configuration, layout.binaryRoot, layout.dataRoot]) {
            if ((yield* shell.stat(path)) !== undefined) {
              return yield* refuse("Probe directories must be absent before first deploy.");
            }
          }

          yield* fs.writeFileString(
            baselineFile,
            JSON.stringify({ dataRoot, home: host.home, node: alias, pids }),
            { flag: "wx", mode: 0o600 },
          );
        }

        yield* deploy({ stack, stage: "rollback-proof" });

        return yield* Effect.log("INSTANCE_DEPLOYED");
      }

      if (action === "verify-gone") {
        const saved = yield* readBaseline;

        return yield* verifyInstanceGone(shell, host.home, dataRoot, saved.pids);
      }

      if (action === "health") {
        yield* must(shell, [
          "curl",
          "--fail",
          "--silent",
          "--show-error",
          "--max-time",
          "10",
          "http://127.0.0.1:28010/.well-known/celld/health",
        ]);

        const identity = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ commit: Schema.String, version: Schema.String })),
        )(
          yield* must(shell, [
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "10",
            "http://127.0.0.1:28010/.well-known/celld/version",
          ]),
        );

        if (
          identity.commit !== probeIdentity.commit ||
          identity.version !== probeIdentity.version
        ) {
          return yield* refuse("Probe worker identity mismatch.");
        }

        yield* must(shell, [
          "python3",
          "-c",
          "import subprocess; rows=subprocess.run(['ss','-H','-ltn'],check=True,capture_output=True,text=True).stdout.splitlines(); found={}; [(found.setdefault(int(row.split()[3].rsplit(':',1)[1]),[]).append(row.split()[3].rsplit(':',1)[0])) for row in rows]; assert all(found.get(port)==['127.0.0.1'] for port in range(28010,28020))",
        ]);

        return yield* Effect.log("INSTANCE_HEALTHY_LOOPBACK_ONLY");
      }

      return yield* Effect.void;
    }).pipe(Effect.provide(connection));

    if (action === "plan" || action === "destroy-plan") {
      const summary = yield* evalStack(
        stack,
        (compiled) =>
          action === "plan"
            ? Plan.make(compiled).pipe(Effect.map(Plan.describePlan))
            : Plan.destroy(compiled).pipe(Effect.map(Plan.describePlan)),
        { stage: "rollback-proof" },
      );

      yield* Effect.log(JSON.stringify(summary));

      return yield* Effect.void;
    }

    if (action === "destroy") {
      if (!(yield* Config.Boolean("FLEET_DESTROY_APPROVED").pipe(Config.withDefault(false)))) {
        return yield* refuse("Probe destroy needs owner approval after destroy-plan.");
      }

      yield* readBaseline;
      yield* evalStack(
        stack,
        (compiled) =>
          Plan.destroy(compiled).pipe(
            Effect.flatMap((plan) =>
              withDestroyReceipt(Object.keys(plan.deletions), (session) =>
                Apply.apply(plan, { session }),
              ),
            ),
          ),
        { stage: "rollback-proof" },
      );

      return yield* Effect.log("INSTANCE_DESTROYED_RUN_VERIFY_GONE");
    }

    return yield* probe;
  }).pipe(
    provideFreshArtifactStore,
    Effect.provide(
      Layer.mergeAll(inventoryLayer, AlchemyContextLive, localState(), layerNonInteractive()).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
