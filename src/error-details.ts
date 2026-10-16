import { Effect, Schema } from "effect";

// Context contains field names and accepted shapes, never untrusted input values.
export const ErrorDetails = {
  field: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("input"))),
  expectedShape: Schema.String.pipe(
    Schema.withConstructorDefault(Effect.succeed("The documented input schema for this operation")),
  ),
  action: Schema.String.pipe(
    Schema.withConstructorDefault(
      Effect.succeed("Correct the declared input before retrying this operation."),
    ),
  ),
};

export const errorMessage = (error: {
  readonly reason: string;
  readonly field?: string;
  readonly expectedShape?: string;
  readonly action?: string;
}): string =>
  [
    error.reason,
    error.field === undefined ? undefined : `Field: ${error.field}.`,
    error.expectedShape === undefined ? undefined : `Expected: ${error.expectedShape}.`,
    error.action === undefined ? undefined : `Action: ${error.action}`,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
