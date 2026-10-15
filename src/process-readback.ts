import { Effect, Schema } from "effect";

import type { Interface } from "./host-shell.ts";

const Match = Schema.Struct({ matches: Schema.Boolean });

const script = String.raw`
import hashlib,json,os,pathlib,shlex,subprocess,sys
try:
    spec=json.loads(sys.argv[1])
    pid=int(subprocess.check_output(['systemctl','--user','show',spec['name'],'--property=MainPID','--value'],text=True).strip())
    if pid<=0: raise ValueError('No running process')
    desired=shlex.split(spec['command'].replace('%%','%').replace('$$','$'))
    actual=pathlib.Path('/proc/'+str(pid)+'/cmdline').read_bytes().rstrip(b'\0').decode().split('\0')
    if actual[1:]!=desired[1:]: raise ValueError('Arguments differ')
    digest=lambda path: hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
    binary=digest(desired[0])
    if digest('/proc/'+str(pid)+'/exe')!=binary: raise ValueError('Running binary differs')
    envpath=spec['environment'].replace('%%','%')
    environment=digest(envpath)
    if sorted([binary,environment])!=sorted(spec['fingerprints']): raise ValueError('Inputs differ')
    live=dict(value.split('=',1) for value in pathlib.Path('/proc/'+str(pid)+'/environ').read_bytes().decode().split('\0') if '=' in value)
    for line in pathlib.Path(envpath).read_text().splitlines():
        if not line or line.startswith('#'): continue
        key,value=line.split('=',1)
        expected=json.loads(value) if value.startswith('"') else value
        if live.get(key)!=expected: raise ValueError('Environment differs')
    print(json.dumps({'matches':True}))
except Exception:
    print(json.dumps({'matches':False}))
`;

export const runningProcessMatches = Effect.fn("Node.runningProcessMatches")(
  function* runningProcessMatches(
    shell: Pick<Interface, "exec">,
    input: {
      readonly name: string;
      readonly command: string;
      readonly environment: string;
      readonly fingerprints: readonly string[];
    },
  ) {
    const result = yield* shell.exec(["python3", "-c", script, JSON.stringify(input)]);

    if (result.code !== 0) {
      return false;
    }

    return (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Match))(result.stdout)).matches;
  },
  (effect) =>
    effect.pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => false),
    ),
);
