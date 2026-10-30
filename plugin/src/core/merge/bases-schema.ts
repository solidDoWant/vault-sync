// Schema and semantic checks for Obsidian Bases (`.base`) files.
//
// Obsidian documents the format only in prose; this schema is written from
// https://obsidian.md/help/bases/syntax (checked 2026-10-30). It is strict on
// the types and shapes of the documented keys and permissive on unknown keys:
// plugins add view keys and newer Obsidian versions add features, so an
// unknown key is accepted as any value and kept by the merge.

/** A parsed YAML value. */
export type YamlValue = null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue };

/** A YAML mapping. */
export type YamlMap = { [key: string]: YamlValue };

/** The summaries Obsidian provides without a `summaries` entry. */
export const builtinSummaries: ReadonlySet<string> = new Set([
  "Average",
  "Min",
  "Max",
  "Sum",
  "Range",
  "Median",
  "Stddev",
  "Earliest",
  "Latest",
  "Checked",
  "Unchecked",
  "Empty",
  "Filled",
  "Unique",
]);

/** The filter object keys, of which a filter object has exactly one. */
const filterOperators = ["and", "or", "not"];

/** Above this many values a parsed file is refused, bounding the merge's work (YAML aliases can repeat a subtree). */
const maxNodes = 100_000;

class Invalid extends Error {}

export function isMap(value: unknown): value is YamlMap {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * Whether `value`, a parsed `.base` file, follows the schema and its
 * semantic checks: every `formula.<name>` it references exists in
 * `formulas`, every summary a view names is built in or in `summaries`, and
 * every filter object has exactly one of `and`, `or` and `not`.
 */
export function isValidBase(value: unknown): value is YamlMap {
  try {
    countNodes(value);
    checkBase(value);
    return true;
  } catch (error) {
    if (error instanceof Invalid) return false;
    throw error;
  }
}

function fail(): never {
  throw new Invalid();
}

function countNodes(root: unknown): void {
  let count = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (++count > maxNodes) fail();
    if (Array.isArray(value)) stack.push(...(value as unknown[]));
    else if (isMap(value)) stack.push(...Object.keys(value), ...Object.values(value));
    else if (!(value === null || ["string", "number", "boolean"].includes(typeof value))) fail();
  }
}

function checkBase(value: unknown): void {
  if (!isMap(value)) fail();
  const references: string[] = [];
  const formulas = optionalMap(value, "formulas");
  for (const expression of Object.values(formulas)) references.push(string(expression));
  const properties = optionalMap(value, "properties");
  for (const property of Object.values(properties)) {
    if (!isMap(property)) fail();
    if ("displayName" in property) string(property["displayName"]);
  }
  const summaries = optionalMap(value, "summaries");
  for (const formula of Object.values(summaries)) references.push(string(formula));
  if ("filters" in value) checkFilter(value["filters"], references);
  if ("views" in value) {
    const views = value["views"];
    if (!Array.isArray(views)) fail();
    for (const view of views) checkView(view, summaries, references);
  }
  for (const text of references) {
    for (const match of text.matchAll(/\bformula\.([\p{L}\p{N}_]+)/gu)) {
      if (!Object.hasOwn(formulas, match[1] ?? "")) fail();
    }
  }
}

function checkView(view: unknown, summaries: YamlMap, references: string[]): void {
  if (!isMap(view)) fail();
  string(view["type"]);
  if ("name" in view) string(view["name"]);
  if ("filters" in view) checkFilter(view["filters"], references);
  if ("groupBy" in view) {
    const groupBy = view["groupBy"];
    if (!isMap(groupBy)) fail();
    references.push(string(groupBy["property"]));
    if ("direction" in groupBy) direction(groupBy["direction"]);
  }
  if ("groupOrder" in view) stringList(view["groupOrder"]);
  if ("summaries" in view) {
    const viewSummaries = view["summaries"];
    if (!isMap(viewSummaries)) fail();
    for (const [property, summary] of Object.entries(viewSummaries)) {
      references.push(property);
      const name = string(summary);
      if (!builtinSummaries.has(name) && !Object.hasOwn(summaries, name)) fail();
    }
  }
  if ("limit" in view) {
    const limit = view["limit"];
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) fail();
  }
  if ("order" in view) references.push(...stringList(view["order"]));
  if ("sort" in view) {
    const sort = view["sort"];
    if (!Array.isArray(sort)) fail();
    for (const entry of sort) {
      if (!isMap(entry)) fail();
      references.push(string(entry["property"]));
      if ("direction" in entry) direction(entry["direction"]);
    }
  }
}

function checkFilter(filter: unknown, references: string[]): void {
  if (typeof filter === "string") {
    references.push(filter);
    return;
  }
  if (!isMap(filter)) fail();
  const operators = Object.keys(filter);
  const operator = operators[0] ?? "";
  if (operators.length !== 1 || !filterOperators.includes(operator)) fail();
  const statements = filter[operator];
  if (!Array.isArray(statements)) fail();
  for (const statement of statements) checkFilter(statement, references);
}

function optionalMap(value: YamlMap, key: string): YamlMap {
  if (!(key in value)) return {};
  const map = value[key];
  if (!isMap(map)) fail();
  return map;
}

function string(value: unknown): string {
  if (typeof value !== "string") fail();
  return value;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) fail();
  return value.map(string);
}

function direction(value: unknown): void {
  if (value !== "ASC" && value !== "DESC") fail();
}
