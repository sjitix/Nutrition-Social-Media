/**
 * The module boundaries, enforced.   npm run check:boundaries   (add --self-test to prove it fails)
 *
 * `docs/v1/02-module-map.md` describes who may depend on whom. An unenforced boundary is a comment,
 * and this repo has the scar to prove it: a second saved-recipes key was added beside `storage.ts`'s
 * and the two lists drifted apart silently until an audit caught it. This gate turns the map's rules
 * into failures:
 *
 *   rule 1  no module imports ABOVE its layer (L0 contracts ... L6 presentation, §2 of the map)
 *   rule 2  a folder with an index.ts is a module, and only its entry points may be imported from
 *           outside — and src/ may not import the old flat paths D5a left behind
 *   rule 3  only src/lib/storage.ts may name a storage key or touch localStorage / sessionStorage
 *   rule 4  no client component, and no browser-safe client.ts entry, reaches a server-only module
 *           or a server-only package (zod, the Anthropic SDK) through VALUE imports
 *   rule 5  no import cycles (value imports — what actually executes)
 *   rule 6  no emoji anywhere in src/ (a standing project rule)
 *   rule 7  every local import resolves — a path the gate cannot follow is a path it cannot check
 *   rule 8  nothing depends on running at import time (package.json tells the bundler it may drop an
 *           unused module, so an effect it relied on would vanish silently)
 *   rule 0  every file in src/lib has a layer — a new file has to be placed, not left floating
 *
 * HOW IT READS THE CODE. Imports are parsed with the TypeScript compiler (already a dependency), not
 * with regular expressions, so comments and strings cannot fool it, and they are RESOLVED with
 * TypeScript's own resolver under tsconfig.json — so "@/lib/plan/", "@/lib/./recipeDb" and
 * "../lib/plan" all land on the file the bundler would load, not on a string the gate failed to
 * match. (A home-made resolver missed all three, and require(), until the D5a review, 2026-10-03.)
 * For rules 4 and 5 each file is first TRANSPILED the way the bundler sees it: TypeScript drops an
 * import whose names are only ever used as types, even without the `type` keyword, and a dropped
 * import ships nothing. Measuring the source instead would accuse `import { Meal } from
 * "@/lib/recipeDb"` of shipping 501 recipes. Rules 1 and 2 read the SOURCE, type positions included
 * (`import("x").T` too): depending on a module's types is still depending on the module.
 *
 * KNOWN DEBT. The code had violations on the day this gate was written; pretending otherwise would
 * have meant either a red gate nobody can ship through or rules weakened to fit. Instead each one is
 * listed in KNOWN_DEBT below with the milestone that removes it. A debt that is still present passes
 * (and is printed, so it stays visible); a NEW violation fails; and a debt that has been PAID also
 * fails until its entry is deleted — so the list can only shrink, and never goes stale. A debt may
 * also name the exact imports it covers, so the import cannot quietly grow behind it.
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

/**
 * Every file under src/lib, placed. Anything outside src/lib is L6 (it is the app).
 *
 * A folder's layer covers every file in it unless a file is placed on its own. A file placed BELOW
 * its folder is held to that lower layer for what IT imports (rule 1) — it stays reachable only
 * through its folder's entry points like every other file there (rule 2), so a lower layer that
 * comes to need it has to move it into a folder at its own layer, not reach around the door.
 */
const LIB_LAYERS = {
  // The folders (V1 D5a, 2026-10-03).
  "core/": 0, // types, slots, micros, imported, defaults: the shared vocabulary
  "data/": 1, // seeds, ingredient identity, the USDA table, symptoms, substitutions, conditions
  "nutrition/": 2, // units, nutrients, targets, exclusions, safety, grocery: the maths
  "nutrition/unitGrams.generated.ts": 1, // grams per unit — plain data, kept beside units.ts so the browser-safe entry carries it (A4)
  "plan/": 3, // the engine (A3); index.ts is its public surface
  "assistant/": 4, // primitives, the read surface, the loop, reply, the prompt
  "providers/": 5, // the model provider, URL import, video import
  "presentation/": 6, // feed + feedFilter, recipes (imagery), batchGrocery, streak
  "presentation/streak.ts": 2, // local-day arithmetic: holds itself to pure computation, though only presentation's doors reach it
  "recipeDb.ts": 3, // since A3 a barrel over plan/
  "storage.ts": 5, "savedStore.ts": 5, "account/": 5, // the accounts lane's; persistence/ when they agree
  // The fine-tune data pipeline and the API's demo-mode plan: tooling and an adapter that happen to
  // live in src/lib. Placed at L5 so they may use the assistant layer they generate data for.
  "genV2.ts": 5, "dataValidate.ts": 5, "demo.ts": 5,
  // The re-exports left at the old paths by D5a, each at its target's layer. They go once every lane
  // has moved to the new paths.
  "types.ts": 0, "slots.ts": 0,
  "nutrientTable.generated.ts": 1, "substitutions.ts": 1, "symptoms.ts": 1, "conditions.ts": 1, "unitGrams.generated.ts": 1,
  "units.ts": 2, "safety.ts": 2, "nutrients.ts": 2, "targets.ts": 2, "exclusions.ts": 2, "grocery.ts": 2, "streak.ts": 2,
  "primitives.ts": 4, "agentTools.ts": 4, "agentLoop.ts": 4, "reply.ts": 4, "promptV2.ts": 4,
  "ai.ts": 5, "import.ts": 5, "videoImport.ts": 5,
  "feed.ts": 6, "feedFilter.ts": 6, "recipes.ts": 6, "batchGrocery.ts": 6,
};

