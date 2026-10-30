import fc from "fast-check";
import { dump } from "js-yaml";
import { describe, expect, it } from "vitest";

import { mergeBases, parse } from "./bases-merge";
import { isValidBase, type YamlValue } from "./bases-schema";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function merge(base: string, local: string, remote: string): string | null {
  const merged = mergeBases(encoder.encode(base), encoder.encode(local), encoder.encode(remote));
  return merged === null ? null : decoder.decode(merged);
}

// Examples from https://obsidian.md/help/bases/syntax.
const docsExample = `filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
  formula.formatted_price:
    displayName: "Price"
  file.ext:
    displayName: Extension
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    filters:
      and:
        - 'status != "done"'
        - or:
            - "formula.ppu > 5"
            - "price > 2.1"
    order:
      - file.name
      - file.ext
      - note.age
      - formula.ppu
      - formula.formatted_price
    summaries:
      formula.ppu: Average
`;

const views = (...entries: string[]) => `views:\n${entries.join("")}`;
const view = (name: string, extra = "") => `  - type: table\n    name: ${name}\n${extra}`;

describe("Bases schema", () => {
  it("accepts the documentation's example", () => {
    expect(parse(encoder.encode(docsExample))).not.toBeNull();
  });

  it.each([
    ["a filter object with two operators", "filters:\n  and: []\n  or: []\n"],
    ["a filter object with an unknown operator", "filters:\n  xor: []\n"],
    ["a formula that is not a string", "formulas:\n  a: 1\n"],
    ["a reference to a missing formula", "views:\n  - type: table\n    order:\n      - formula.missing\n"],
    ["a view summary that is neither built in nor defined", "views:\n  - type: table\n    summaries:\n      note.age: Mystery\n"],
    ["a limit that is not a number", "views:\n  - type: table\n    limit: ten\n"],
    ["a sort direction that is unknown", "views:\n  - type: table\n    sort:\n      - property: file.name\n        direction: UP\n"],
    ["views that are not a list", "views:\n  type: table\n"],
    ["a file that is not a mapping", "- a\n- b\n"],
  ])("refuses %s", (_name, text) => {
    expect(parse(encoder.encode(text))).toBeNull();
  });

  it("accepts unknown top-level and view keys of any shape", () => {
    expect(parse(encoder.encode("future: [1, {a: b}]\nviews:\n  - type: map\n    name: M\n    pluginSetting:\n      zoom: 3\n"))).not.toBeNull();
  });

  it("accepts a summary defined in summaries", () => {
    expect(isValidBase({ summaries: { mine: "values.max()" }, views: [{ type: "table", summaries: { "note.age": "mine" } }] })).toBe(true);
  });
});

describe("Bases three-way merge", () => {
  const base = views(view("Books", "    limit: 10\n"), view("Gallery"));

  it("merges one side adding a view with the other editing another view", () => {
    const local = views(view("Books", "    limit: 10\n"), view("Gallery"), view("New"));
    const remote = views(view("Books", "    limit: 25\n"), view("Gallery"));
    expect(parse(encoder.encode(merge(base, local, remote) ?? ""))).toEqual(parse(encoder.encode(views(view("Books", "    limit: 25\n"), view("Gallery"), view("New")))));
  });

  it("refuses both sides changing one view's limit differently", () => {
    expect(merge(base, base.replace("10", "20"), base.replace("10", "30"))).toBeNull();
  });

  it("accepts both sides making the same change", () => {
    const changed = base.replace("10", "20");
    expect(merge(base, changed, changed)).toBe(changed);
  });

  it("refuses one side deleting a formula the other side starts referencing, via validation", () => {
    const withFormula = `formulas:\n  ppu: "price / age"\n${base}`;
    const deleted = base;
    const referenced = `formulas:\n  ppu: "price / age"\n${views(view("Books", "    limit: 10\n    order:\n      - formula.ppu\n"), view("Gallery"))}`;
    expect(merge(withFormula, deleted, referenced)).toBeNull();
    expect(merge(withFormula, referenced, deleted)).toBeNull();
  });

  it("refuses a key deleted on one side and changed on the other", () => {
    expect(merge(base, base.replace("    limit: 10\n", ""), base.replace("10", "20"))).toBeNull();
  });

  it("keeps unknown plugin keys from both sides", () => {
    const local = views(view("Books", "    limit: 10\n    mapZoom: 4\n"), view("Gallery"));
    const remote = `newFeature:\n  enabled: true\n${views(view("Books", "    limit: 10\n"), view("Gallery", "    cardSize: 200\n"))}`;
    const merged = parse(encoder.encode(merge(base, local, remote) ?? ""));
    expect(merged).toEqual({
      newFeature: { enabled: true },
      views: [
        { type: "table", name: "Books", limit: 10, mapZoom: 4 },
        { type: "table", name: "Gallery", cardSize: 200 },
      ],
    });
  });

  it("refuses unparseable YAML on one side", () => {
    expect(merge(base, base.replace("10", "20"), "views: [\n")).toBeNull();
    expect(merge(base, "views:\n\t- bad", base.replace("10", "20"))).toBeNull();
  });

  it("refuses a side that fails the schema, such as newer syntax", () => {
    expect(merge(base, base.replace("10", "20"), `filters:\n  xor: []\n${base}`)).toBeNull();
  });

  it("merges and/or filter lists as sets, ordered by the base, then local, then remote", () => {
    const filters = (...items: string[]) => `filters:\n  and:\n${items.map((item) => `    - ${item}\n`).join("")}`;
    const merged = merge(filters("a", "b", "c"), filters("b", "c", "d"), filters("a", "b", "e"));
    expect(parse(encoder.encode(merged ?? ""))).toEqual({ filters: { and: ["b", "d", "e"] } });
  });

  it("refuses two different changes to an ordered list", () => {
    const ordered = (...items: string[]) => views(`  - type: table\n    name: T\n    order:\n${items.map((item) => `      - ${item}\n`).join("")}`);
    expect(merge(ordered("a", "b"), ordered("b", "a"), ordered("a", "b", "c"))).toBeNull();
  });

  it("treats views without unique names as one value", () => {
    const unnamed = "views:\n  - type: table\n    limit: 1\n  - type: cards\n";
    expect(merge(unnamed, unnamed.replace("limit: 1", "limit: 2"), `${unnamed}  - type: list\n`)).toBeNull();
    expect(merge(unnamed, unnamed, unnamed.replace("limit: 1", "limit: 2"))).toBe(unnamed.replace("limit: 1", "limit: 2"));
  });

  it("returns an unchanged side's bytes exactly, comments included", () => {
    const commented = `# my base\n${base}`;
    const local = `# my base, edited\n${base.replace("10", "20")}  # trailing\n`;
    expect(merge(commented, local, commented)).toBe(local);
  });

  it("writes the documentation's example back as the same YAML value when merged", () => {
    const local = docsExample.replace("limit: 10", "limit: 50");
    const remote = docsExample.replace("    displayName: Extension\n", "    displayName: Extension\n  note.age:\n    displayName: Age\n");
    const merged = parse(encoder.encode(merge(docsExample, local, remote) ?? ""));
    expect(merged).toEqual({ ...parse(encoder.encode(remote)), views: parse(encoder.encode(local))?.["views"] });
  });
});

