import { Option, Schema } from "effect";

export const RedactedEntrypoint = Schema.Struct({
  field: Schema.Literal("entrypoint"),
  redacted: Schema.Literal(true),
  extension: Schema.Literals([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mts",
    ".mjs",
    ".cts",
    ".cjs",
    "other",
  ]),
});

export const BuildDiagnostic = Schema.Struct({
  code: Schema.Literals(["syntax", "resolution", "export", "input", "build", "missing-output"]),
  severity: Schema.Literals(["error", "warning", "note"]),
  field: Schema.String,
  text: Schema.String,
  location: Schema.optionalKey(Schema.Struct({ line: Schema.Int, column: Schema.Int })),
});
export type BuildDiagnostic = typeof BuildDiagnostic.Type;

const Location = Schema.NullOr(Schema.Struct({ line: Schema.Int, column: Schema.Int }));
const Note = Schema.Struct({ text: Schema.String, location: Schema.optionalKey(Location) });
const Message = Schema.Struct({ ...Note.fields, notes: Schema.optionalKey(Schema.Array(Note)) });
const Failure = Schema.Struct({
  errors: Schema.optionalKey(Schema.Array(Message)),
  warnings: Schema.optionalKey(Schema.Array(Message)),
});

export const redactedEntrypoint = (entrypoint: string): typeof RedactedEntrypoint.Type => ({
  field: "entrypoint",
  redacted: true,
  extension:
    ([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"] as const).find(
      (suffix) => typeof entrypoint === "string" && entrypoint.endsWith(suffix),
    ) ?? "other",
});

// Do not copy raw text, source snippets, filenames, suggestions, plugin detail or causes.
// Only fixed diagnostics and a finite set of syntax tokens can survive this boundary.
const tokens = new Set([
  "identifier",
  "end of file",
  ...[
    "{",
    "}",
    "[",
    "]",
    "(",
    ")",
    "=",
    ";",
    ":",
    ",",
    ".",
    "=>",
    "const",
    "let",
    "var",
    "function",
    "return",
    "export",
    "import",
    "default",
  ].map((token) => JSON.stringify(token)),
]);
const token = (value: string) => (tokens.has(value) ? value : "<redacted token>");

const summary = (text: string): Pick<BuildDiagnostic, "code" | "field" | "text"> => {
  const expected = /^Expected (.+) but found (.+)$/u.exec(text);
  if (expected !== null)
    return {
      code: "syntax",
      field: "entrypoint",
      text: `Expected ${token(expected[1] ?? "")} but found ${token(expected[2] ?? "")}`,
    };
  const unexpected = /^Unexpected (.+)$/u.exec(text);
  if (unexpected !== null)
    return {
      code: "syntax",
      field: "entrypoint",
      text: `Unexpected ${token(unexpected[1] ?? "")}`,
    };
  if (
    [
      "Unterminated string literal",
      "Unterminated template literal",
      "Unterminated multi-line comment",
      "Unexpected end of file",
    ].includes(text)
  ) {
    return { code: "syntax", field: "entrypoint", text };
  }
  if (text.startsWith("Could not resolve "))
    return {
      code: "resolution",
      field: "import",
      text: "Could not resolve the build input; value redacted.",
    };
  if (text.startsWith("No matching export "))
    return {
      code: "export",
      field: "import",
      text: "No matching export; module and export values redacted.",
    };
  if (text.startsWith("Could not read from file") || text.startsWith("Cannot read file"))
    return {
      code: "input",
      field: "entrypoint",
      text: "Source file is unreadable; value redacted.",
    };
  return { code: "build", field: "entrypoint", text: "Build failed; diagnostic values redacted." };
};

export const buildDiagnostics = (cause: unknown): readonly BuildDiagnostic[] => {
  const decoded = Schema.decodeUnknownOption(Failure)(cause);
  if (Option.isNone(decoded)) return [{ ...summary(""), severity: "error" }];
  const output: BuildDiagnostic[] = [];
  const append = (message: typeof Note.Type, severity: BuildDiagnostic["severity"]) => {
    const safe = summary(message.text);
    output.push({
      ...safe,
      field: safe.code === "resolution" && message.location == null ? "entrypoint" : safe.field,
      severity,
      ...(message.location == null
        ? {}
        : { location: { line: message.location.line, column: message.location.column } }),
    });
  };
  for (const [severity, messages] of [
    ["error", decoded.value.errors],
    ["warning", decoded.value.warnings],
  ] as const) {
    for (const message of messages ?? []) {
      append(message, severity);
      for (const note of message.notes ?? []) append(note, "note");
    }
  }
  return output.length === 0 &&
    decoded.value.errors === undefined &&
    decoded.value.warnings === undefined
    ? [{ ...summary(""), severity: "error" }]
    : output;
};
