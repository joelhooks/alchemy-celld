import type { InstanceLayout } from "./instance.ts";
import { maintenanceArguments } from "./maintenance-targets.ts";
import type { UnitProps } from "./systemd.ts";

const quote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;

export const storageRetentionUnit = (
  home: string,
  script: string,
  ready: readonly string[],
  layout: InstanceLayout,
): UnitProps => ({
  enabled: false,
  home,
  name: layout.retentionUnit,
  restartOn: ready,
  scope: "user",
  sections: [
    {
      lines: [
        ["Description", `${layout.instance} filer metadata log retention and storage alarm`],
        ["Requires", layout.storeUnit],
        ["After", layout.storeUnit],
      ],
      name: "Unit",
    },
    {
      lines: [
        ["Type", "oneshot"],
        ["ExecStart", `/usr/bin/python3 ${quote(script)} retain${maintenanceArguments(layout)}`],
        ["Slice", layout.slice],
        ["MemoryMax", "128M"],
        ["MemorySwapMax", "0"],
        ["CPUQuota", "10%"],
        ["TasksMax", "32"],
        ["Nice", "10"],
        ["UMask", "0077"],
        ["TimeoutStartSec", "10min"],
        ["Restart", "no"],
      ],
      name: "Service",
    },
  ],
  started: false,
});

export const storageRetentionTimer = (
  home: string,
  ready: readonly string[],
  layout: InstanceLayout,
): UnitProps => ({
  home,
  name: layout.retentionTimer,
  restartOn: ready,
  scope: "user",
  sections: [
    { lines: [["Description", `${layout.instance} hourly filer log retention`]], name: "Unit" },
    {
      lines: [
        ["OnCalendar", "*-*-* *:15:00 UTC"],
        ["Persistent", "true"],
        ["Unit", layout.retentionUnit],
      ],
      name: "Timer",
    },
    { lines: [["WantedBy", "default.target"]], name: "Install" },
  ],
});