const formulaNames = ["f1", "f2", "f3"];
const viewNames = ["Alpha", "Beta", "Gamma", "Delta"];

/** A valid base drawn from small pools, so independent draws overlap. */
const validBase = fc
  .record(
    {
      formulas: fc.uniqueArray(fc.constantFrom(...formulaNames)).map((names) => Object.fromEntries(names.map((name) => [name, `price * ${String(name.length)}`]))),
      filters: fc.record({ and: fc.uniqueArray(fc.constantFrom('status != "done"', "price > 1", 'file.hasTag("book")')) }),
      views: fc.uniqueArray(
        fc.record(
          {
            type: fc.constantFrom("table", "cards"),
            name: fc.constantFrom(...viewNames),
            limit: fc.integer({ min: 0, max: 3 }),
            order: fc.uniqueArray(fc.constantFrom("file.name", "note.age", ...formulaNames.map((name) => `formula.${name}`)), { maxLength: 3 }),
            pluginKey: fc.constantFrom("x", "y"),
          },
          { requiredKeys: ["type", "name"] },
        ),
        { selector: (view) => view.name, maxLength: 4 },
      ),
    },
    { requiredKeys: [] },
  )
  .filter((value) => isValidBase(value))
  .map((value) => dump(value));

/** Order-insensitive form for views (by name) and filter sets, with which side's additions come first not mattering. */
function normalized(text: string): YamlValue {
  const sort = (value: YamlValue, key?: string): YamlValue => {
    if (Array.isArray(value)) {
      const items = value.map((item) => sort(item));
      if (key === "and" || key === "or") return items.map((item) => JSON.stringify(item)).sort();
      if (key === "views") return [...items].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      return items;
    }
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([name, item]) => [name, sort(item, name)]));
  };
  return sort(parse(encoder.encode(text)));
}

describe("Bases three-way merge properties", () => {
  it("merge(base, x, base) is x", () => {
    fc.assert(fc.property(validBase, validBase, (base, x) => merge(base, x, base) === x));
  });

  it("merge(base, x, x) is x", () => {
    fc.assert(fc.property(validBase, validBase, (base, x) => merge(base, x, x) === x));
  });

  it("the merged result always validates", () => {
    fc.assert(
      fc.property(validBase, validBase, validBase, (base, local, remote) => {
        const merged = merge(base, local, remote);
        return merged === null || parse(encoder.encode(merged)) !== null;
      }),
    );
  });

  it("is symmetric, up to the order of each side's additions", () => {
    fc.assert(
      fc.property(validBase, validBase, validBase, (base, local, remote) => {
        const forward = merge(base, local, remote);
        const backward = merge(base, remote, local);
        if (forward === null || backward === null) return forward === backward;
        expect(normalized(forward)).toEqual(normalized(backward));
        return true;
      }),
    );
  });
});
