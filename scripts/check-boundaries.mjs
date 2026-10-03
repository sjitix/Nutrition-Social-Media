/**
 * The module boundaries, enforced.   npm run check:boundaries   (add --self-test to prove it fails)
 *
 * `docs/v1/02-module-map.md` describes who may depend on whom. An unenforced boundary is a comment,
 * and this repo has the scar to prove it: a second saved-recipes key was added beside `storage.ts`'s
 * and the two lists drifted apart silently until an audit caught it. This gate turns the map's rules
 * into failures:
 *
 *   rule 1  no module imports ABOVE its layer (L0 contracts ... L6 presentation, §2 of the map)
 *   rule 2  a folder with an index.ts is a module, and only its index may be imported from outside
 *   rule 3  only src/lib/storage.ts may name a storage key or touch localStorage / sessionStorage
 *   rule 4  no client component reaches a server-only module through VALUE imports
 *   rule 5  no import cycles (value imports — what actually executes)
 *   rule 6  no emoji anywhere in src/ (a standing project rule)
 *   rule 0  every file in src/lib has a layer — a new file has to be placed, not left floating
 *
 * HOW IT READS THE CODE. Imports are parsed with the TypeScript compiler (already a dependency), not
 * with regular expressions, so comments and strings cannot fool it. For rules 4 and 5 each file is
 * first TRANSPILED the way the bundler sees it: TypeScript drops an import whose names are only ever
 * used as types, even without the `type` keyword, and a dropped import ships nothing. Measuring the
 * source instead would accuse `import { Meal } from "@/lib/recipeDb"` of shipping 501 recipes.
 *
 * KNOWN DEBT. The code had violations on the day this gate was written; pretending otherwise would
 * have meant either a red gate nobody can ship through or rules weakened to fit. Instead each one is
 * listed in KNOWN_DEBT below with the milestone that removes it. A debt that is still present passes
 * (and is printed, so it stays visible); a NEW violation fails; and a debt that has been PAID also
 * fails until its entry is deleted — so the list can only shrink, and never goes stale.
 *
 * `scripts/` is exempt by name (map §2): a test harness has to reach inside a module to test it.
 */
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ---------------------------------------------------------------------------------------------
// The map, as data. Change it here and in docs/v1/02-module-map.md §2 in the same commit.
// ---------------------------------------------------------------------------------------------

const LAYER_NAMES = ["L0 contracts", "L1 data", "L2 pure computation", "L3 plan engine", "L4 assistant", "L5 adapters", "L6 presentation"];

/** Every file under src/lib, placed. Anything outside src/lib is L6 (it is the app). */
const LIB_LAYERS = {
  "types.ts": 0, "slots.ts": 0,
  "nutrientTable.generated.ts": 1, "substitutions.ts": 1, "symptoms.ts": 1, "conditions.ts": 1,
  "data/": 1, // the recipe seeds and their vocabulary (A2, 2026-10-03); imports nothing
  "nutrients.ts": 2, "targets.ts": 2, "exclusions.ts": 2, "grocery.ts": 2, "streak.ts": 2,
  "recipeDb.ts": 3, // since A3 a one-line barrel over plan/
  "plan/": 3, // the engine, split out of recipeDb.ts (A3, 2026-10-03); index.ts is its public surface
  "primitives.ts": 4, "agentTools.ts": 4, "agentLoop.ts": 4, "reply.ts": 4, "promptV2.ts": 4,
  "ai.ts": 5, "import.ts": 5, "videoImport.ts": 5, "storage.ts": 5, "savedStore.ts": 5, "account/": 5,
  // The fine-tune data pipeline and the API's demo-mode plan: tooling and an adapter that happen to
  // live in src/lib. Placed at L5 so they may use the assistant layer they generate data for.
  "genV2.ts": 5, "dataValidate.ts": 5, "demo.ts": 5,
  "feed.ts": 6, "recipes.ts": 6, "batchGrocery.ts": 6,
};

/**
 * Modules a client component must never reach by value: the engine (501 recipes), the generated
 * USDA table, the assistant, and the adapters that talk to a network or a model. Whatever a client
 * component imports ships to every visitor's browser.
 */