/**
 * Modules a client component must never reach by value: the engine (501 recipes), the generated
 * USDA table, the assistant, and the adapters that talk to a network or a model. Whatever a client
 * component imports ships to every visitor's browser.
 */
const SERVER_ONLY = new Set([
  "src/lib/recipeDb.ts", "src/lib/genV2.ts", "src/lib/dataValidate.ts", "src/lib/demo.ts",
  // the old paths (D5a re-exports), so a client import of one is caught at the first step
  "src/lib/nutrientTable.generated.ts", "src/lib/primitives.ts", "src/lib/agentTools.ts", "src/lib/agentLoop.ts",
  "src/lib/promptV2.ts", "src/lib/reply.ts", "src/lib/ai.ts", "src/lib/import.ts", "src/lib/videoImport.ts",
]);
// Whole folders that are server-only: the engine (A3 split it out of recipeDb.ts — a client reaching
// "@/lib/plan" would ship it exactly as "@/lib/recipeDb" does), data/ (the 7.7k-line raw seeds and the
// USDA table), the assistant (its index says "server only"; listing four of its files by name left the
// fifth, reply.ts, open), and providers/ (a model, a network fetch, the SSRF guard). A server-only
// folder has no browser entry: a client.ts inside one is not a door (rule 2).
const SERVER_ONLY_DIRS = ["src/lib/plan/", "src/lib/data/", "src/lib/assistant/", "src/lib/providers/"];
const isServerOnly = (f) => SERVER_ONLY.has(f) || SERVER_ONLY_DIRS.some((d) => f.startsWith(d));
/**
 * Packages that must never reach the browser. zod is the reason core/client.ts exists: every schema
 * lives in core/types.ts, and the whole library ships with the first value imported from it.
 */
const SERVER_ONLY_PACKAGES = new Set(["zod", "@anthropic-ai/sdk", "typescript"]);

/**
 * package.json's "sideEffects": the promise to the bundler that only stylesheets do anything just by
 * being imported, which is what lets it drop the parts of a barrel nobody uses (3–7 kB a route,
 * measured). Rule 8 holds the code to that promise, and fails if the field drifts from it.
 */
const SIDE_EFFECTS = ["*.css"];

const STORAGE_OWNER = "src/lib/storage.ts";
const STORAGE_GLOBALS = new Set(["localStorage", "sessionStorage"]);
// storage.ts's keys are all "nutriflow.<name>". Narrower than "anything starting nutriflow" on
// purpose: the event "nutriflow:planchanged", the export format tag "nutriflow-export" and the
// download name "nutriflow-<date>.json" are not storage keys, and a gate that cries wolf gets ignored.
// A key in any other shape cannot reach the browser without touching localStorage directly, which
// the second half of rule 3 catches.
const KEY_PATTERN = /^nutriflow\./;

/**
 * Violations that existed when the gate (or the rule) was written, each with the milestone that
 * removes it. Delete an entry the moment its debt is paid — the gate fails until you do. An entry
 * written as { names, why } covers only an import of exactly those names: anything more is new.
 */
const KNOWN_DEBT = {
  // rule 4 — the browser payload (milestone A4 is exactly this list)
  "client-server:src/app/plan/page.tsx->src/lib/recipeDb.ts":
    "A4 (D4) / B2 (D8): the legacy /plan page imports feed.ts the same way. Fixed by the card projection, or retired by the one-app decision.",
  // rule 1 — layering (milestone A6 moves these pieces to the layer they belong in)
  "layer:src/lib/assistant/agentTools.ts->src/lib/presentation/index.ts": {
    names: ["FEED_RECIPES", "filterFeed", "sortFeed", "FeedSort"],
    why: "A6 (D5a): the assistant's find_recipes uses the Explore feed's filter and sort. Searching the library is engine work: the query moves down to the plan layer, and feed.ts keeps only the card projection.",
  },
  // rule 3 — storage
  "storage-api:src/components/ThemeSwitch.tsx":
    "A6 (D5a): the violet/sage theme toggle stores \"nutriflow-theme\" itself, from before storage.ts's rule. Fix: storage.ts (the accounts lane's file — ask first) owns a `theme` key and exports its name for the pre-hydration boot script.",
  // rule 2 — the old flat paths, still imported by the accounts lane's files (their lane, their move)
  "old-path:src/lib/storage.ts->src/lib/types.ts": "the accounts lane: import from ./core/client (or ./core for the schemas) — asked in lane-v1.md.",
  "old-path:src/lib/storage.ts->src/lib/import.ts": "the accounts lane: ImportedRecipe is in ./core/client since D5a part 2.",
  "old-path:src/lib/account/validate.ts->src/lib/slots.ts": "the accounts lane: DAYS and MEAL_TYPES are in ../core/client.",
};

// ---------------------------------------------------------------------------------------------
// Reading the code
// ---------------------------------------------------------------------------------------------

