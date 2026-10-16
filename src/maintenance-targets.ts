import { Schema } from "effect";

import { ErrorDetails, errorMessage } from "./error-details.ts";
import type { InstanceLayout } from "./instance.ts";
import { maintenanceGuardBlocks, maintenanceGuardError } from "./maintenance-guard.ts";

export class MaintenanceRenderError extends Schema.TaggedError<MaintenanceRenderError>()(
  "MaintenanceRenderError",
  { operation: Schema.tag("render-maintenance"), reason: Schema.String, ...ErrorDetails },
) {
  override get message(): string {
    return errorMessage(this);
  }
}

const quote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;

export const assertMaintenanceIsolation = (
  layout: InstanceLayout,
  text: string,
  kind: "unit" | "script" = "unit",
): void => {
  if (kind === "script") {
    if (layout.maintenanceGuard === undefined) {
      throw new MaintenanceRenderError({
        reason: maintenanceGuardError,
        field: "maintenanceGuard",
        expectedShape: "{ base, offsets, exemptInstance } or { refuses: [] }",
        action:
          "Declare protected ports or explicitly refuse nothing before rendering maintenance.",
      });
    }
    const guard = maintenanceGuardBlocks(layout.maintenanceGuard);
    if (
      guard !== undefined &&
      (!text.includes(`${guard.declaration}\n`) || !text.includes(`${guard.condition}\n`))
    ) {
      throw new MaintenanceRenderError({
        reason: "Requested maintenanceGuard is missing from the rendered script.",
        field: "renderedScript",
        expectedShape: "Both canonical guard declaration and exemption condition",
        action:
          "Regenerate the complete script with renderMaintenanceScript; retain the requested guard.",
      });
    }
  }
  for (const match of text.matchAll(/--(?<role>master|filer)\s+(?<target>\S+)/gu)) {
    const port = match.groups?.role === "master" ? layout.ports.master : layout.ports.filer;

    if (match.groups?.target !== `http://127.0.0.1:${port}`) {
      throw new MaintenanceRenderError({
        reason: "Maintenance target escapes its instance.",
        field: match.groups?.role === "master" ? "--master" : "--filer",
        expectedShape: "An explicit loopback HTTP endpoint using this instance's declared port",
        action:
          "Render maintenance arguments from the same instance layout; do not substitute peer endpoints.",
      });
    }
  }
};

export const maintenanceArguments = (layout: InstanceLayout): string =>
  ` --instance ${quote(layout.instance)} --master http://127.0.0.1:${layout.ports.master} --filer http://127.0.0.1:${layout.ports.filer} --root /topics/.system/log`;
