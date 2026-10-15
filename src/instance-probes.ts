import { Crypto, Effect, FileSystem, Predicate, Redacted, Schema } from "effect";
import { HttpClient } from "effect/http";

import { refuse } from "./files.ts";
import type { Interface } from "./host-shell.ts";
import { assessListeners, readListeners } from "./instance-listeners.ts";
import type { InstanceLayout } from "./instance.ts";
import { s3Script } from "./s3-script.ts";

export type ProbeRunnerMode = "scope" | "service";

export const serviceCapGuard = String.raw`
set -eu
caps=$(systemctl --user show "$1" --no-pager --property=MemoryMax,MemorySwapMax,CPUQuotaPerSecUSec,TasksMax)
for expected in MemoryMax=67108864 MemorySwapMax=0 CPUQuotaPerSecUSec=100ms TasksMax=64; do
  printf '%s\n' "$caps" | grep -Fxq "$expected" || { printf 'Probe service cap readback failed\n' >&2; exit 1; }
done
shift
exec nice -n 10 "$@"
`;

export const probeCommand = (
  name: string,
  argv: readonly string[],
  layout: InstanceLayout,
  mode: ProbeRunnerMode = "scope",
) => [
  "systemd-run",
  "--user",
  ...(mode === "scope" ? ["--scope"] : ["--wait", "--pipe", "--collect"]),
  "--quiet",
  `--unit=${mode === "scope" ? name : `${name}.service`}`,
  `--slice=${layout.slice}`,
  "--property=MemoryMax=64M",
  "--property=MemorySwapMax=0",
  "--property=CPUQuota=10%",
  "--property=TasksMax=64",
  "--",
  ...(mode === "scope"
    ? ["nice", "-n", "10", ...argv]
    : ["sh", "-c", serviceCapGuard, "probe", `${name}.service`, ...argv]),
];

const Identity = Schema.Struct({
  identities: Schema.Array(
    Schema.Struct({
      credentials: Schema.Array(
        Schema.Struct({ accessKey: Schema.String, secretKey: Schema.String }),
      ),
    }),
  ),
});

const credentialRedactions = Effect.fn("Probe.credentialRedactions")(function* credentials(
  shell: Interface,
  config: string,
) {
  const bytes = yield* shell.read(config);

  if (bytes === undefined) {
    return yield* refuse("Probe identity file is missing.");
  }

  const identity = yield* Schema.decodeEffect(Schema.fromJsonString(Identity))(
    new TextDecoder().decode(bytes),
  ).pipe(Effect.mapError(() => refuse("Probe identity file is malformed.")));

  return identity.identities.flatMap((entry) =>
    entry.credentials.flatMap((pair) => [
      Redacted.make(pair.accessKey),
      Redacted.make(pair.secretKey),
    ]),
  );
});

export const probeEnvironment = Effect.fn("Probe.environment")(function* environment(
  shell: Interface,
  home: string,
  layout: InstanceLayout,
) {
  const bytes = yield* shell.read(`${layout.configuration}/celld.env`);

  if (bytes === undefined) {
    return yield* refuse("Probe environment file is missing.");
  }

  const lines = new TextDecoder().decode(bytes).split("\n");

  const decode = (key: string) =>
    Schema.decodeEffect(Schema.fromJsonString(Schema.String))(
      lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1) ?? "",
    ).pipe(Effect.mapError(() => refuse("Probe environment field is malformed.")));

  const location = yield* decode("CELLD_BUCKET");

  if (!location.startsWith("s3://")) {
    return yield* refuse("Probe environment is not an S3 bucket.");
  }

  return {
    bucket: location.slice(5),
    endpoint: yield* decode("S3_ENDPOINT"),
    redactions: yield* credentialRedactions(shell, `${layout.configuration}/s3.json`),
  };
});

export const diagnoseProbe = Effect.fn("Celld.diagnoseProbe")(function* diagnose(
  shell: Interface,
  input: {
    readonly home: string;
    readonly runnerMode?: ProbeRunnerMode;
    readonly layout: InstanceLayout;
  },
) {
  const crypto = yield* Crypto.Crypto;

  const environment = yield* probeEnvironment(shell, input.home, input.layout);

  const result = yield* shell.exec(
    probeCommand(
      `${input.layout.instance}-probe-${yield* crypto.randomUUIDv4}`,
      [
        "sh",
        "-c",
        'set -a; . "$1"; TOKIO_WORKER_THREADS=2; exec "$2" diagnose --listen 127.0.0.1:0 --internal-listen 127.0.0.1:0 2>&1',
        "probe",
        `${input.layout.configuration}/celld.env`,
        `${input.layout.bin}/celld`,
      ],
      input.layout,
      input.runnerMode,
    ),
    { redactions: environment.redactions },
  );

  const line = result.stdout
    .split("\n")
    .find((entry) => /\bok\s+bucket conditional write\b/u.test(entry));

  if (result.code !== 0 || line === undefined) {
    return yield* refuse(
      `celld diagnose failed; stop and ask the owner before proceeding.\n${result.stdout}\n${result.stderr ?? ""}`,
    );
  }

  return line.trim();
});

