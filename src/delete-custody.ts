import { Effect } from "effect";

import { HostError } from "./host-error.ts";
import type { Interface } from "./host-shell.ts";
import type { InstanceLayout } from "./instance.ts";

export const bootstrapDirectoryPattern =
  /^bootstrap-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const isBootstrapDirectory = (root: string, path: string) =>
  path.startsWith(`${root}/`) && bootstrapDirectoryPattern.test(path.slice(root.length + 1));

export const instanceDeleteCustody = (home: string, layout: InstanceLayout) => {
  const units = [
    layout.nodeUnit,
    layout.storeUnit,
    layout.retentionUnit,
    layout.retentionTimer,
    layout.slice,
  ];

  const directories = [
    layout.binaryRoot,
    layout.bin,
    layout.configuration,
    layout.dataRoot,
    `${layout.dataRoot}/celld`,
    `${layout.dataRoot}/seaweedfs`,
    `${layout.configuration}/deployment`,
  ];

  const files = [
    `${layout.dataRoot}/.mailbox-restore-objects.tar`,
    ...units.map((name) => `${home}/.config/systemd/user/${name}`),
    ...["celld", "weed", "restart-gate.mjs", "storage-maintenance.py"].map(
      (name) => `${layout.bin}/${name}`,
    ),
    ...["s3.json", "celld.env", "bindings.json"].map((name) => `${layout.configuration}/${name}`),
    ...["worker.mjs", "wrangler.json", "wrangler.public.json"].map(
      (name) => `${layout.configuration}/deployment/${name}`,
    ),
  ];

  return {
    directories,
    files,
    home,
    layout,
    units,
  };
};

export type DeleteCustody = ReturnType<typeof instanceDeleteCustody>;

export const assertDeletePath = (shell: Interface, path: string, kind: "directories" | "files") => {
  const custody = shell.deleteCustody;

  const bootstrap =
    custody !== undefined &&
    (kind === "directories"
      ? isBootstrapDirectory(custody.layout.configuration, path)
      : ["index.js", "wrangler.json"].some(
          (name) =>
            path.endsWith(`/${name}`) &&
            isBootstrapDirectory(custody.layout.configuration, path.slice(0, -(name.length + 1))),
        ));

  return custody === undefined || custody[kind].includes(path) || bootstrap
    ? Effect.void
    : Effect.fail(
        new HostError({
          operation: "provider",
          reason: "Delete path escapes its instance custody.",
        }),
      );
};

export const assertDeleteUnit = (
  shell: Interface,
  unit: { readonly home: string; readonly name: string; readonly path?: string },
) => {
  const custody = shell.deleteCustody;

  return custody === undefined ||
    (unit.home === custody.home &&
      custody.units.includes(unit.name) &&
      (unit.path === undefined ||
        unit.path === `${custody.home}/.config/systemd/user/${unit.name}`))
    ? Effect.void
    : Effect.fail(
        new HostError({
          operation: "provider",
          reason: "Delete unit escapes its instance custody.",
        }),
      );
};

export const deploymentDeleteRoot = (shell: Interface, directory: string) => {
  if (shell.deleteCustody !== undefined) {
    const root = shell.deleteCustody.layout.configuration;

    return directory === `${root}/deployment` && shell.purgeRoots.includes(root) ? root : undefined;
  }

  const root = shell.purgeRoots.find((path) => path.endsWith("/.config/celld"));

  return root !== undefined && directory === `${root}/mailbox-deployment` ? root : undefined;
};
