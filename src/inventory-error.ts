import { Schema } from "effect";

import { ErrorDetails, errorMessage } from "./error-details.ts";

export class InventoryError extends Schema.TaggedError<InventoryError>()("InventoryError", {
  operation: Schema.tag("load-inventory"),
  reason: Schema.String,
  ...ErrorDetails,
}) {
  override get message(): string {
    return errorMessage(this);
  }
}
