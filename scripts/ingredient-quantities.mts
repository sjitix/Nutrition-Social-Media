/** Distinct quantities used per ingredient — tells us dry-vs-cooked and unit semantics. */
import { RECIPES } from "@/lib/recipeDb";

const want = new Set(
  (process.argv[2] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
);
const map = new Map<string, Map<string, number>>();
for (const r of RECIPES) {
  for (const ing of r.ingredients) {
    const n = ing.name.trim().toLowerCase();
    if (want.size && !want.has(n)) continue;
    if (!map.has(n)) map.set(n, new Map());
    const q = map.get(n)!;
    q.set(ing.quantity, (q.get(ing.quantity) ?? 0) + 1);
  }
}
for (const [n, qs] of [...map.entries()].sort()) {
  const parts = [...qs.entries()].sort((a, b) => b[1] - a[1]).map(([q, c]) => `${q} x${c}`);
  console.log(`${n.padEnd(24)} ${parts.join(", ")}`);
}
