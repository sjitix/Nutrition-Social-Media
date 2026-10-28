/**
 * Recipe imagery.   npm run check:images        (-- --self-test proves each rule can fail)
 *
 * V1 D10 (B4). A photograph appears only on the dish it depicts (public/food/README.md): the two maps in
 * presentation/recipes.ts are exact recipe names, and a miss falls back to a typographic tile. That fallback
 * is also what made every mistake here SILENT: a key that is not a real recipe name just shows a gradient.
 * Twelve stock photos once served one image as 46 dishes. This gate catches, with no vision at all:
 *   - a map key that is not exactly a recipe name in the library;
 *   - a mapped file that does not exist, or is not an image type the app serves;
 *   - a file in public/food that no map entry uses (an orphan);
 *   - two entries pointing at one file, or two files with the same bytes (one picture, two dishes);
 *   - a file over the size budget.
 * Whether the photograph shows the dish is not something it can check: that stays a person looking.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RECIPES } from "@/lib/recipeDb";
import { PHOTOGRAPHED_RECIPES, CUTOUT_RECIPES, imageForMeal, cutoutForMeal } from "@/lib/presentation/recipes";

/** The largest shipped file is 296 kB; a card or a hero never needs more than this. */
export const MAX_BYTES = 400 * 1024;
const TYPES = /\.(jpe?g|webp|png|avif)$/i;
const NOT_IMAGES = new Set(["README.md"]);

export interface ImageFile { name: string; bytes: number; hash: string }
export interface Maps { images: Record<string, string>; cutouts: Record<string, string> }

export function imageProblems(maps: Maps, recipeNames: ReadonlySet<string>, files: ImageFile[]): string[] {
  const problems: string[] = [];
  const byName = new Map(files.map((f) => [f.name, f]));
  const users = new Map<string, string[]>(); // file -> the entries that use it
  for (const [label, map] of [["image", maps.images], ["cut-out", maps.cutouts]] as const) {
    for (const [recipe, url] of Object.entries(map)) {
      if (!recipeNames.has(recipe)) problems.push(`${label} for "${recipe}": no recipe has exactly that name, so the card silently shows a tile`);
      const m = url.match(/^\/food\/([^/]+)$/);
      if (!m) { problems.push(`${label} for "${recipe}": "${url}" is not a file directly under /food/`); continue; }
      const file = m[1];
      if (!TYPES.test(file)) problems.push(`${label} for "${recipe}": "${file}" is not a jpg, webp, png or avif`);
      if (!byName.has(file)) problems.push(`${label} for "${recipe}": public/food/${file} does not exist`);
      users.set(file, [...(users.get(file) ?? []), `${label} for "${recipe}"`]);
    }
  }
  for (const [file, who] of users) if (who.length > 1) problems.push(`public/food/${file} is used by ${who.length} entries (${who.join(", ")}): one photograph, one dish`);
  const byHash = new Map<string, string[]>();
  for (const f of files) {
    if (NOT_IMAGES.has(f.name)) continue;
    if (!users.has(f.name)) problems.push(`public/food/${f.name} is used by no entry (an orphan): map it to the dish it shows, or delete it`);
    if (f.bytes > MAX_BYTES) problems.push(`public/food/${f.name} is ${Math.round(f.bytes / 1024)} kB, over the ${MAX_BYTES / 1024} kB budget`);
    byHash.set(f.hash, [...(byHash.get(f.hash) ?? []), f.name]);
  }
  for (const names of byHash.values()) if (names.length > 1) problems.push(`${names.map((n) => `public/food/${n}`).join(" and ")} are the same bytes`);
  return problems;
}

function selfTest(): number {
  const names = new Set(["Baked Salmon & Potatoes", "Shakshuka"]);
  const f = (name: string, bytes = 1000, hash = name): ImageFile => ({ name, bytes, hash });
  const good: Maps = { images: { "Baked Salmon & Potatoes": "/food/salmon.jpg", Shakshuka: "/food/shak.jpg" }, cutouts: { Shakshuka: "/food/shak-plate.webp" } };
  const goodFiles = [f("salmon.jpg"), f("shak.jpg"), f("shak-plate.webp"), f("README.md")];
  const cases: [string, Maps, ImageFile[], RegExp | null][] = [
    ["a clean set passes", good, goodFiles, null],
    ["a key that is not a recipe name", { ...good, images: { ...good.images, "Baked salmon & potatoes ": "/food/x.jpg" } }, [...goodFiles, f("x.jpg")], /no recipe has exactly that name/],
    ["a missing file", good, goodFiles.filter((x) => x.name !== "shak.jpg"), /does not exist/],
    ["an orphan", good, [...goodFiles, f("_tmp.webp")], /orphan/],
    ["two entries, one file", { ...good, images: { ...good.images, Shakshuka: "/food/salmon.jpg" } }, goodFiles.filter((x) => x.name !== "shak.jpg"), /used by 2 entries/],
    ["two files, same bytes", good, [...goodFiles.filter((x) => x.name !== "shak.jpg"), f("shak.jpg", 1000, "salmon.jpg")], /same bytes/],
    ["an oversized file", good, [...goodFiles.filter((x) => x.name !== "salmon.jpg"), f("salmon.jpg", MAX_BYTES + 1)], /over the/],
    ["not an image type", { ...good, images: { ...good.images, Shakshuka: "/food/shak.gif" } }, [...goodFiles.filter((x) => x.name !== "shak.jpg"), f("shak.gif")], /not a jpg/],
    ["a path outside /food/", { ...good, images: { ...good.images, Shakshuka: "https://example.com/shak.jpg" } }, goodFiles.filter((x) => x.name !== "shak.jpg"), /not a file directly under/],
  ];
  let failed = 0;
  for (const [label, maps, files, want] of cases) {
    const got = imageProblems(maps, names, files);
    const ok = want ? got.some((p) => want.test(p)) : got.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  self-test: ${label}${ok ? "" : ` — got ${JSON.stringify(got)}`}`);
  }
  console.log(failed ? `\ncheck:images self-test: ${failed} of ${cases.length} FAILED` : `\ncheck:images self-test: ${cases.length}/${cases.length}`);
  return failed;
}

if (process.argv.includes("--self-test")) process.exit(selfTest() ? 1 : 0);

const dir = join(process.cwd(), "public", "food");
const files: ImageFile[] = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()).map((name) => {
  const buf = readFileSync(join(dir, name));
  return { name, bytes: buf.length, hash: createHash("sha256").update(buf).digest("hex") };
});
// Read through the same functions the app calls, so the gate sees what a card would show.
const maps: Maps = {
  images: Object.fromEntries(PHOTOGRAPHED_RECIPES.map((n) => [n, imageForMeal(n) ?? ""])),
  cutouts: Object.fromEntries(CUTOUT_RECIPES.map((n) => [n, cutoutForMeal(n) ?? ""])),
};
const problems = imageProblems(maps, new Set(RECIPES.map((r) => r.name)), files);
const images = files.filter((f) => !NOT_IMAGES.has(f.name));
if (problems.length) {
  console.log(problems.map((p) => `  - ${p}`).join("\n"));
  console.log(`\ncheck:images FAILED — ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`check:images passed — ${PHOTOGRAPHED_RECIPES.length} photographed recipes, ${CUTOUT_RECIPES.length} cut-outs, ${images.length} files, each used once, none over ${MAX_BYTES / 1024} kB.`);
