/**
 * Normalizes TypeBox schemas into a simple wire model shared by every emitter
 * (.fbs, Rust glue, TS registry). All emitters derive field order / naming from
 * this single model, so the Rust builder and the flatc-generated TS decoders
 * are wire-compatible by construction.
 */
import type { TSchema } from "@sinclair/typebox";

export type FieldKind =
  | "string"
  | "double"
  | "int64"
  | "bool"
  | "enum"
  | "table"
  | "vector-string"
  | "vector-double"
  | "vector-int64"
  | "vector-bool"
  | "vector-enum"
  | "vector-table";

export interface FieldDef {
  /** camelCase, matches the TypeBox/Events key */
  jsonName: string;
  /** snake_case, the wire (.fbs / flatc) field name */
  fbName: string;
  /** whether the field is required in the TypeBox schema */
  required: boolean;
  kind: FieldKind;
  enumName?: string;
  tableName?: string;
  /** int64 field decoded/encoded as `bigint` (Type.Integer({ bigint: true })) — exact beyond 2^53 */
  bigint?: boolean;
}

export interface TableDef {
  name: string;
  fields: FieldDef[];
}

export interface EnumDef {
  name: string;
  values: string[];
}

export interface EventDef {
  name: string;
  tableName: string;
  /** transport-internal event (hello/subscribe/ping/...); hidden from the public Events surface */
  control?: boolean;
}

export interface Model {
  enums: EnumDef[];
  tables: TableDef[];
  events: EventDef[];
}

/** A table is "flat" when every field maps to a direct FFI arg (no tables/vectors). */
export function isFlatTable(t: TableDef): boolean {
  return t.fields.every(
    (f) =>
      f.kind === "string" ||
      f.kind === "double" ||
      f.kind === "int64" ||
      f.kind === "bool" ||
      f.kind === "enum",
  );
}

/**
 * A table is "directable" when every field is either a flat scalar/string/enum
 * OR a packed vector (scalars/strings/enums, or tables whose elements are flat).
 * Directable events serialize with ZERO allocations and NO JSON — vectors travel
 * as a packed binary blob (`read_packed_*` on the Rust side).
 */
export function isDirectableTable(m: Model, t: TableDef): boolean {
  return t.fields.every((f) => {
    switch (f.kind) {
      case "string":
      case "double":
      case "int64":
      case "bool":
      case "enum":
        return true;
      case "vector-table": {
        const elem = m.tables.find((e) => e.name === f.tableName);
        return elem ? isFlatTable(elem) : false;
      }
      case "vector-string":
      case "vector-double":
      case "vector-int64":
      case "vector-bool":
      case "vector-enum":
        return true;
      default:
        return false;
    }
  });
}

export function isDirectableEvent(m: Model, ev: EventDef): boolean {
  const t = m.tables.find((t) => t.name === ev.tableName);
  return !!t && t.fields.length > 0 && isDirectableTable(m, t);
}

export function toSnake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export function toPascal(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9]+(.)?/g, (_m, c: string) => (c ? c.toUpperCase() : ""));
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

type AnySchema = Record<string, any>;

interface Ctx {
  named: Map<object, string>;
  used: Set<string>;
  enums: EnumDef[];
  tables: TableDef[];
  events: EventDef[];
  enumById: Map<object, string>;
  tableById: Map<object, string>;
}

function uniqueName(ctx: Ctx, base: string): string {
  let name = base;
  let i = 2;
  while (ctx.used.has(name)) {
    name = `${base}${i}`;
    i++;
  }
  ctx.used.add(name);
  return name;
}

function unionMembers(s: AnySchema): AnySchema[] {
  return (s.anyOf ?? s.oneOf ?? []) as AnySchema[];
}

const isStringLiteral = (m: AnySchema): boolean => typeof m?.const === "string";
const isNullMember = (m: AnySchema): boolean => m?.type === "null";
const isObjectLike = (m: AnySchema): boolean => m?.type === "object" && typeof m?.properties === "object";

function registerEnum(ctx: Ctx, schema: AnySchema, values: string[], jsonName: string): string {
  const existing = ctx.enumById.get(schema);
  if (existing) return existing;
  const name = uniqueName(ctx, toPascal(jsonName));
  ctx.enums.push({ name, values });
  ctx.enumById.set(schema, name);
  return name;
}

