import type { InstanceLayout, InstanceProps } from "./instance.ts";
import type { Node } from "./inventory-schema.ts";
import { maintenanceArguments } from "./maintenance-targets.ts";
import type { UnitProps } from "./systemd.ts";

const quote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;

export interface ServiceLimits {
  readonly cpuQuota?: string | undefined;
  readonly memoryMax?: string | undefined;
  readonly oomPolicy?: "continue" | "stop" | "kill" | undefined;
}

const description = (layout: InstanceLayout) =>
  `${layout.instance.charAt(0).toUpperCase()}${layout.instance.slice(1)}`;

const limitLines = (
  input: ServiceLimits,
  memoryMax: string,
  cpuQuota: string,
): readonly (readonly [string, string])[] => [
  ["MemoryMax", input.memoryMax ?? memoryMax],
  ["MemorySwapMax", "0"],
  ["CPUQuota", input.cpuQuota ?? cpuQuota],
  ...(input.oomPolicy === undefined
    ? []
    : [["OOMPolicy", input.oomPolicy] satisfies readonly [string, string]]),
];

export const sliceUnit = (
  home: string,
  memoryMax: string | undefined,
  cpuQuota: string | undefined,
  props: Pick<InstanceProps, "instance"> & {
    readonly memoryHigh?: string;
  },
): UnitProps => ({
  home,
  name: `${props.instance}.slice`,
  scope: "user",
  sections: [
    {
      lines: [
        ["MemoryMax", memoryMax ?? "4G"],
        ["MemorySwapMax", "0"],
        ["CPUQuota", cpuQuota ?? "300%"],
        ["TasksMax", "2048"],
        ...(props.memoryHigh === undefined
          ? []
          : [["MemoryHigh", props.memoryHigh] satisfies readonly [string, string]]),
      ],
      name: "Slice",
    },
  ],
});

export const storeUnit = (
  input: ServiceLimits & {
    readonly layout: InstanceLayout;
    readonly volumeMax?: number | undefined;
    readonly home: string;
    readonly binary: string;
    readonly data: string;
    readonly config: string;
    readonly restartGate?: { readonly path: string; readonly address: string } | undefined;
    readonly restartOn: readonly string[];
  },
): UnitProps => ({
  home: input.home,
  name: input.layout.storeUnit,
  restartOn: input.restartOn,
  scope: "user",
  sections: [
    {
      lines: [
        ["Description", `${description(input.layout)} object storage`],
        ["StartLimitIntervalSec", "0"],
      ],
      name: "Unit",
    },
    {
      lines: [
        [
          "ExecStart",
          [
            quote(input.binary),
            "server",
            "-ip=127.0.0.1",
            "-ip.bind=127.0.0.1",
            ...Object.entries({
              "filer.port": input.layout.ports.filer,
              "filer.port.grpc": input.layout.ports.filerGrpc,
              "master.port": input.layout.ports.master,
              "master.port.grpc": input.layout.ports.masterGrpc,
              "s3.port": input.layout.ports.s3,
              "s3.port.grpc": input.layout.ports.s3Grpc,
              "volume.port": input.layout.ports.volume,
              "volume.port.grpc": input.layout.ports.volumeGrpc,
            }).map(([flag, port]) => `-${flag}=${port}`),
            "-filer",
            "-s3",
            "-s3.port.iceberg=0",
            "-s3.port.lance=0",
            `-dir=${quote(input.data)}`,
            `-s3.config=${quote(input.config)}`,
            "-master.telemetry=false",
            "-metricsPort=0",
            "-debug=false",
            "-volume.pprof=false",
            "-master.volumeSizeLimitMB=64",
            `-volume.max=${input.volumeMax ?? 512}`,
            "-volume.preStopSeconds=0",
          ].join(" "),
        ],
        ...(input.restartGate === undefined
          ? []
          : [
              [
                "ExecStartPost",
                `/usr/local/bin/node ${quote(input.restartGate.path)} ${quote(input.restartGate.address)} store ${quote(input.layout.instance)} ${input.layout.portBase} ${quote(input.layout.dataRoot)}`,
              ] satisfies readonly [string, string],
            ]),
        ["WorkingDirectory", input.data.replaceAll("%", "%%")],
        ["Environment", "SENTRY_DSN="],
        ["Environment", "OTEL_SDK_DISABLED=true"],
        ["Slice", input.layout.slice],
        ...limitLines(input, "3G", "100%"),
        ["TasksMax", "512"],
        ["Nice", "10"],
        ["Restart", "on-failure"],
        ["RestartSec", "10"],
        ["UMask", "0077"],
      ],
      name: "Service",
    },
    { lines: [["WantedBy", "default.target"]], name: "Install" },
  ],
});

export const nodeUnit = (
  input: ServiceLimits & {
    readonly layout: InstanceLayout;
    readonly host: Node;
    readonly workerIPv4?: string;
    readonly binary: string;
    readonly data: string;
    readonly environment: string;
    readonly storageDiagnostic?: string;
    readonly restartGate?: { readonly path: string; readonly address: string } | undefined;
    readonly restartOn: readonly string[];
  },
): UnitProps => ({
  home: input.host.home,
  name: input.layout.nodeUnit,
  restartOn: input.restartOn,
  scope: "user",
  sections: [
    {
      lines: [
        ["Description", `${description(input.layout)} cell node`],
        ["Requires", input.layout.storeUnit],
        ["After", input.layout.storeUnit],
        ["StartLimitIntervalSec", "0"],
      ],
      name: "Unit",
    },
    {
      lines: [
        [
          "ExecStart",
          `${quote(input.binary)} --listen ${input.workerIPv4 ?? input.host.tailnetIPv4}:${input.layout.ports.public} --internal-listen 127.0.0.1:${input.layout.ports.internal}`,
        ],
        ...(input.restartGate === undefined
          ? []
          : [
              [
                "ExecStartPre",
                `/usr/local/bin/node ${quote(input.restartGate.path)} ${quote(input.restartGate.address)} before-node ${quote(input.layout.instance)} ${input.layout.portBase} ${quote(input.layout.dataRoot)}`,
              ] satisfies readonly [string, string],
              [
                "ExecStartPost",
                `/usr/local/bin/node ${quote(input.restartGate.path)} ${quote(input.restartGate.address)} node ${quote(input.layout.instance)} ${input.layout.portBase} ${quote(input.layout.dataRoot)}`,
              ] satisfies readonly [string, string],
            ]),
        ...(input.storageDiagnostic === undefined
          ? []
          : [
              [
                "ExecStopPost",
                `-/usr/bin/python3 ${quote(input.storageDiagnostic)} diagnose${maintenanceArguments(input.layout)}`,
              ] satisfies readonly [string, string],
            ]),
        ["EnvironmentFile", input.environment.replaceAll("%", "%%")],
        ["WorkingDirectory", input.data.replaceAll("%", "%%")],
        ["Environment", "CELLD_OTEL=0"],
        ["Environment", "CELLD_LTX_RETENTION_SECS=86400"],
        ["Environment", "CELLD_SHUTDOWN_TOTAL_MS=8000"],
        ["Environment", quote(`CELLD_TEST_DATA_DIR=${input.data}`)],
        ["Slice", input.layout.slice],
        ...limitLines(input, "3G", "200%"),
        ["TasksMax", "1024"],
        ["Nice", "10"],
        ["Restart", "on-failure"],
        ["RestartSec", "10"],
        ["TimeoutStartSec", "180"],
        ["UMask", "0077"],
      ],
      name: "Service",
    },
    { lines: [["WantedBy", "default.target"]], name: "Install" },
  ],
});