const SERVER_ONLY = new Set([
  "src/lib/recipeDb.ts", "src/lib/nutrientTable.generated.ts",
  "src/lib/primitives.ts", "src/lib/agentTools.ts", "src/lib/agentLoop.ts", "src/lib/promptV2.ts",
  "src/lib/ai.ts", "src/lib/import.ts", "src/lib/videoImport.ts",
  "src/lib/genV2.ts", "src/lib/dataValidate.ts", "src/lib/demo.ts",
]);
// Whole folders that are server-only: the engine (A3 split it out of recipeDb.ts — a client reaching
// "@/lib/plan" would ship it exactly as "@/lib/recipeDb" does) and the 7.7k-line raw seeds.
const SERVER_ONLY_DIRS = ["src/lib/plan/", "src/lib/data/"];
const isServerOnly = (f) => SERVER_ONLY.has(f) || SERVER_ONLY_DIRS.some((d) => f.startsWith(d));

const STORAGE_OWNER = "src/lib/storage.ts";
const STORAGE_GLOBALS = new Set(["localStorage", "sessionStorage"]);
// storage.ts's keys are all "nutriflow.<name>". Narrower than "anything starting nutriflow" on
// purpose: the event "nutriflow:planchanged", the export format tag "nutriflow-export" and the
// download name "nutriflow-<date>.json" are not storage keys, and a gate that cries wolf gets ignored.
// A key in any other shape cannot reach the browser without touching localStorage directly, which
// the second half of rule 3 catches.
const KEY_PATTERN = /^nutriflow\./;

/**
 * Violations that existed when the gate was written, each with the milestone that removes it.
 * Delete an entry the moment its debt is paid — the gate fails until you do.
 */
const KNOWN_DEBT = {
  // rule 4 — the browser payload (milestone A4 is exactly this list)
  "client-server:src/app/sage/explore/ExploreClient.tsx->src/lib/recipeDb.ts":
    "A4 (D4): Explore imports FEED_RECIPES from feed.ts, which carries the whole library. The card projection replaces it.",
  "client-server:src/app/plan/page.tsx->src/lib/recipeDb.ts":
    "A4 (D4) / B2 (D8): the legacy /plan page imports feed.ts the same way. Fixed by the card projection, or retired by the one-app decision.",
  "client-server:src/app/sage/groceries/GroceriesClient.tsx->src/lib/nutrientTable.generated.ts":
    "A4 (D4): found by this gate on its first run. The bulk (meal-prep) grocery list runs in the browser (it is computed from the reader's own week) and needs gramsFor, whose MODULE also holds the 80 kB USDA table. Unverified whether the bundler tree-shakes the table away (gramsFor reads only UNIT_GRAMS) — measure the route's chunks for `fdcId` before fixing. Fix if real: give the unit weights their own module.",
  "client-server:src/app/plan/page.tsx->src/lib/import.ts":
    "B2 (D8) / A6 (D5a): the legacy /plan page imports importedToMeal, a pure converter that lives inside the network adapter with the SSRF guard. Move the converter out, or retire /plan.",
  // rule 1 — layering (milestone A6 moves these pieces to the layer they belong in)
  "layer:src/lib/agentTools.ts->src/lib/feed.ts":
    "A6 (D5a): the assistant's find_recipes uses the Explore feed's filter and sort. Searching the library is engine work: the query moves down to the plan layer, and feed.ts keeps only the card projection.",
  "layer:src/lib/conditions.ts->src/lib/nutrients.ts":
    "A6 (D5a): the micronutrient vocabulary (MICRO_KEYS, MICRO_LABEL, MicroKey) is a contract every layer speaks, not maths. It moves down to L0, and these data tables stop depending on the maths layer.",
  "layer:src/lib/symptoms.ts->src/lib/nutrients.ts":
    "A6 (D5a): the same move as conditions.ts — only the MicroKey type is imported, so it ships nothing, but the dependency still points up.",
  // rule 3 — storage
  "storage-api:src/components/ThemeSwitch.tsx":
    "A6 (D5a): the violet/sage theme toggle stores \"nutriflow-theme\" itself, from before storage.ts's rule. Fix: storage.ts (the accounts lane's file — ask first) owns a `theme` key and exports its name for the pre-hydration boot script.",
};

