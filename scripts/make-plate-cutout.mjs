import sharp from "sharp";
/**
 * Mask a round plate out of its background, so the dish becomes an OBJECT the layout can lay on
 * the page and crop by the frame — the `sage-06` and `sage-04` move. A rectangle cannot do that.
 *
 *   node scripts/make-plate-cutout.mjs <src> <out.webp> <preview.jpg> [cx cy rx [ry]]
 *
 * The last arguments are optional, in fractions of the image WIDTH, and override the automatic fit
 * for the shot it gets wrong. `ry` defaults to `rx`; pass it when the bowl is not quite round —
 * Midjourney's "orthographic" overhead is only approximately overhead, and one frame in three
 * comes out slightly elliptical, which no circle can mask cleanly.
 *
 * To measure by hand, render the source with a percentage grid over it and read the rim off it.
 * Always look at the preview: it is the cut-out composited on the page colour, which is the only
 * way to see a green fringe or a ring of background.
 *
 * WHY IT FITS A CIRCLE rather than segmenting the background. Segmenting was tried first and fails
 * on real food: a flood fill from the frame edges leaks through the bok choy where a leaf bridges
 * the rim, and eats a bite-shaped hole out of the dish. The plate is a circle photographed from
 * overhead, so fitting one is both simpler and exact.
 *
 * WHY THE SURFACE IS FOUND FIRST, rather than the plate. "Bright and warm" does not separate them:
 * on a sunlit shot the sage linen is pale and neutral enough to pass any plate test, and the fitted
 * circle then swallows the background and clips the food. What DOES separate them is hue — every
 * surface in this style system is sage, so `g >= r`, while ceramic and food are warm, so `r > g`.
 * The surface is flooded from the border, and whatever is left in the middle is the bowl.
 */
const [,, SRC, OUT, PREVIEW, CX, CY, RX, RY] = process.argv;
const W = 1500;
const { data, info } = await sharp(SRC).resize(W).raw().toBuffer({ resolveWithObject: true });
const w = info.width, h = info.height, ch = info.channels;

let cx, cy, radX, radY;
if (CX && CY && RX) {
  cx = Number(CX) * w; cy = Number(CY) * w; radX = Number(RX) * w; radY = Number(RY ?? RX) * w;
  console.log(`plate given by hand: centre ${cx.toFixed(0)},${cy.toFixed(0)}  rx ${radX.toFixed(0)}  ry ${radY.toFixed(0)}`);
} else {
  let rad;
  // The sage surface, and its shadows, which are the same hue only darker.
  const isSurface = (p) => { const r = data[p*ch], g = data[p*ch+1], b = data[p*ch+2];
    return g - r >= 1 && g - b >= -6; };
  const surf = new Uint8Array(w * h); const st = [];
  const push = (x, y) => { const p = y * w + x; if (!surf[p] && isSurface(p)) { surf[p] = 1; st.push(p); } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (st.length) { const p = st.pop(); const x = p % w, y = (p - x) / w;
    if (x > 0) push(x - 1, y); if (x < w - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < h - 1) push(x, y + 1); }

  // Whatever the flood could not reach is the bowl. Take the largest such region and use its
  // BOUNDING BOX, not its pixel count: if the flood does breach the rim somewhere, it removes
  // interior pixels while the rim stays connected all the way round, so the box is still right.
  const lab = new Int32Array(w * h).fill(-1); let best = -1, bestN = 0, id = 0;
  for (let s = 0; s < w * h; s++) { if (lab[s] >= 0 || surf[s]) continue; const me = id++; lab[s] = me;
    const q2 = [s]; let n = 0;
    while (q2.length) { const q = q2.pop(); n++; const x = q % w, y = (q - x) / w; const nb = [];
      if (x > 0) nb.push(q - 1); if (x < w - 1) nb.push(q + 1); if (y > 0) nb.push(q - w); if (y < h - 1) nb.push(q + w);
      for (const r of nb) if (lab[r] < 0 && !surf[r]) { lab[r] = me; q2.push(r); } }
    if (n > bestN) { bestN = n; best = me; } }
  if (best < 0) throw new Error("no bowl found — is the whole frame the same hue as the surface?");
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (lab[y * w + x] === best) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  cx = (x0 + x1) / 2; cy = (y0 + y1) / 2; rad = Math.min(x1 - x0, y1 - y0) / 2;
  console.log(`bowl ${(100*bestN/(w*h)).toFixed(1)}% of frame  bbox ${x1-x0}x${y1-y0}  centre ${cx.toFixed(0)},${cy.toFixed(0)}  r ${rad.toFixed(0)}`);
  if (rad < w * 0.18) console.log("  ^ that looks small. Check the preview; pass cx cy rx by hand if it is wrong.");
  radX = rad; radY = rad;
}
const RX2 = Math.round(radX), RY2 = Math.round(radY);
const sw = RX2 * 2, sh = RY2 * 2;
const left = Math.round(cx - RX2), top = Math.round(cy - RY2);
if (left < 0 || top < 0 || left + sw > w || top + sh > h)
  throw new Error(`the ellipse falls outside the frame (${left},${top} ${sw}x${sh} of ${w}x${h}) — the bowl is cropped by the source's own edge, so it cannot be cut out whole`);
// An elliptical alpha with a 1px feather, so the rim is clean rather than aliased.
const mask = Buffer.alloc(sw * sh);
for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
  // Distance in units where the ellipse boundary is 1, scaled back to pixels for the feather.
  const nx = (x - RX2 + 0.5) / RX2, ny = (y - RY2 + 0.5) / RY2;
  const d = (Math.hypot(nx, ny) - 1) * Math.min(RX2, RY2);
  mask[y * sw + x] = d <= -1.5 ? 255 : d >= -0.5 ? 0 : Math.round(255 * (-0.5 - d));
}
const rgb = await sharp(SRC).resize(W).extract({ left, top, width: sw, height: sh }).ensureAlpha().raw().toBuffer();
for (let p = 0; p < sw * sh; p++) rgb[p * 4 + 3] = mask[p];

// THE OUTPUT IS ALWAYS SQUARE, so the plate is always a CIRCLE on the page.
//
// An elliptical cut-out is the thing that reads as "badly cut out" even when the mask is perfect:
// a plate is round, so an oval one looks like a mistake. Where the source is oval — Midjourney's
// overhead is only approximately overhead — the crop is scaled to a square, which restores the
// circle. The scale is split between the axes (equal-area) rather than stretching one of them the
// whole way, so a 17% ovality becomes ±8% on each axis instead of +17% on one.
const side = Math.round(Math.sqrt(sw * sh));
const cut = sharp(rgb, { raw: { width: sw, height: sh, channels: 4 } }).resize(side, side, { fit: "fill" });
if (sw !== sh) console.log(`  source plate is oval (${sw}x${sh}); squared to ${side}x${side}`);
await cut.clone().webp({ quality: 86, alphaQuality: 100 }).toFile(OUT);
const flat = await sharp({ create: { width: side, height: side, channels: 3, background: "#f5f2e7" } })
  .composite([{ input: await cut.clone().png().toBuffer() }]).png().toBuffer();
await sharp(flat).resize(820).jpeg({ quality: 92 }).toFile(PREVIEW);
console.log("wrote", OUT, side + "x" + side);
