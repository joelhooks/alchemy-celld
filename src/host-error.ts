import { Schema } from "effect";

import { BuildDiagnostic, RedactedEntrypoint } from "./build-diagnostics.ts";
import { errorMessage } from "./error-details.ts";

export class HostError extends Schema.TaggedError<HostError>()("HostError", {
  operation: Schema.String,
  reason: Schema.String,
  field: Schema.optionalKey(Schema.String),
  expectedShape: Schema.optionalKey(Schema.String),
  actual: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(Schema.String),
  entrypoint: Schema.optionalKey(RedactedEntrypoint),
  diagnostics: Schema.optionalKey(Schema.Array(BuildDiagnostic)),
}) {
  override get message(): string {
    return errorMessage(this);
  }
}
