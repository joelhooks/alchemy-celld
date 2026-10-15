import { Resource } from "alchemy";
import { AdoptPolicy, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Config, Effect, Option, Schema } from "effect";

import { absent } from "./absent.ts";
import { recovering } from "./adoption.ts";
import { refuse } from "./files.ts";
import { HostShell } from "./host-shell.ts";
import { runningProcessMatches } from "./process-readback.ts";
import {
  deleteUnit,
  needsUpdate,
  ownedUnit,
  readUnit,
  reconcileUnit,
  unitPath,
  validateUnit,
  withoutLegacyHelperInputs,
  UnitSchema,
} from "./systemd.ts";
import type { UnitAttributes, UnitProps } from "./systemd.ts";
import { UnitStartup } from "./unit-startup.ts";

export interface NodeProps extends UnitProps {
  readonly publicUrl: string;
  readonly internalUrl: string;
  readonly version: "v0.6.1";
}

export interface NodeAttributes extends UnitAttributes {
  readonly publicUrl: string;
  readonly internalUrl: string;
  readonly version: "v0.6.1";
}

export type CelldNodeResource = Resource<"Celld.Node", NodeProps, NodeAttributes>;

export const NodeResource = Resource<CelldNodeResource>("Celld.Node");

const urls = (props: NodeProps) => ({
  internalUrl: props.internalUrl,
  publicUrl: props.publicUrl,
  version: props.version,
});

export const NodeProvider = () =>
  Provider.effect(
    NodeResource,
    Effect.gen(function* provider() {
      const shell = yield* HostShell;
      const startup = yield* Effect.serviceOption(UnitStartup);

      return NodeResource.Provider.of({
        delete: ({ output }) => (output === undefined ? Effect.void : deleteUnit(shell, output)),
        diff: Effect.fn("Celld.Node.diff")(function* operation({ olds, news, output }) {
          if (Output.isExpr(news) || Effect.isEffect(news) || Config.isConfig(news)) {
            return absent;
          }

          if (Symbol.iterator in news) {
            return absent;
          }

          const operational = { ...news, prepared: [] };

          if (!isResolved<NodeProps>(operational)) {
            return absent;
          }

          yield* validateUnit(operational);

          const previous = withoutLegacyHelperInputs(olds, operational, output, "prepared" in news);

          if (output === undefined) {
            return { action: "update" };
          }

          if (unitPath(operational) !== output.path) {
            if ((yield* readUnit(shell, operational)) !== undefined) {
              return yield* refuse("Replacement node unit already exists.");
            }

            return { action: "replace", deleteFirst: true };
          }

          const changed =
            needsUpdate(operational, previous ?? output, yield* readUnit(shell, operational)) ||
            operational.publicUrl !== output.publicUrl ||
            operational.internalUrl !== output.internalUrl ||
            operational.version !== output.version;

          return { action: changed ? "update" : "noop" };
        }),
        list: () => Effect.succeed([]),
        read: Effect.fn("Celld.Node.read")(function* operation({ olds, output }) {
          if (output === undefined && !Schema.is(UnitSchema)(olds)) {
            return absent;
          }

          const unit = yield* readUnit(shell, olds);

          if (unit === undefined) {
            return absent;
          }

          const live = { ...unit, ...urls(olds) };

          if (output === undefined) {
            const owned = yield* ownedUnit(shell, olds, unit);

            const recovered = (yield* recovering) ? { ...live, configSha256: "" } : live;

            return owned ? recovered : Unowned(recovered);
          }

          return {
            ...live,
            configSha256: output.configSha256,
            sha256: output.sha256,
          };
        }),
        reconcile: Effect.fn("Celld.Node.reconcile")(function* operation({ olds, news, output }) {
          const adopt = yield* Effect.serviceOption(AdoptPolicy).pipe(
            Effect.map(Option.getOrElse(() => false)),
          );

          if (Option.isSome(startup)) {
            yield* startup.value.beforeStart(news.name, news.home);
          }

          const lines = news.sections.flatMap((section) =>
            section.name === "Service" ? section.lines : [],
          );

          const command = lines.find(([key]) => key === "ExecStart")?.[1];

          const environment = lines.find(([key]) => key === "EnvironmentFile")?.[1];

          const proof =
            command === undefined || environment === undefined
              ? Effect.succeed(false)
              : runningProcessMatches(shell, {
                  command,
                  environment,
                  fingerprints: news.restartOn ?? [],
                  name: news.name,
                });

          const unit = yield* reconcileUnit(
            shell,
            news,
            withoutLegacyHelperInputs(olds, news, output, news.prepared !== undefined),
            adopt,
            proof,
          );

          if (Option.isSome(startup)) {
            yield* startup.value.afterStart(news.name);
          }

          return { ...unit, ...urls(news) };
        }),
      });
    }),
  );
