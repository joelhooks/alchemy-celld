import * as Output from "alchemy/Output";
import { Effect } from "effect";

import type { DeploymentProps } from "./deployment.ts";
import type { InstanceLayout } from "./instance.ts";
import { HostDirectory, RemoteFile } from "./providers.ts";

export const deploymentStageLayout = (_home: string, layout: InstanceLayout) => ({
  directory: `${layout.configuration}/deployment`,
  idPrefix: `${layout.instance}-deployment-stage`,
});

export const stageDeploymentFiles = Effect.fn("Celld.stageDeploymentFiles")(
  function* stageDeploymentFiles(
    home: string,
    prepared: Pick<DeploymentProps, "bundle" | "configuration">,
    publicConfiguration: boolean,
    layout: InstanceLayout,
    configurationRoot?: Output.Output<string>,
  ) {
    const stage = deploymentStageLayout(home, layout);

    const directory = yield* HostDirectory(`${stage.idPrefix}-directory`, {
      mode: 0o700,
      path:
        configurationRoot === undefined
          ? stage.directory
          : Output.interpolate`${configurationRoot}/deployment`,
    });

    const worker = yield* RemoteFile(`${stage.idPrefix}-worker`, {
      content: prepared.bundle,
      mode: 0o600,
      path: Output.interpolate`${directory.path}/worker.mjs`,
    });

    const configuration = yield* RemoteFile(`${stage.idPrefix}-configuration`, {
      content: prepared.configuration,
      mode: 0o600,
      path: Output.interpolate`${directory.path}/${publicConfiguration ? "wrangler.json" : "wrangler.public.json"}`,
    });

    return [worker.sha256, configuration.sha256] as const;
  },
);
