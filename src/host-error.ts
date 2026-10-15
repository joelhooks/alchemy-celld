import { Schema } from "effect";

export class HostError extends Schema.TaggedError<HostError>()("HostError", {
  operation: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}