const SCRIPT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const scriptKind = (file) => (file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".jsx") ? ts.ScriptKind.JSX : /\.(js|mjs|cjs)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/**
 * Every module a file names: static imports and re-exports, `import x = require()`, dynamic
 * import(), require(), type positions (`import("x").T`) and triple-slash references. A dynamic
 * import or require whose argument is not a plain string is recorded as `dynamic` — nobody can
 * check where it goes, so rule 7 fails it.
 */
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
      out.push({ spec: st.moduleSpecifier.text, names, line: lineOf(sf, st), bare: ts.isImportDeclaration(st) && !st.importClause });
    } else if (ts.isImportEqualsDeclaration(st) && ts.isExternalModuleReference(st.moduleReference) && ts.isStringLiteralLike(st.moduleReference.expression)) {
      out.push({ spec: st.moduleReference.expression.text, names: [st.name.text], line: lineOf(sf, st) });
    }
  }
  for (const r of sf.referencedFiles) out.push({ spec: r.fileName.startsWith(".") ? r.fileName : "./" + r.fileName, names: ["/// <reference>"], line: sf.getLineAndCharacterOfPosition(r.pos).line + 1 });
  const visit = (node) => {
    const isImportCall = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require";
    if (isImportCall || isRequire) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) out.push({ spec: arg.text, names: [isImportCall ? "import()" : "require()"], line: lineOf(sf, node) });
      else out.push({ spec: null, dynamic: true, names: [isImportCall ? "import()" : "require()"], line: lineOf(sf, node) });
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      out.push({ spec: node.argument.literal.text, names: [node.qualifier ? node.qualifier.getText(sf) : "import(type)"], line: lineOf(sf, node) });
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

const isClient = (sf) => {
  // the directive only counts in the prologue, before any other statement
  for (const st of sf.statements) {
    if (!(ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression))) return false;
    if (st.expression.text === "use client") return true;
  }
  return false;
};

function layerOf(file) {
  if (!file.startsWith("src/lib/")) return 6;
  const rest = file.slice("src/lib/".length);
  if (rest in LIB_LAYERS) return LIB_LAYERS[rest];
  const dir = rest.includes("/") ? rest.slice(0, rest.indexOf("/") + 1) : null;
  return dir && dir in LIB_LAYERS ? LIB_LAYERS[dir] : null;
}

const packageName = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
const normalise = (p) => {
  const parts = [];
  for (const seg of p.split("/")) { if (seg === "..") parts.pop(); else if (seg && seg !== ".") parts.push(seg); }
  return parts.join("/");
};

/** tsconfig.json's compiler options, read once, without scanning the disk for its file list. */
let compilerOptions = null;
function tsOptions(root) {
  if (!compilerOptions) {
    const raw = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
    if (raw.error) throw new Error("check:boundaries cannot read tsconfig.json: " + ts.flattenDiagnosticMessageText(raw.error.messageText, "\n"));
    compilerOptions = ts.parseJsonConfigFileContent(raw.config, { ...ts.sys, readDirectory: () => [] }, root).options;
  }
  return compilerOptions;
}

/**
 * TypeScript's resolver over an in-memory tree: the same answer `tsc` and the editor give, computed
 * against the files handed to check() rather than the disk, which is what lets the self-test resolve
 * fixtures. Returns { to } for a source file, { asset } for a stylesheet or JSON file, { pkg } for a
 * package, or { unresolved } for a local path that lands on nothing.
 */
function makeResolver(fileSet, assets) {
  const root = process.cwd().split("\\").join("/");
  const options = tsOptions(process.cwd());
  const known = new Set([...fileSet, ...assets]);
  const dirs = new Set([""]);
  for (const f of known) for (let p = f; p.includes("/");) { p = p.slice(0, p.lastIndexOf("/")); dirs.add(p); }
  // TypeScript asks about "src/lib/plan/" with the slash when an import is spelled with one
  const rel = (p) => { p = p.split("\\").join("/").replace(/\/+$/, ""); return p === root ? "" : p.startsWith(root + "/") ? p.slice(root.length + 1) : null; };
  const host = {
    fileExists: (p) => { const r = rel(p); return r !== null && known.has(r); },
    directoryExists: (p) => { const r = rel(p); return r !== null && dirs.has(r); },
    readFile: () => undefined,
    realpath: (p) => p,
    getCurrentDirectory: () => root,
    getDirectories: () => [],
  };
  const cache = new Map();
  return (spec, from) => {
    const key = spec + "\0" + from.slice(0, from.lastIndexOf("/"));
    if (cache.has(key)) return cache.get(key);
    const local = spec.startsWith("@/") || spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
    const hit = ts.resolveModuleName(spec, root + "/" + from, options, host).resolvedModule;
    const got = hit ? rel(hit.resolvedFileName) : null;
    let out;
    if (got !== null && fileSet.has(got)) out = { to: got };
    else if (got !== null && assets.has(got)) out = { asset: got };
    else if (!local) out = { pkg: packageName(spec) };
    else {
      // a stylesheet: TypeScript does not resolve one, the bundler does — so look for the file itself
      const plain = normalise(spec.startsWith("@/") ? "src/" + spec.slice(2) : from.slice(0, from.lastIndexOf("/")) + "/" + spec);
      out = assets.has(plain) ? { asset: plain } : { unresolved: true };
    }
    cache.set(key, out);
    return out;
  };
}

// ---------------------------------------------------------------------------------------------
// The check. Pure: a map of { path: source } in, a list of violations out — which is what lets
// --self-test run it on fixtures that are known to be wrong. `assets` are the non-script files under
// src/ (stylesheets); `packageJson`, when given, is checked against SIDE_EFFECTS.
// ---------------------------------------------------------------------------------------------

