import type { InstanceLayout } from "./instance.ts";

export const declaredListeners = (
  publicIPv4: string,
  nodeExpected: boolean,
  layout: InstanceLayout,
) => [
  ...Object.entries(layout.ports)
    .filter(([key]) => key !== "public" && key !== "internal")
    .map(([, port]) => ({
      address: "127.0.0.1",
      port,
      unit: layout.storeUnit,
    })),
  ...(nodeExpected
    ? [
        { address: publicIPv4, port: layout.ports.public, unit: layout.nodeUnit },
        { address: "127.0.0.1", port: layout.ports.internal, unit: layout.nodeUnit },
      ]
    : []),
];