function ensureTable(ctx: Ctx, schema: AnySchema, fallbackName: string): string {
  const existing = ctx.tableById.get(schema);
  if (existing) return existing;

  const name = ctx.named.get(schema) ?? uniqueName(ctx, fallbackName);
  if (!ctx.used.has(name)) ctx.used.add(name);
  ctx.tableById.set(schema, name);
  // placeholder first so recursive/self references terminate
  ctx.tables.push({ name, fields: [] });

  const props = (schema.properties ?? {}) as Record<string, AnySchema>;
  const required: string[] = schema.required ?? [];
  const fields: FieldDef[] = [];
  for (const [jsonName, propSchema] of Object.entries(props)) {
    const resolved = resolveFieldType(ctx, propSchema, jsonName, name);
    fields.push({
      jsonName,
      fbName: toSnake(jsonName),
      required: required.includes(jsonName),
      ...resolved,
    });
  }
  const table = ctx.tables.find((t) => t.name === name)!;
  table.fields = fields;
  return name;
}

function resolveFieldType(
  ctx: Ctx,
  schema: AnySchema,
  jsonName: string,
  parentName: string,
): { kind: FieldKind; enumName?: string; tableName?: string; bigint?: boolean } {
  const members = unionMembers(schema);
  if (members.length > 0) {
    if (members.every(isStringLiteral)) {
      const enumName = registerEnum(ctx, schema, members.map((m) => m.const as string), jsonName);
      return { kind: "enum", enumName };
    }
    const tableMember = members.find(isObjectLike);
    if (tableMember && members.filter((m) => !isNullMember(m)).length === 1) {
      const tableName = ensureTable(ctx, tableMember, `${parentName}${toPascal(jsonName)}`);
      return { kind: "table", tableName };
    }
    return { kind: "string" };
  }

  switch (schema.type) {
    case "string": {
      if (typeof schema.const === "string") {
        const enumName = registerEnum(ctx, schema, [schema.const], jsonName);
        return { kind: "enum", enumName };
      }
      return { kind: "string" };
    }
    case "number":
      return { kind: "double" };
    case "integer":
      return { kind: "int64" };
    case "bigint":
      // Type.BigInt() → EXACT int64 (decoded/encoded as bigint, not number)
      return { kind: "int64", bigint: true };
    case "boolean":
      return { kind: "bool" };
    case "array": {
      const items = schema.items as AnySchema | undefined;
      if (!items) return { kind: "vector-double" };
      if (isObjectLike(items)) {
        const tableName = ensureTable(ctx, items, `${parentName}${toPascal(jsonName)}Item`);
        return { kind: "vector-table", tableName };
      }
      const itemMembers = unionMembers(items);
      if (itemMembers.length > 0 && itemMembers.every(isStringLiteral)) {
        const enumName = registerEnum(ctx, items, itemMembers.map((m) => m.const as string), jsonName);
        return { kind: "vector-enum", enumName };
      }
      switch (items.type) {
        case "string":
          return { kind: "vector-string" };
        case "number":
          return { kind: "vector-double" };
        case "integer":
          return { kind: "vector-int64" };
        case "boolean":
          return { kind: "vector-bool" };
        default:
          return { kind: "vector-double" };
      }
    }
    case "object": {
      if (!isObjectLike(schema)) return { kind: "string" };
      const tableName = ensureTable(ctx, schema, `${parentName}${toPascal(jsonName)}`);
      return { kind: "table", tableName };
    }
    default:
      return { kind: "string" };
  }
}

export function buildModel(
  namedSchemas: Record<string, TSchema>,
  eventSchemas: Record<string, TSchema>,
  controlEventSchemas: Record<string, TSchema> = {},
): Model {
  const ctx: Ctx = {
    named: new Map(),
    used: new Set(),
    enums: [],
    tables: [],
    events: [],
    enumById: new Map(),
    tableById: new Map(),
  };
  for (const [name, schema] of Object.entries(namedSchemas)) {
    ctx.named.set(schema as object, name);
  }
  for (const [name, schema] of Object.entries(eventSchemas)) {
    const tableName = ensureTable(ctx, schema as AnySchema, toPascal(name));
    ctx.events.push({ name, tableName });
  }
  for (const [name, schema] of Object.entries(controlEventSchemas)) {
    const tableName = ensureTable(ctx, schema as AnySchema, toPascal(name));
    ctx.events.push({ name, tableName, control: true });
  }
  return { enums: ctx.enums, tables: ctx.tables, events: ctx.events };
}
