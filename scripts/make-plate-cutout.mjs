import sharp from "sharp";
// Mask a round plate out of its background. The plate is a circle shot from overhead, so fitting
// one is far more robust than segmenting: a flood fill leaks through the bok choy where a leaf
// bridges the rim, and eats the food.
const [,, SRC, OUT, PREVIEW] = process.argv;
const W = 1500;
const { data, info } = await sharp(SRC).resize(W).raw().toBuffer({ resolveWithObject: true });
const w = info.width, h = info.height, ch = info.channels;
// The plate + its contents are warm and bright; the sage surface is green-dominant, the fork dark.
const isPlate = (p) => { const r = data[p*ch], g = data[p*ch+1], b = data[p*ch+2];
  return r >= g - 2 && (r + g + b) > 330; };
const lab = new Int32Array(w * h).fill(-1); let best = -1, bestN = 0, id = 0;
for (let s = 0; s < w * h; s++) { if (lab[s] >= 0 || !isPlate(s)) continue; const me = id++; lab[s] = me;
  const st = [s]; let n = 0;
  while (st.length) { const q = st.pop(); n++; const x = q % w, y = (q - x) / w; const nb = [];
    if (x > 0) nb.push(q - 1); if (x < w - 1) nb.push(q + 1); if (y > 0) nb.push(q - w); if (y < h - 1) nb.push(q + w);
    for (const r of nb) if (lab[r] < 0 && isPlate(r)) { lab[r] = me; st.push(r); } }
  if (n > bestN) { bestN = n; best = me; } }
let x0 = w, y0 = h, x1 = 0, y1 = 0;
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (lab[y * w + x] === best) {
  if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
const rad = Math.min(x1 - x0, y1 - y0) / 2;
console.log(`plate blob ${(100*bestN/(w*h)).toFixed(1)}%  bbox ${x1-x0}x${y1-y0}  centre ${cx.toFixed(0)},${cy.toFixed(0)}  r ${rad.toFixed(0)}`);
const R = Math.round(rad);
const size = R * 2;
const left = Math.round(cx - R), top = Math.round(cy - R);
// A circular alpha with a 1px feather, so the rim is clean rather than aliased.
const mask = Buffer.alloc(size * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const d = Math.hypot(x - R + 0.5, y - R + 0.5);
  mask[y * size + x] = d <= R - 1.5 ? 255 : d >= R - 0.5 ? 0 : Math.round(255 * (R - 0.5 - d));
}
const rgb = await sharp(SRC).resize(W).extract({ left, top, width: size, height: size }).ensureAlpha().raw().toBuffer();
for (let p = 0; p < size * size; p++) rgb[p * 4 + 3] = mask[p];
const cut = sharp(rgb, { raw: { width: size, height: size, channels: 4 } });
await cut.clone().webp({ quality: 86, alphaQuality: 100 }).toFile(OUT);
const flat = await sharp({ create: { width: size, height: size, channels: 3, background: "#f5f2e7" } })
  .composite([{ input: await cut.clone().png().toBuffer() }]).png().toBuffer();
await sharp(flat).resize(820).jpeg({ quality: 92 }).toFile(PREVIEW);
console.log("wrote", OUT, size + "x" + size);
