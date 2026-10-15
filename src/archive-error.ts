import { Schema } from "effect";

export class ArchiveRefused extends Schema.TaggedError<ArchiveRefused>()("ArchiveRefused", {
  message: Schema.String,
}) {}
