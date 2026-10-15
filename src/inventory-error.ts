import { Schema } from "effect";

export class InventoryError extends Schema.TaggedError<InventoryError>()("InventoryError", {
  reason: Schema.String,
}) {}