export function check(sources, { assets = new Set(), packageJson } = {}) {
  const files = [...sources.keys()];
  const fileSet = new Set(files);
  const resolve = makeResolver(fileSet, assets);

  const violations = [];
  const add = (rule, key, file, message, names) => violations.push({ rule, key, file, message, names });

  const info = new Map(); // file -> { sf, text, all, value, pkgs, client }
  for (const f of files) {
    const text = sources.get(f);
    const sf = parse(f, text);
    const all = [];
    for (const s of specifiers(sf)) {
      if (s.dynamic) {
        add(7, `dynamic:${f}:${s.line}`, f, `${f} line ${s.line} calls ${s.names[0]} with a computed path. Nobody — this gate, the editor, a reviewer — can see where that goes. Name the module as a plain string.`);
        continue;
      }
      const r = resolve(s.spec, f);
      if (r.unresolved) add(7, `unresolved:${f}->${s.spec}`, f, `${f} line ${s.line} imports "${s.spec}", which resolves to no file. A path the gate cannot follow is a path it cannot check.`);
      if (r.to) all.push({ ...s, to: r.to });
      if (r.to && s.bare) add(8, `bare-import:${f}->${r.to}`, f,
        `${f} line ${s.line} imports ${r.to} only for its effect. package.json tells the bundler that only *.css runs on import, so this import may be dropped without a word. Import a name and call it.`);
    }
    const vf = f.replace(/\.tsx$/, ".jsx").replace(/\.ts$/, ".js");
    const value = [], pkgs = [];
    for (const s of specifiers(parse(vf, valueSource(f, text)))) {
      if (s.dynamic) continue;
      const r = resolve(s.spec, f);
      if (r.to) value.push({ ...s, to: r.to });
      else if (r.pkg) pkgs.push({ ...s, pkg: r.pkg });
    }
    info.set(f, { sf, text, all, value, pkgs, client: isClient(sf) });
  }

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
        `Dependencies point down only: a lower layer that needs something from a higher one means that thing is in the wrong layer.`, imp.names);
    }
  }

  // rule 2 — entry points. A folder holding an index.ts is a module; from outside it, only its entry
  // points: index.ts (the whole surface) and client.ts (the browser-safe subset, map §6) — and a
  // client.ts counts only when it is a pure re-export barrel in a folder that is not server-only, so
  // a file that merely happens to be called client.ts (account/client.ts is the sync glue) is not a
  // door. Matched EXACTLY: a client.ts one folder deeper is not the module's entry.
  //
  // The re-exports D5a left at the old flat paths exist only so other lanes' imports keep working
  // until they move. A shim is recognised by its parsed shape — leading comments and exactly one
  // `export * from "./<folder>/<file>"` — not by name and not by a regex over its text (a lone CR
  // ends a // comment for the parser but not for a regex, which let a look-alike carry code). Each
  // shim re-exports a whole inner file, private names included, so importing one from src/ is
  // reaching past a barrel by its old name: that is rule 2 too, and only the listed debts may.
  const dirOf = (f) => f.slice(0, f.lastIndexOf("/") + 1);
  const moduleDirs = files.filter((f) => /\/index\.(ts|tsx|js|jsx)$/.test(f)).map(dirOf);
  const isBarrel = (f) => { const { sf } = info.get(f); return sf.statements.length > 0 && sf.statements.every((st) => ts.isExportDeclaration(st) && st.moduleSpecifier); };
  const isEntry = (dir, to) => [".ts", ".tsx"].some((x) => to === dir + "index" + x) ||
    ([".ts", ".tsx"].some((x) => to === dir + "client" + x) && isBarrel(to) && !isServerOnly(to));
  const shimTarget = (f) => {
    if (!/^src\/lib\/[^/]+\.ts$/.test(f)) return null;
    const { sf, text } = info.get(f);
    if (sf.parseDiagnostics?.length || sf.statements.length !== 1) return null;
    const st = sf.statements[0];
    if (!ts.isExportDeclaration(st) || st.exportClause || st.isTypeOnly || !ts.isStringLiteral(st.moduleSpecifier) || !/^\.\/[^/]+\/[^/]+$/.test(st.moduleSpecifier.text)) return null;
    if (!/^\/\/ Moved to /.test(text.slice(0, st.getStart(sf)))) return null;
    return info.get(f).all[0]?.to ?? null;
  };
  const shims = new Map(files.map((f) => [f, shimTarget(f)]).filter(([, t]) => t));
  for (const f of files) {
    if (shims.has(f)) continue;
    for (const imp of info.get(f).all) {
      if (shims.has(imp.to)) {
        const target = shims.get(imp.to);
        const door = moduleDirs.find((d) => target.startsWith(d));
        add(2, `old-path:${f}->${imp.to}`, f,
          `${f} imports the old flat path ${imp.to}, line ${imp.line} — a D5a re-export of the whole of ${target}, private names included, kept only until the other lanes move. ` +
          `Import from ${door ? door.slice(0, -1) + " (or " + door + "client)" : "the folder's index"} instead.`, imp.names);
        continue;
      }
      const dir = moduleDirs.find((d) => imp.to.startsWith(d) && !f.startsWith(d) && !isEntry(d, imp.to));
      if (!dir) continue;
      add(2, `barrel:${f}->${imp.to}`, f,
        `${f} reaches inside the module ${dir} to ${imp.to}, line ${imp.line}. Import from ${dir.slice(0, -1)} (its index) instead — only the index is the contract, everything else may change tonight.`, imp.names);
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

  // rule 4 — the browser payload. Breadth-first over VALUE imports from each client component, and
  // from each browser-safe client.ts entry whether or not a component imports it yet (its promise is
  // what makes it safe to import), so the reported chain is the shortest one, which is the one worth
  // reading. A server-only package counts the same as a server-only module.
  const clientEntries = moduleDirs.flatMap((d) => [d + "client.ts", d + "client.tsx"]).filter((f) => fileSet.has(f) && isEntry(dirOf(f), f));
  const roots = [...files.filter((f) => info.get(f).client).map((f) => [f, "client-server", "a client component"]),
    ...clientEntries.map((f) => [f, "client-barrel", "a browser-safe entry"])];
  for (const [root, tag, what] of roots) {
    const prev = new Map([[root, null]]);
    const queue = [root];
    const hit = new Set();
    while (queue.length) {
      const n = queue.shift();
      if (isServerOnly(n) && n !== root) { hit.add(n); continue; } // report the first server module on a path, not everything behind it
      for (const p of info.get(n).pkgs) if (SERVER_ONLY_PACKAGES.has(p.pkg)) { const k = "package " + p.pkg; if (!prev.has(k)) prev.set(k, { from: n, names: p.names }); hit.add(k); }
      for (const imp of info.get(n).value) if (!prev.has(imp.to)) { prev.set(imp.to, { from: n, names: imp.names }); queue.push(imp.to); }
    }
    for (const target of hit) {
      const chain = []; let cur = target;
      while (cur) { chain.unshift(cur); cur = prev.get(cur)?.from ?? null; }
      const first = prev.get(chain[1]);
      add(4, `${tag}:${root}->${target.replace(/^package /, "")}`, root,
        `${root} is ${what} and reaches ${target} through value imports:\n          ${chain.join("  ->  ")}\n` +
        `        The first hop imports ${first.names.join(", ")}. Everything a client component imports ships to every visitor's browser; ` +
        `the server side has to stay there. Import a client-safe module (a type, a client.ts entry, or a projection) instead.`);
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

  // rule 8 — import-time effects (the bare-import half is above, where imports are resolved). The
  // library's top level holds declarations only: a statement that DOES something when the module
  // loads is an effect the bundler is entitled to drop. A module-local table can be built inside a
  // const initialiser, where it travels with the export that uses it.
  const DECLARATION = new Set([ts.SyntaxKind.ImportDeclaration, ts.SyntaxKind.ImportEqualsDeclaration, ts.SyntaxKind.ExportDeclaration,
    ts.SyntaxKind.ExportAssignment, ts.SyntaxKind.VariableStatement, ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.ClassDeclaration,
    ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.EnumDeclaration, ts.SyntaxKind.ModuleDeclaration,
    ts.SyntaxKind.EmptyStatement]);
  for (const f of files.filter((f) => f.startsWith("src/lib/"))) {
    const { sf } = info.get(f);
    let prologue = true;
    for (const st of sf.statements) {
      if (prologue && ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression)) continue;
      prologue = false;
      if (DECLARATION.has(st.kind)) continue;
      add(8, `effect:${f}:${lineOf(sf, st)}`, f,
        `${f} line ${lineOf(sf, st)} runs a statement when the module loads. package.json tells the bundler only *.css has import-time effects, so it may drop this module where nothing uses its exports. Move the work into a const initialiser or a function.`);
    }
  }
  if (packageJson !== undefined && JSON.stringify(packageJson.sideEffects) !== JSON.stringify(SIDE_EFFECTS)) {
    add(8, "side-effects-field", "package.json",
      `package.json's "sideEffects" is ${JSON.stringify(packageJson.sideEffects)}; this gate holds the code to ${JSON.stringify(SIDE_EFFECTS)}. ` +
      `Without the field every route pays for whole barrels (3–7 kB each, measured at D5a); with a different one, rule 8 is checking the wrong promise. Change both together.`);
  }

  const stats = {
    files: files.length,
    imports: files.reduce((t, f) => t + info.get(f).all.length, 0),
    clients: files.filter((f) => info.get(f).client).length,
    modules: moduleDirs.length,
    shims: shims.size,
  };
  return { violations, stats };
}

/** Split violations into new ones, ones a debt covers, and debts no violation matches any more. */
export function settle(violations, debt) {
  const covers = (v) => {
    const d = debt[v.key];
    if (d === undefined) return false;
    return typeof d === "string" || !d.names || (v.names ?? []).every((n) => d.names.includes(n));
  };
  const fresh = violations.filter((v) => !covers(v));
  const owed = violations.filter(covers);
  const seen = new Set(owed.map((v) => v.key));
  const paid = Object.keys(debt).filter((k) => !seen.has(k));
  return { fresh, owed, paid };
}

// ---------------------------------------------------------------------------------------------
// Self-test: the gate has to be SEEN to fail. A check that has only ever passed proves nothing
// (WORKPLAN lessons 5 and 6) — so every rule gets a fixture that breaks it on purpose, and every
// hole the D5a review found (2026-10-03) gets the fixture that would have caught it.
// ---------------------------------------------------------------------------------------------

function selfTest() {
  const SHIM = (to) => `// Moved to ${to}.ts (V1 D5a). This re-export keeps imports working.\n// Add nothing here.\nexport * from "./${to}";\n`;
  const fixture = new Map(Object.entries({
    "src/lib/types.ts": `export type Meal = { name: string };\nexport const DAYS = ["Monday"];`,
    "src/lib/storage.ts": `const KEYS = { plan: "nutriflow.plan" };\nexport const load = () => localStorage.getItem(KEYS.plan);`,
    "src/lib/recipeDb.ts": `import type { Meal } from "./types";\nexport const RECIPES: Meal[] = [];\nexport type Recipe = Meal;`,
    // rule 1: L0 importing L3 — and an L0 file reaching L3 only through a TYPE position
    "src/lib/slots.ts": `import { RECIPES } from "./recipeDb";\nexport const N = RECIPES.length;`,
    "src/lib/core/index.ts": `export * from "./vocab";`,
    "src/lib/core/vocab.ts": `export type Leak = import("../recipeDb").Recipe;`,
    // rule 0: a file nobody placed
    "src/lib/mystery.ts": `export const x = 1;`,
    // rule 3: a second key, and direct storage access, outside storage.ts — and a key in a COMMENT, which must NOT count
    "src/app/sage/thing.ts": `// nutriflow.comment is only mentioned here\nexport const K = "nutriflow.saved2";\nexport const v = () => window.localStorage.getItem(K);`,
    // rule 4: a client component that reaches the engine through a middle module...
    "src/lib/feed.ts": `import { RECIPES } from "./recipeDb";\nexport const FEED = RECIPES;`,
    "src/app/sage/Client.tsx": `"use client";\nimport { FEED } from "@/lib/feed";\nexport const C = () => FEED.length;`,
    // ...and one that only imports a TYPE from the engine, which ships nothing and must NOT count
    "src/app/sage/TypeOnly.tsx": `"use client";\nimport { Recipe } from "@/lib/recipeDb";\nexport const T = (r: Recipe) => r.name;`,
    // ...spellings a home-made resolver missed: a trailing slash, a dot segment, a detour, require()
    "src/lib/plan/index.ts": `export const ENGINE = 501;`,
    "src/app/sage/Slash.tsx": `"use client";\nimport { ENGINE } from "@/lib/plan/";\nexport const S = ENGINE;`,
    "src/app/sage/Dot.tsx": `"use client";\nimport { RECIPES } from "@/lib/./recipeDb";\nexport const D = RECIPES;`,
    "src/app/sage/Detour.tsx": `"use client";\nimport { RECIPES } from "@/app/../lib/recipeDb";\nexport const D = RECIPES;`,
    "src/app/sage/Req.tsx": `"use client";\nconst { RECIPES } = require("@/lib/recipeDb");\nexport const R = RECIPES;`,
    "src/app/sage/Jsx.jsx": `"use client";\nimport { RECIPES } from "@/lib/recipeDb";\nexport const J = () => RECIPES.length;`,
    // ...a server-only package, and the assistant folder, which is server-only as a whole
    "src/app/sage/Zod.tsx": `"use client";\nimport { z } from "zod";\nexport const Z = z.string();`,
    "src/lib/assistant/index.ts": `export { reply } from "./reply";`,
    "src/lib/assistant/reply.ts": `export const reply = (s: string) => s;`,
    "src/lib/assistant/client.ts": `export { reply } from "./reply";`,
    "src/app/sage/Reply.tsx": `"use client";\nimport { reply } from "@/lib/assistant/client";\nexport const R = reply("x");`,
    // ...and a browser-safe entry that has started to carry zod, which no component needs to import to be wrong
    "src/lib/nutrition/index.ts": `export * from "./client";`,
    "src/lib/nutrition/client.ts": `export * from "./schemas";`,
    "src/lib/nutrition/schemas.ts": `import { z } from "zod";\nexport const S = z.number();`,
    // rule 5: a cycle — and one closed only through re-export barrels, and one whose closing edge is type-only
    "src/app/a.ts": `import { b } from "./b";\nexport const a = () => b();`,
    "src/app/b.ts": `import { a } from "./a";\nexport const b = () => a();`,
    "src/app/x/index.ts": `export * from "./xa";`,
    "src/app/x/xa.ts": `import { B } from "../y";\nexport const A = () => B;`,
    "src/app/y/index.ts": `export { B } from "./yb";`,
    "src/app/y/yb.ts": `import { A } from "../x";\nexport const B = () => A;`,
    "src/app/p/index.ts": `export * from "./pa";`,
    "src/app/p/pa.ts": `import { Q } from "../q";\nexport const P = (q: Q) => q;`,
    "src/app/q/index.ts": `export type { Q } from "./qb";`,
    "src/app/q/qb.ts": `import { P } from "../p";\nexport type Q = typeof P;`,
    // rule 2: a module with a barrel, reached around its barrel
    "src/lib/account/index.ts": `export { sync } from "./sync";`,
    "src/lib/account/sync.ts": `export const sync = 1;`,
    "src/app/deep.ts": `import { sync } from "@/lib/account/sync";\nexport const d = sync;`,
    // rule 2: the browser-safe entry is an entry; a client.ts one folder deeper is not, nor one that is not a barrel
    "src/lib/account/client.ts": `export { sync } from "./sync";`,
    "src/app/viaClient.ts": `import { sync } from "@/lib/account/client";\nexport const c = sync;`,
    "src/lib/account/inner/client.ts": `export { sync } from "../sync";`,
    "src/app/nested.ts": `import { sync } from "@/lib/account/inner/client";\nexport const n = sync;`,
    "src/lib/core/client.ts": `import { DAYS } from "../types";\nexport const glue = () => DAYS;`,
    "src/app/glue.ts": `import { glue } from "@/lib/core/client";\nexport const g = glue;`,
    // rule 2: a type position reaching past the barrel
    "src/app/typePos.ts": `export type T = import("@/lib/account/sync").Sync;`,
    // rule 2: a D5a shim (exact shape) is exempt itself — but importing it from src/ is the old path;
    // a look-alike is not a shim, and neither is one whose comment a lone CR or U+2028 ends early
    "src/lib/syncShim.ts": SHIM("account/sync"),
    "src/app/viaShim.ts": `import { sync } from "@/lib/syncShim";\nexport const s = sync;`,
    "src/lib/notAShim.ts": `// Moved to account/sync.ts\nexport * from "./account/sync";\nexport const extra = 1;\n`,
    "src/lib/crShim.ts": `// Moved to account/sync.ts (V1 D5a)\rimport { sync } from "./account/sync";\rexport const leak = sync;\n// Add nothing here.\nexport * from "./account/sync";\n`,
    "src/lib/lsShim.ts": `// Moved to account/sync.ts (V1 D5a)\u2028import { sync } from "./account/sync";\u2028export const leak = sync;\n// Add nothing here.\nexport * from "./account/sync";\n`,
    // rule 6
    "src/app/emoji.tsx": `export const E = () => "Done \u{1F389}";`,
    // rule 7: a path that goes nowhere, and one nobody can read; a stylesheet that exists is fine
    "src/app/nowhere.ts": `import { x } from "./doesNotExist";\nexport const n = x;`,
    "src/app/computed.ts": `export const load = (m: string) => import("./" + m);`,
    "src/app/layout.tsx": `import "./globals.css";\nexport const L = 1;`,
    // rule 8: a module imported for its effect, and a library statement that runs on load
    "src/app/sideEffect.ts": `import "@/lib/register";\nexport const s = 1;`,
    "src/lib/register.ts": `"use strict";\nglobalThis.registered = true;\nexport const r = 1;`,
  }));
  const LAYERS_FOR_FIXTURE = ["register.ts", "syncShim.ts", "notAShim.ts", "crShim.ts", "lsShim.ts"];
  for (const f of LAYERS_FOR_FIXTURE) LIB_LAYERS[f] = 5;
  const { violations } = check(fixture, { assets: new Set(["src/app/globals.css"]), packageJson: { sideEffects: false } });
  const keys = new Set(violations.map((v) => v.key));
  const expect = [
    ["rule 0 catches an unplaced file", "unclassified:src/lib/mystery.ts", true],
    ["rule 1 catches L0 importing L3", "layer:src/lib/slots.ts->src/lib/recipeDb.ts", true],
    ["rule 1 catches L0 reaching L3 through a type position, import(\"x\").T", "layer:src/lib/core/vocab.ts->src/lib/recipeDb.ts", true],
    ["rule 2 catches a deep import past a barrel", "barrel:src/app/deep.ts->src/lib/account/sync.ts", true],
    ["rule 2 catches a type position reaching past a barrel", "barrel:src/app/typePos.ts->src/lib/account/sync.ts", true],
    ["rule 2 allows the browser-safe client.ts entry", "barrel:src/app/viaClient.ts->src/lib/account/client.ts", false],
    ["rule 2 does NOT take a client.ts one folder deeper as the entry", "barrel:src/app/nested.ts->src/lib/account/inner/client.ts", true],
    ["rule 2 does NOT take a client.ts that is not a barrel as the entry", "barrel:src/app/glue.ts->src/lib/core/client.ts", true],
    ["rule 2 exempts a D5a re-export of exactly that shape", "barrel:src/lib/syncShim.ts->src/lib/account/sync.ts", false],
    ["rule 2 catches src/ importing a D5a re-export (the old path)", "old-path:src/app/viaShim.ts->src/lib/syncShim.ts", true],
    ["rule 2 does NOT exempt a look-alike that adds code", "barrel:src/lib/notAShim.ts->src/lib/account/sync.ts", true],
    ["rule 2 does NOT exempt a look-alike whose comment a lone CR ends", "barrel:src/lib/crShim.ts->src/lib/account/sync.ts", true],
    ["rule 2 does NOT exempt a look-alike whose comment U+2028 ends", "barrel:src/lib/lsShim.ts->src/lib/account/sync.ts", true],
    ["rule 3 catches a second storage key", "storage-key:src/app/sage/thing.ts:nutriflow.saved2", true],
    ["rule 3 catches direct localStorage access", "storage-api:src/app/sage/thing.ts", true],
    ["rule 3 ignores a key mentioned in a comment", "storage-key:src/app/sage/thing.ts:nutriflow.comment", false],
    ["rule 4 catches a client component reaching the engine via another module", "client-server:src/app/sage/Client.tsx->src/lib/recipeDb.ts", true],
    ["rule 4 ignores a type-only import (it ships nothing)", "client-server:src/app/sage/TypeOnly.tsx->src/lib/recipeDb.ts", false],
    ["rule 4 follows a trailing slash (\"@/lib/plan/\")", "client-server:src/app/sage/Slash.tsx->src/lib/plan/index.ts", true],
    ["rule 4 follows a dot segment (\"@/lib/./recipeDb\")", "client-server:src/app/sage/Dot.tsx->src/lib/recipeDb.ts", true],
    ["rule 4 follows a detour (\"@/app/../lib/recipeDb\")", "client-server:src/app/sage/Detour.tsx->src/lib/recipeDb.ts", true],
    ["rule 4 follows require()", "client-server:src/app/sage/Req.tsx->src/lib/recipeDb.ts", true],
    ["rule 4 checks a .jsx client component", "client-server:src/app/sage/Jsx.jsx->src/lib/recipeDb.ts", true],
    ["rule 4 catches a client component importing zod", "client-server:src/app/sage/Zod.tsx->zod", true],
    ["rule 4 treats the whole assistant folder as server-only (its client.ts is no door)", "client-server:src/app/sage/Reply.tsx->src/lib/assistant/client.ts", true],
    ["rule 4 catches a browser-safe entry that carries zod, imported or not", "client-barrel:src/lib/nutrition/client.ts->zod", true],
    ["rule 5 catches a cycle", "cycle:src/app/a.ts|src/app/b.ts", true],
    ["rule 5 catches a cycle closed only through re-export barrels", "cycle:src/app/x/index.ts|src/app/x/xa.ts|src/app/y/index.ts|src/app/y/yb.ts", true],
    ["rule 5 ignores a cycle whose closing edge is `export type`", "cycle:src/app/p/index.ts|src/app/p/pa.ts|src/app/q/index.ts|src/app/q/qb.ts", false],
    ["rule 6 catches an emoji", "emoji:src/app/emoji.tsx:1", true],
    ["rule 7 catches an import that resolves to nothing", "unresolved:src/app/nowhere.ts->./doesNotExist", true],
    ["rule 7 catches an import whose path is computed", "dynamic:src/app/computed.ts:1", true],
    ["rule 7 accepts a stylesheet that exists", "unresolved:src/app/layout.tsx->./globals.css", false],
    ["rule 8 catches a module imported only for its effect", "bare-import:src/app/sideEffect.ts->src/lib/register.ts", true],
    ["rule 8 catches a library statement that runs on load (after the prologue)", "effect:src/lib/register.ts:2", true],
    ["rule 8 catches package.json's sideEffects drifting", "side-effects-field", true],
  ];
  let failed = 0;
  for (const [label, key, want] of expect) {
    const ok = keys.has(key) === want;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  }
  // A debt that names its imports covers exactly those, and a debt nothing matches is reported paid.
  const v = (key, names) => ({ key, names });
  const debt = { "layer:a->b": { names: ["x", "y"], why: "" }, "layer:c->d": "plain", "layer:gone->x": "paid" };
  const s = settle([v("layer:a->b", ["x"]), v("layer:a->b", ["x", "z"]), v("layer:c->d", ["anything"])], debt);
  const debtChecks = [
    ["a named debt covers an import of its names", s.owed.some((o) => o.key === "layer:a->b" && o.names.join() === "x")],
    ["a named debt does NOT cover an import that grew", s.fresh.some((o) => o.key === "layer:a->b" && o.names.includes("z"))],
    ["a plain debt covers its key", s.owed.some((o) => o.key === "layer:c->d")],
    ["a debt nothing matches is reported paid", s.paid.join() === "layer:gone->x"],
  ];
  for (const [label, ok] of debtChecks) { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); }
  // A clean tree must produce nothing at all.
  for (const f of LAYERS_FOR_FIXTURE) delete LIB_LAYERS[f];
  const clean = check(new Map([["src/lib/types.ts", `export const DAYS = ["Monday"];`], ["src/app/x.ts", `import { DAYS } from "@/lib/types";\nexport const n = DAYS.length;`]]), { packageJson: { sideEffects: ["*.css"] } });
  const cleanOk = clean.violations.length === 0;
  if (!cleanOk) failed++;
  console.log(`${cleanOk ? "PASS" : "FAIL"}  a clean tree passes with no violations${cleanOk ? "" : ": " + clean.violations.map((x) => x.key).join(", ")}`);
  const total = expect.length + debtChecks.length + 1;
  console.log(`\n${total - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------
// Run against the real tree
// ---------------------------------------------------------------------------------------------

if (process.argv.includes("--self-test")) selfTest();

const ROOT = process.cwd();
const scripts = [], assets = new Set();
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const f = relative(ROOT, p).split("\\").join("/");
    if (statSync(p).isDirectory()) walk(p);
    else if (SCRIPT.test(e) && !e.endsWith(".d.ts")) scripts.push(f);
    else assets.add(f);
  }
};
walk(join(ROOT, "src"));
const sources = new Map(scripts.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const { violations, stats } = check(sources, { assets, packageJson });

const RULE_TITLE = {
  0: "a file in src/lib has no layer", 1: "a module imports above its layer", 2: "an import past a module's entry points",
  3: "storage is touched outside storage.ts", 4: "browser code reaches the server side",
  5: "an import cycle", 6: "an emoji in src/", 7: "an import the gate cannot follow", 8: "something depends on running at import time",
};

const { fresh, owed, paid } = settle(violations, KNOWN_DEBT);
const why = (k) => (typeof KNOWN_DEBT[k] === "string" ? KNOWN_DEBT[k] : `${KNOWN_DEBT[k].why} (covers only: ${KNOWN_DEBT[k].names.join(", ")})`);

console.log(`check:boundaries — ${stats.files} files, ${stats.imports} imports, ${stats.clients} client components, ` +
  `${stats.modules} module ${stats.modules === 1 ? "index" : "indexes"}, ${stats.shims} old-path re-exports\n`);

for (const v of fresh) console.log(`FAIL  rule ${v.rule} · ${RULE_TITLE[v.rule]}\n      ${v.message}\n`);
for (const k of paid) console.log(`FAIL  a known debt has been PAID — delete its entry from KNOWN_DEBT so the list stays true:\n      ${k}\n`);

if (owed.length) {
  console.log(`KNOWN DEBT — ${owed.length} violation(s) that predate their rule. They pass, and the list may only shrink:`);
  for (const v of owed) console.log(`  rule ${v.rule} · ${v.key}\n      owed to ${why(v.key)}`);
  console.log("");
}

if (fresh.length || paid.length) {
  console.log(`check:boundaries FAILED — ${fresh.length} new violation(s), ${paid.length} paid debt(s) still listed.`);
  process.exit(1);
}
console.log(`check:boundaries passed — no new violations${owed.length ? `, ${owed.length} known debt(s) outstanding` : ""}.`);