// ---------------------------------------------------------------------------------------------
// Reading the code
// ---------------------------------------------------------------------------------------------

const scriptKind = (file) => (file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".jsx") ? ts.ScriptKind.JSX : file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** Every module specifier a file names: static imports, re-exports, and dynamic import(). */
function specifiers(sf) {
  const out = [];
  for (const st of sf.statements) {
    if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      let names = [];
      if (ts.isImportDeclaration(st) && st.importClause) {
        const c = st.importClause;
        if (c.name) names.push(c.name.text);
        if (c.namedBindings && ts.isNamedImports(c.namedBindings)) names.push(...c.namedBindings.elements.map((e) => e.name.text));
        if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) names.push("* as " + c.namedBindings.name.text);
      } else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
        names = st.exportClause.elements.map((e) => e.name.text);
      }
      out.push({ spec: st.moduleSpecifier.text, names, line: lineOf(sf, st) });
    }
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      out.push({ spec: node.arguments[0].text, names: ["import()"], line: lineOf(sf, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** What the bundler sees: the file with every type-only import erased. */
function valueSource(file, text) {
  return ts.transpileModule(text, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.Preserve, isolatedModules: true },
  }).outputText;
}

const isClient = (sf) => sf.statements.some((st) => ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression) && st.expression.text === "use client") &&
  // the directive only counts at the top, before any other statement
  (() => { for (const st of sf.statements) { if (!(ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression))) return false; if (st.expression.text === "use client") return true; } return false; })();

function layerOf(file) {
  if (!file.startsWith("src/lib/")) return 6;
  const rest = file.slice("src/lib/".length);
  if (rest in LIB_LAYERS) return LIB_LAYERS[rest];
  const dir = rest.includes("/") ? rest.slice(0, rest.indexOf("/") + 1) : null;
  return dir && dir in LIB_LAYERS ? LIB_LAYERS[dir] : null;
}

// ---------------------------------------------------------------------------------------------
// The check. Pure: a map of { path: source } in, a list of violations out — which is what lets
// --self-test run it on fixtures that are known to be wrong.
// ---------------------------------------------------------------------------------------------