const Race = Schema.Struct({
  preconditions: Schema.Int,
  statuses: Schema.Array(Schema.Int),
  winners: Schema.Int,
});

export const raceProbe = Effect.fn("ObjectStore.raceProbe")(function* race(
  shell: Interface,
  input: {
    readonly config: string;
    readonly endpoint: string;
    readonly name: string;
    readonly runnerMode?: ProbeRunnerMode;
    readonly layout: InstanceLayout;
  },
) {
  const crypto = yield* Crypto.Crypto;

  const result = yield* shell.exec(
    probeCommand(
      `${input.layout.instance}-probe-${yield* crypto.randomUUIDv4}`,
      ["python3", "-c", s3Script, input.config, input.endpoint, input.name, "race"],
      input.layout,
      input.runnerMode,
    ),
    { redactions: yield* credentialRedactions(shell, input.config) },
  );

  if (result.code !== 0) {
    return yield* refuse(
      `Race command failed; stop and ask the owner.\n${result.stdout}\n${result.stderr ?? ""}`,
    );
  }

  const tally = yield* Schema.decodeEffect(Schema.fromJsonString(Race))(result.stdout).pipe(
    Effect.mapError(() => refuse("Malformed race tally.")),
  );

  if (tally.winners !== 1 || tally.preconditions !== 49 || tally.statuses.length !== 50) {
    return yield* refuse(
      `Conditional race failed: ${JSON.stringify(tally)}; stop and ask the owner.`,
    );
  }

  return tally;
});

export const bootstrapProbe = Effect.fn("Celld.bootstrapProbe")(function* bootstrap(
  shell: Interface,
  input: {
    readonly home: string;
    readonly runnerMode?: ProbeRunnerMode;
    readonly layout: InstanceLayout;
  },
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;

  const source = yield* fs.readFile(new URL("bootstrap-worker.js", import.meta.url).pathname);

  const directory = `${input.layout.configuration}/bootstrap-${yield* crypto.randomUUIDv4}`;
  const entry = `${directory}/index.js`;
  const config = `${directory}/wrangler.json`;
  yield* shell.mkdir({ mode: 0o700, path: directory });

  return yield* Effect.gen(function* publish() {
    yield* shell.write({ bytes: source, mode: 0o600, path: entry });
    yield* shell.write({
      bytes: new TextEncoder().encode(
        JSON.stringify({
          compatibility_date: "2026-10-04",
          main: "index.js",
          name: "celld-bootstrap",
          no_bundle: true,
        }),
      ),
      mode: 0o600,
      path: config,
    });

    const environment = yield* probeEnvironment(shell, input.home, input.layout);

    const result = yield* shell.exec(
      probeCommand(
        `${input.layout.instance}-probe-${yield* crypto.randomUUIDv4}`,
        [
          "sh",
          "-c",
          'set -a; . "$1"; TOKIO_WORKER_THREADS=2; exec "$2" deploy "$3"',
          "probe",
          `${input.layout.configuration}/celld.env`,
          `${input.layout.bin}/celld`,
          directory,
        ],
        input.layout,
        input.runnerMode,
      ),
      { redactions: environment.redactions },
    );

    if (result.code !== 0) {
      return yield* refuse(`Bootstrap deploy failed.\n${result.stdout}\n${result.stderr ?? ""}`);
    }

    return result.stdout;
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* cleanup() {
        yield* shell.remove(entry);
        yield* shell.remove(config);
        yield* shell.rmdir(directory);
      }).pipe(Effect.orDie),
    ),
  );
});

export const bootstrapCheck = Effect.fn("Celld.bootstrapCheck")(function* check(url: string) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get(url);

  if (response.status !== 200 || (yield* response.text) !== "celld bootstrap\n") {
    return yield* refuse("Bootstrap Worker response did not match.");
  }

  return "bootstrap body matched";
});

export const listenerProbe = Effect.fn("Celld.listenerProbe")(function* listeners(
  shell: Interface,
  publicIPv4: string,
  nodeExpected: boolean,
  layout: InstanceLayout,
) {
  const evidence = yield* readListeners(shell, layout);

  const assessment = assessListeners(
    evidence.text,
    publicIPv4,
    nodeExpected,
    evidence.unitCgroups,
    layout,
  );

  if (!Predicate.isTagged(assessment, "Ready")) {
    return yield* refuse("Listener contract did not match");
  }

  return assessment.receipt;
});
