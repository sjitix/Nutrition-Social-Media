/**
 * A Math.random a test can seed, installed before any engine module captures it.
 *
 * The engine makes one random draw (plan/select.ts, the tie-break among near-best dishes), through `_rng`,
 * which is Math.random as it was when that module loaded. `withSeed` can seed only a SYNCHRONOUS call, and
 * an agent run is async, so a test comparing two agent runs had no way to give both the same dice. Imported
 * FIRST by a suite, this module makes Math.random a pass-through to the real one; `reseed(n)` swaps in a
 * seeded generator and `reseed(null)` puts the real one back. A suite that never reseeds behaves exactly as
 * before. (The models lane's eval bundles do the same with an esbuild define: scripts/models/bundle.mjs.)
 */
const native = Math.random;
let current: () => number = native;
Math.random = () => current();

/** mulberry32, the generator plan/select.ts uses for withSeed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function reseed(seed: number | null): void {
  current = seed === null ? native : mulberry32(seed);
}