export function check(sources) {
  const files = [...sources.keys()];
  const fileSet = new Set(files);
  const resolveSpec = (spec, from) => {
    let base;
    if (spec.startsWith("@/")) base = "src/" + spec.slice(2);
    else if (spec.startsWith(".")) {
      const parts = from.split("/").slice(0, -1);
      for (const seg of spec.split("/")) { if (seg === "..") parts.pop(); else if (seg !== ".") parts.push(seg); }
      base = parts.join("/");
    } else return null; // a package — not ours to police
    base = base.replace(/\.(js|jsx)$/, "");
    for (const c of [base, base + ".ts", base + ".tsx", base + "/index.ts", base + "/index.tsx"]) if (fileSet.has(c)) return c;
    return null;
  };

  const info = new Map(); // file -> { sf, all: [{to,names,line}], value: [{to,names,line}], client }
  for (const f of files) {
    const text = sources.get(f);
    const sf = parse(f, text);
    const all = specifiers(sf).map((s) => ({ ...s, to: resolveSpec(s.spec, f) })).filter((s) => s.to);
    const vf = f.replace(/\.tsx$/, ".jsx").replace(/\.ts$/, ".js");
    const value = specifiers(parse(vf, valueSource(f, text))).map((s) => ({ ...s, to: resolveSpec(s.spec, f) })).filter((s) => s.to);
    info.set(f, { sf, text, all, value, client: isClient(sf) });
  }

  const violations = [];
  const add = (rule, key, file, message) => violations.push({ rule, key, file, message });

  // rule 0 + rule 1 — layers. Type-only imports count here: depending on a higher layer's TYPES is
  // still depending on that layer, even though nothing ships.
  for (const f of files) {
    const from = layerOf(f);
    if (from === null) {
      add(0, `unclassified:${f}`, f, `${f} has no layer. Place it in LIB_LAYERS (scripts/check-boundaries.mjs) and in docs/v1/02-module-map.md §2 — a module nobody placed is one nobody owns.`);
      continue;
    }
    for (const imp of info.get(f).all) {
      const to = layerOf(imp.to);
      if (to === null || to <= from) continue;
      add(1, `layer:${f}->${imp.to}`, f,
        `${f} (${LAYER_NAMES[from]}) imports ${imp.names.join(", ") || "a module"} from ${imp.to} (${LAYER_NAMES[to]}), line ${imp.line}. ` +
        `Dependencies point down only: a lower layer that needs something from a higher one means that thing is in the wrong layer.`);
    }
  }

  // rule 2 — barrels. A folder holding an index.ts is a module; from outside it, only the index.
  const moduleDirs = files.filter((f) => /\/index\.tsx?$/.test(f)).map((f) => f.slice(0, f.lastIndexOf("/") + 1));
  for (const f of files) {
    for (const imp of info.get(f).all) {
      const dir = moduleDirs.find((d) => imp.to.startsWith(d));
      if (!dir || f.startsWith(dir) || /\/index\.tsx?$/.test(imp.to.slice(dir.length - 1))) continue;
      add(2, `barrel:${f}->${imp.to}`, f,
        `${f} reaches inside the module ${dir} to ${imp.to}, line ${imp.line}. Import from ${dir.slice(0, -1)} (its index) instead — only the index is the contract, everything else may change tonight.`);
    }
  }

  // rule 3 — storage. Read from the syntax tree, so a key mentioned in a comment is not a key.
  const ownerText = sources.get(STORAGE_OWNER);
  const ownedKeys = new Set();
  if (ownerText) {
    const visit = (n) => { if (ts.isStringLiteralLike(n) && KEY_PATTERN.test(n.text)) ownedKeys.add(n.text); ts.forEachChild(n, visit); };
    visit(parse(STORAGE_OWNER, ownerText));
  }
  for (const f of files) {
    if (f === STORAGE_OWNER) continue;
    const { sf } = info.get(f);
    const keys = new Map(); let apiLine = 0;
    const visit = (n) => {
      if ((ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && (KEY_PATTERN.test(n.text) || ownedKeys.has(n.text)) && !keys.has(n.text)) keys.set(n.text, lineOf(sf, n));
      if (ts.isIdentifier(n) && STORAGE_GLOBALS.has(n.text) && !apiLine) apiLine = lineOf(sf, n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    for (const [k, line] of keys) add(3, `storage-key:${f}:${k}`, f,
      `${f} names the storage key "${k}", line ${line}. Only ${STORAGE_OWNER} may name one: a second saved-recipes key once drifted from the first for weeks before anyone noticed. Add the key to storage.ts and call its load/save pair.`);
    if (apiLine) add(3, `storage-api:${f}`, f,
      `${f} touches the browser's storage directly, line ${apiLine}. Go through ${STORAGE_OWNER}, which owns every key and the JSON encoding.`);
  }

  // rule 4 — the browser payload. Breadth-first from each client component over VALUE imports, so
  // the reported chain is the shortest one, which is the one worth reading.
  for (const root of files.filter((f) => info.get(f).client)) {
    const prev = new Map([[root, null]]);
    const queue = [root];
    const hit = new Set();
    while (queue.length) {
      const n = queue.shift();
      if (isServerOnly(n) && n !== root) { hit.add(n); continue; } // report the first server module on a path, not everything behind it
      for (const imp of info.get(n).value) if (!prev.has(imp.to)) { prev.set(imp.to, { from: n, names: imp.names }); queue.push(imp.to); }
    }
    for (const target of hit) {
      const chain = []; let cur = target;
      while (cur) { chain.unshift(cur); cur = prev.get(cur)?.from ?? null; }
      const first = prev.get(chain[1]);
      add(4, `client-server:${root}->${target}`, root,
        `${root} is a client component and reaches ${target} through value imports:\n          ${chain.join("  ->  ")}\n` +
        `        The first hop imports ${first.names.join(", ")}. Everything a client component imports ships to every visitor's browser; ` +
        `the server side has to stay there. Import a client-safe module (a type, or a projection) instead.`);
    }
  }

  // rule 5 — cycles over value imports (Tarjan). A type-only cycle executes nothing.
  {
    let idx = 0; const index = new Map(), low = new Map(), on = new Set(), stack = [];
    const strong = (v) => {
      index.set(v, idx); low.set(v, idx); idx++; stack.push(v); on.add(v);
      for (const { to } of info.get(v).value) {
        if (!index.has(to)) { strong(to); low.set(v, Math.min(low.get(v), low.get(to))); }
        else if (on.has(to)) low.set(v, Math.min(low.get(v), index.get(to)));
      }
      if (low.get(v) === index.get(v)) {
        const comp = []; let w;
        do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
        const selfLoop = info.get(v).value.some((e) => e.to === v);
        if (comp.length > 1 || selfLoop) {
          const members = comp.sort();
          add(5, `cycle:${members.join("|")}`, members[0],
            `These modules import each other in a circle: ${members.join(", ")}. A cycle means neither side can be understood, tested or moved alone, and module-load order starts to matter. Move the shared piece down a layer.`);
        }
      }
    };
    for (const f of files) if (!index.has(f)) strong(f);
  }

  // rule 6 — emoji. Characters that RENDER as emoji: emoji-presentation by default, or a pictograph
  // forced into emoji style by U+FE0F. A typographic check mark or arrow is not one.
  const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u;
  for (const f of files) {
    info.get(f).text.split("\n").forEach((line, i) => {
      const m = line.match(EMOJI);
      if (m) add(6, `emoji:${f}:${i + 1}`, f, `${f} line ${i + 1} contains an emoji (${m[0]}). The UI uses SVG line icons, never emoji — they read as AI-generated (CLAUDE.md, project rules).`);
    });
  }

  const stats = {
    files: files.length,
    imports: files.reduce((t, f) => t + info.get(f).all.length, 0),
    clients: files.filter((f) => info.get(f).client).length,
    modules: moduleDirs.length,
  };
  return { violations, stats };
}

// ---------------------------------------------------------------------------------------------
// Self-test: the gate has to be SEEN to fail. A check that has only ever passed proves nothing
// (WORKPLAN lessons 5 and 6) — so every rule gets a fixture that breaks it on purpose.
// ---------------------------------------------------------------------------------------------

function selfTest() {
  const fixture = new Map(Object.entries({
    "src/lib/types.ts": `export type Meal = { name: string };\nexport const DAYS = ["Monday"];`,
    "src/lib/storage.ts": `const KEYS = { plan: "nutriflow.plan" };\nexport const load = () => localStorage.getItem(KEYS.plan);`,
    "src/lib/recipeDb.ts": `import type { Meal } from "./types";\nexport const RECIPES: Meal[] = [];\nexport type Recipe = Meal;`,
    // rule 1: L0 importing L3
    "src/lib/slots.ts": `import { RECIPES } from "./recipeDb";\nexport const N = RECIPES.length;`,
    // rule 0: a file nobody placed
    "src/lib/mystery.ts": `export const x = 1;`,
    // rule 3: a second key, and direct storage access, outside storage.ts — and a key in a COMMENT, which must NOT count
    "src/app/sage/thing.ts": `// nutriflow.comment is only mentioned here\nexport const K = "nutriflow.saved2";\nexport const v = () => window.localStorage.getItem(K);`,
    // rule 4: a client component that reaches the engine through a middle module...
    "src/lib/feed.ts": `import { RECIPES } from "./recipeDb";\nexport const FEED = RECIPES;`,
    "src/app/sage/Client.tsx": `"use client";\nimport { FEED } from "@/lib/feed";\nexport const C = () => FEED.length;`,
    // ...and one that only imports a TYPE from the engine, which ships nothing and must NOT count
    "src/app/sage/TypeOnly.tsx": `"use client";\nimport { Recipe } from "@/lib/recipeDb";\nexport const T = (r: Recipe) => r.name;`,
    // rule 5: a cycle
    "src/app/a.ts": `import { b } from "./b";\nexport const a = () => b();`,
    "src/app/b.ts": `import { a } from "./a";\nexport const b = () => a();`,
    // rule 2: a module with a barrel, reached around its barrel
    "src/lib/account/index.ts": `export { sync } from "./sync";`,
    "src/lib/account/sync.ts": `export const sync = 1;`,
    "src/app/deep.ts": `import { sync } from "@/lib/account/sync";\nexport const d = sync;`,
    // rule 6
    "src/app/emoji.tsx": `export const E = () => "Done \u{1F389}";`,
  }));
  const { violations } = check(fixture);
  const keys = new Set(violations.map((v) => v.key));
  const expect = [
    ["rule 0 catches an unplaced file", "unclassified:src/lib/mystery.ts", true],
    ["rule 1 catches L0 importing L3", "layer:src/lib/slots.ts->src/lib/recipeDb.ts", true],
    ["rule 2 catches a deep import past a barrel", "barrel:src/app/deep.ts->src/lib/account/sync.ts", true],
    ["rule 3 catches a second storage key", "storage-key:src/app/sage/thing.ts:nutriflow.saved2", true],
    ["rule 3 catches direct localStorage access", "storage-api:src/app/sage/thing.ts", true],
    ["rule 3 ignores a key mentioned in a comment", "storage-key:src/app/sage/thing.ts:nutriflow.comment", false],
    ["rule 4 catches a client component reaching the engine via another module", "client-server:src/app/sage/Client.tsx->src/lib/recipeDb.ts", true],
    ["rule 4 ignores a type-only import (it ships nothing)", "client-server:src/app/sage/TypeOnly.tsx->src/lib/recipeDb.ts", false],
    ["rule 5 catches a cycle", "cycle:src/app/a.ts|src/app/b.ts", true],
    ["rule 6 catches an emoji", "emoji:src/app/emoji.tsx:1", true],
  ];
  let failed = 0;
  for (const [label, key, want] of expect) {
    const ok = keys.has(key) === want;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  }
  // A clean tree must produce nothing at all.
  const clean = check(new Map([["src/lib/types.ts", `export const DAYS = ["Monday"];`], ["src/app/x.ts", `import { DAYS } from "@/lib/types";\nexport const n = DAYS.length;`]]));
  const cleanOk = clean.violations.length === 0;
  if (!cleanOk) failed++;
  console.log(`${cleanOk ? "PASS" : "FAIL"}  a clean tree passes with no violations${cleanOk ? "" : ": " + clean.violations.map((v) => v.key).join(", ")}`);
  console.log(`\n${expect.length + 1 - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------
// Run against the real tree
// ---------------------------------------------------------------------------------------------

if (process.argv.includes("--self-test")) selfTest();

const ROOT = process.cwd();
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !e.endsWith(".d.ts")) out.push(relative(ROOT, p).split("\\").join("/"));
  }
  return out;
};
const sources = new Map(walk(join(ROOT, "src")).map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
const { violations, stats } = check(sources);

const RULE_TITLE = {
  0: "a file in src/lib has no layer", 1: "a module imports above its layer", 2: "a deep import past a module's index",
  3: "storage is touched outside storage.ts", 4: "a client component reaches a server-only module",
  5: "an import cycle", 6: "an emoji in src/",
};

const fresh = violations.filter((v) => !(v.key in KNOWN_DEBT));
const owed = violations.filter((v) => v.key in KNOWN_DEBT);
const seen = new Set(violations.map((v) => v.key));
const paid = Object.keys(KNOWN_DEBT).filter((k) => !seen.has(k));

console.log(`check:boundaries — ${stats.files} files, ${stats.imports} imports, ${stats.clients} client components, ` +
  `${stats.modules} module ${stats.modules === 1 ? "index" : "indexes"}${stats.modules ? "" : " yet (milestone A6 adds them)"}\n`);

for (const v of fresh) console.log(`FAIL  rule ${v.rule} · ${RULE_TITLE[v.rule]}\n      ${v.message}\n`);
for (const k of paid) console.log(`FAIL  a known debt has been PAID — delete its entry from KNOWN_DEBT so the list stays true:\n      ${k}\n`);

if (owed.length) {
  console.log(`KNOWN DEBT — ${owed.length} violation(s) that predate this gate. They pass, and the list may only shrink:`);
  for (const v of owed) console.log(`  rule ${v.rule} · ${v.key}\n      owed to ${KNOWN_DEBT[v.key]}`);
  console.log("");
}

if (fresh.length || paid.length) {
  console.log(`check:boundaries FAILED — ${fresh.length} new violation(s), ${paid.length} paid debt(s) still listed.`);
  process.exit(1);
}
console.log(`check:boundaries passed — no new violations${owed.length ? `, ${owed.length} known debt(s) outstanding` : ""}.`);
