import { Schema } from "effect";

import type { InstanceLayout } from "./instance.ts";
import { maintenanceGuardBlocks, maintenanceGuardError } from "./maintenance-guard.ts";

export class MaintenanceRenderError extends Schema.TaggedError<MaintenanceRenderError>()(
  "MaintenanceRenderError",
  { reason: Schema.String },
) {}

const quote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;

export const assertMaintenanceIsolation = (
  layout: InstanceLayout,
  text: string,
  kind: "unit" | "script" = "unit",
): void => {
  if (kind === "script") {
    if (layout.maintenanceGuard === undefined) {
      throw new MaintenanceRenderError({ reason: maintenanceGuardError });
    }
    const guard = maintenanceGuardBlocks(layout.maintenanceGuard);
    if (
      guard !== undefined &&
      (!text.includes(`${guard.declaration}\n`) || !text.includes(`${guard.condition}\n`))
    ) {
      throw new MaintenanceRenderError({
        reason: "Requested maintenanceGuard is missing from the rendered script.",
      });
    }
  }
  for (const match of text.matchAll(/--(?<role>master|filer)\s+(?<target>\S+)/gu)) {
    const port = match.groups?.role === "master" ? layout.ports.master : layout.ports.filer;

    if (match.groups?.target !== `http://127.0.0.1:${port}`) {
      throw new MaintenanceRenderError({ reason: "Maintenance target escapes its instance." });
    }
  }
};

export const maintenanceArguments = (layout: InstanceLayout): string =>
  ` --instance ${quote(layout.instance)} --master http://127.0.0.1:${layout.ports.master} --filer http://127.0.0.1:${layout.ports.filer} --root /topics/.system/log`;
