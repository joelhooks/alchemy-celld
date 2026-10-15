import type { Effect } from "effect";
import { Context } from "effect";

import type { HostError } from "./host-error.ts";

export interface StartupChecks {
  readonly beforeStart: (name: string, home: string) => Effect.Effect<void, HostError>;
  readonly afterStart: (name: string) => Effect.Effect<void, HostError>;
}

export class UnitStartup extends Context.Service<UnitStartup, StartupChecks>()(
  "@alchemy-celld/UnitStartup",
) {}
