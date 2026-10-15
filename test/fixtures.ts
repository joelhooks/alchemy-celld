import type { UnitProps } from "../src/systemd.ts";

export const service = (
  home = "/home/example",
  name = "celld-test-example.service",
  memory = "64M",
): UnitProps => ({
  home,
  name,
  scope: "user",
  sections: [
    {
      lines: [
        ["Description", "Provider lifecycle test"],
        ["StartLimitIntervalSec", "0"],
      ],
      name: "Unit",
    },
    {
      lines: [
        ["ExecStart", "/bin/sleep infinity"],
        ["Slice", "celld.slice"],
        ["MemoryMax", memory],
        ["MemorySwapMax", "0"],
        ["CPUQuota", "10%"],
        ["TasksMax", "16"],
        ["Nice", "10"],
        ["Restart", "on-failure"],
        ["RestartSec", "10"],
      ],
      name: "Service",
    },
    { lines: [["WantedBy", "default.target"]], name: "Install" },
  ],
});
