import { Data, Effect } from "effect";

import { errorMessage } from "./error-details.ts";
import { must } from "./host-shell.ts";
import type { Interface } from "./host-shell.ts";
import { declaredListeners } from "./instance-listener-contract.ts";
import type { InstanceLayout } from "./instance.ts";

export type ListenerAssessment =
  | { readonly _tag: "Ready"; readonly receipt: string }
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "Early"; readonly receipt: string }
  | { readonly _tag: "Violation"; readonly receipt: string };

const Assessment = Data.taggedEnum<ListenerAssessment>();

export class ListenerExposure extends Data.TaggedError("ListenerExposure")<{
  readonly receipt: string;
}> {
  readonly operation = "validate-listeners";
  readonly reason = "Startup listener contract violated";
  readonly field = "listeners";
  readonly expectedShape =
    "Exactly the declared unit-owned listeners, without duplicates or extra exposure";
  readonly action =
    "Inspect the existing listener receipt and correct ownership or bindings before restarting units.";
  override get message(): string {
    return errorMessage(this);
  }
}

const listenerKey = ({
  unit,
  address,
  port,
}: {
  readonly unit: string;
  readonly address: string;
  readonly port: number;
}) => `${unit}|${address}|${port}`;

export const stackListeners = (
  text: string,
  unitCgroups: ReadonlyMap<string, string>,
  layout: InstanceLayout,
) => {
  const owned: {
    readonly line: string;
    readonly unit: string | undefined;
    readonly address: string;
    readonly port: number;
  }[] = [];

  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("State")) {
      continue;
    }

    const local = line.trim().split(/\s+/u)[3] ?? "";
    const separator = local.lastIndexOf(":");
    const address = local.slice(0, separator).replaceAll(/^\[|\]$/gu, "");
    const port = Number(local.slice(separator + 1));
    const cgroup = /(?:^|\s)cgroup:(?<path>\/\S+)/u.exec(line)?.groups?.path;

    const units = [layout.storeUnit, layout.nodeUnit];

    const unit = units.find((name) => unitCgroups.get(name) === cgroup && cgroup !== undefined);

    const stackCgroup =
      cgroup?.split("/").some((part) => part === layout.slice || units.includes(part)) === true;

    if (unit === undefined && !stackCgroup && !new Set(Object.values(layout.ports)).has(port)) {
      continue;
    }

    owned.push({ address, line, port, unit });
  }

  return owned;
};

export const assessListeners = (
  text: string,
  publicIPv4: string,
  nodeExpected: boolean,
  unitCgroups: ReadonlyMap<string, string>,
  layout: InstanceLayout,
): ListenerAssessment => {
  const declared = new Set(declaredListeners(publicIPv4, true, layout).map(listenerKey));

  const remaining = new Set(declaredListeners(publicIPv4, nodeExpected, layout).map(listenerKey));

  const seen = new Set<string>();
  const lines: string[] = [];
  let early = false;

  for (const { address, line, port, unit } of stackListeners(text, unitCgroups, layout)) {
    lines.push(line);

    const key = unit === undefined ? undefined : listenerKey({ address, port, unit });

    if (key === undefined || !declared.has(key) || seen.has(key)) {
      return Assessment.Violation({ receipt: lines.join("\n") });
    }

    seen.add(key);
    early ||= !remaining.delete(key);
  }

  if (early) {
    return Assessment.Early({ receipt: lines.join("\n") });
  }

  return remaining.size === 0
    ? Assessment.Ready({ receipt: lines.join("\n") })
    : Assessment.Waiting();
};

export const readListeners = Effect.fn("Listeners.read")(function* read(
  shell: Pick<Interface, "exec">,
  layout: InstanceLayout,
) {
  const unitCgroups = new Map<string, string>();

  for (const unit of [layout.storeUnit, layout.nodeUnit]) {
    const result = yield* shell.exec([
      "systemctl",
      "--user",
      "show",
      unit,
      "--property=ControlGroup",
      "--value",
    ]);

    const cgroup = result.stdout.trim();

    if (result.code === 0 && /^\/\S+$/u.test(cgroup) && cgroup.endsWith(`/${unit}`)) {
      unitCgroups.set(unit, cgroup);
    }
  }

  const text = yield* must(shell, ["ss", "-H", "-ltnp", "--cgroup"]);

  return { text, unitCgroups };
});
