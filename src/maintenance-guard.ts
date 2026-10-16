import { Effect, Schema } from "effect";

import { refuse } from "./files.ts";

const ProtectedPorts = Schema.Struct({
  base: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  offsets: Schema.NonEmptyArray(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_534 })),
  ),
  exemptInstance: Schema.String.check(
    Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    Schema.isMaxLength(16),
  ),
}).check(
  Schema.makeFilter(({ base, offsets }) => offsets.every((offset) => base + offset <= 65_535)),
);

export const MaintenanceGuardSchema = Schema.Union([
  // This is an empty tuple, not a second list-based protection API. Entries are forbidden.
  Schema.Struct({ refuses: Schema.Tuple([]) }),
  ProtectedPorts,
]);

export type MaintenanceGuard = typeof MaintenanceGuardSchema.Type;
export interface MaintenanceProps {
  readonly maintenanceGuard: MaintenanceGuard;
}

export const maintenanceGuardError =
  "Missing or invalid maintenanceGuard. Pass maintenanceGuard: { base, offsets, exemptInstance } with valid integer ports and a safe exemption name, or maintenanceGuard: { refuses: [] } to explicitly refuse nothing.";

export const validateMaintenanceGuard = (input: MaintenanceGuard) =>
  Schema.decodeEffect(MaintenanceGuardSchema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => refuse(maintenanceGuardError)),
  );

export const maintenanceGuardBlocks = (input: MaintenanceGuard) => {
  if (
    !Schema.is(MaintenanceGuardSchema)(input) ||
    Object.keys(input).length !== ("refuses" in input ? 1 : 3)
  ) {
    throw refuse(maintenanceGuardError);
  }
  if ("refuses" in input) return undefined;
  const tuple = input.offsets.join(", ") + (input.offsets.length === 1 ? "," : "");
  return {
    declaration: `mailbox_ports = {${input.base} + offset for offset in (${tuple})}`,
    condition: `    if args.instance != ${JSON.stringify(input.exemptInstance)} and port in mailbox_ports:\n        parser.error("named maintenance refuses mailbox ports")`,
  };
};
