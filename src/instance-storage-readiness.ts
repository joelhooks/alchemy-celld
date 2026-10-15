import { Effect, Option, Schema } from "effect";

import { refuse } from "./files.ts";
import type { Interface } from "./host-shell.ts";
import { s3Script } from "./s3-script.ts";

const Response = Schema.Struct({ status: Schema.Int });

export const waitForStorage = Effect.fn("Startup.waitForStorage")(
  function* waitForStorage(
    shell: Pick<Interface, "exec">,
    input: {
      readonly home: string;
      readonly configuration?: string;
      readonly endpoint: string;
      readonly bucket: string;
    },
  ) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const result = yield* shell.exec([
        "python3",
        "-c",
        s3Script,
        `${input.configuration ?? `${input.home}/.config/celld`}/s3.json`,
        input.endpoint,
        input.bucket,
        "writable",
      ]);

      const response = Schema.decodeUnknownOption(Schema.fromJsonString(Response))(result.stdout);

      if (result.code === 0 && Option.isSome(response) && response.value.status === 200) {
        return yield* Effect.void;
      }

      yield* Effect.sleep("250 millis");
    }

    return yield* refuse(
      "Storage did not accept an authenticated conditional write before node startup",
    );
  },
  (effect) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: "120 seconds",
        orElse: () => refuse("Storage readiness deadline exceeded before node startup"),
      }),
    ),
);
