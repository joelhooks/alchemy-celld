import { Schema } from "effect";

import { ErrorDetails, errorMessage } from "./error-details.ts";

export class ArchiveRefused extends Schema.TaggedError<ArchiveRefused>()("ArchiveRefused", {
  operation: Schema.tag("read-archive"),
  reason: Schema.String,
  ...ErrorDetails,
}) {
  override get message(): string {
    return errorMessage(this);
  }
}
