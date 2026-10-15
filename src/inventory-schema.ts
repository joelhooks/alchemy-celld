// @effect-diagnostics nodeBuiltinImport:off -- Inventory decoding validates literal IP addresses at the Node boundary.
import { isIP } from "node:net";

import { Schema } from "effect";

const value = Schema.NonEmptyString.check(Schema.isPattern(/\S/u));

const path = value.check(
  Schema.isPattern(
    /^\/(?!$)(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))(?!.*\/\/)[^\r\n\0]*[^/\r\n\0]$/u,
  ),
);

export const NodeSchema = Schema.Struct({
  dataRoot: path,
  home: path,
  ssh: value.check(Schema.isPattern(/^(?!-)[A-Za-z0-9_.@:-]+$/u)),
  tailnetIPv4: value.check(
    Schema.isPattern(/^(?:\d{1,3}\.){3}\d{1,3}$/u),
    Schema.makeFilter((ip) => isIP(ip) === 4),
  ),
});

export type Node = typeof NodeSchema.Type;

export const Nodes = Schema.Record(Schema.NonEmptyString, NodeSchema);

const nonemptyValues = Schema.NonEmptyArray(Schema.NonEmptyString.check(Schema.isPattern(/\S/u)));

export const Instance = Schema.Struct({
  domains: nonemptyValues,
  hosts: nonemptyValues,
  ips: Schema.NonEmptyArray(Schema.String.check(Schema.makeFilter((ip) => isIP(ip) !== 0))),
  nodes: Schema.optionalKey(Nodes),
  secretNames: nonemptyValues,
  sites: nonemptyValues,
});
