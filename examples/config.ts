import { Config, Effect } from "effect";

export const settings = Effect.gen(function* settings() {
  return {
    instance: yield* Config.String("FLEET_INSTANCE"),
    portBase: yield* Config.Int("FLEET_PORT_BASE"),
    restartGate: yield* Config.Boolean("FLEET_RESTART_GATE"),
  };
});
