import Image from "next/image";
import Link from "next/link";
import { RECIPES, type Recipe } from "@/lib/recipeDb";
import { imageForMeal, cutoutForMeal, gradientForMeal, PHOTOGRAPHED_RECIPES } from "@/lib/recipes";
// `shot` below counts photographs that resolve to a REAL recipe, and every count on this page is
// taken from it rather than from the map's length. A key that no longer matches a recipe (a
// rename) would otherwise make the page claim a photograph that never renders.
import { demoWeek, DEMO, SLOTS } from "./demo";

/**
 * Home, built from `designs/references/boards/sage-02 … sage-09`.
 *
 * This is a REBUILD, not a restyle. The previous version kept the old composition — centred
 * container, hero text beside a rounded photo card, a forest panel, a row of equal cards — and
 * applied the boards' surface qualities to it. That was rejected, correctly: the tokens were
 * right and the composition was still the old one. WORKPLAN lesson 15.
 *
 * What the boards actually compose, section by section, and where each is used here:
 *
 *  sage-09  an enormous serif headline on the left; a photograph running off the RIGHT edge of
 *           the page, roughly 45% of its width, the bowl cut by the frame → §1.
 *  sage-06  a photograph laid on the page ground with no card and no frame, cropped by the LEFT
 *           edge → §4. And two deep forest cards each carrying ONE very large number → §2.
 *  sage-09  a row of unequal blocks — a wide sage panel of hairline-ruled figures beside a photo
 *           card beside a narrow stack → §2.
 *  sage-08  a real table of numbers used as a design element, hairline-ruled, tiny headers → §3.
 *  sage-07  a dense list card: name, one description line, a figure and a small round control at
 *           the right, hairlines between → §4.
 *  sage-03  a solid forest band the full width of the page → §5. And the small circular badge
 *           that sits ON a photograph rather than beside it → §1.
 *
 * Two things the boards do that are easy to lose and were deliberately kept: radii are SMALL
 * (8–14px, not 28–32px — they read as print, not as a card UI), and photography is never a
 * thumbnail with a caption under it. It is either bleeding off a frame edge or overlapping its
 * neighbours.
 *
 * Everything numeric is the engine's own output — `selectWeekFromDb` for the week, `RECIPES` for
 * the library, macros derived from ingredients against USDA. Nothing on this page is typed in.
 */
export default function SagePage() {
  const { days, avgKcal, avgProtein, avgFibre, lowest, uniqueDishes } = demoWeek();

  // Photography leads the composition, so the dishes that HAVE a photograph are chosen first and
  // the layout is built around them — rather than picking a dish and hoping. A recipe missing
  // from the library (a rename) simply drops out; the sections below degrade to the typographic
  // tile rather than showing another dish's food.
  const shot = PHOTOGRAPHED_RECIPES.map((name) => RECIPES.find((r) => r.name === name)).filter(
    (r): r is Recipe => Boolean(r),
  );

  // The hero leads with a dish that has a CUT-OUT, because the hero's whole composition is a plate
  // sitting on the page rather than a photograph in a frame. If none exists the section still
  // renders — text, card and all — just without the plate; it degrades to type, never to another
  // dish's food.
  const heroDish = shot.find((r) => cutoutForMeal(r.name)) ?? shot[0];
  const heroPlate = heroDish ? cutoutForMeal(heroDish.name) : null;
  const [bandDish, bleedDish] = shot.filter((r) => r !== heroDish);

  // The list in §4: the photographed dishes first, then the library's highest-protein dinners, so
  // the rows are a real answer to "what is in here" rather than the first six of an array.
  const listed = [
    ...shot,
    ...RECIPES.filter((r) => !r.treatOnly && !imageForMeal(r.name) && r.type === "dinner")
      .sort((a, b) => b.proteinGrams - a.proteinGrams)
      .slice(0, 3),
  ].slice(0, 6);

  const totalMeals = days.length * DEMO.mealsPerDay;

  return (
    <>
      {/* ================= §1 HERO — sage-06. The bowl is an OBJECT on the page. ==============
          Not a photograph in a slot: the plate is masked out of its background, laid on the cream
          with its own shadow, oversized, and cut by the right edge of the frame. It sits ON the
          layout — over the rule and the figures — and the library card then sits on IT, so the
          page has three real layers. A rectangle cannot do any of that; the rectangle IS what
          reads as "a photo in a card", which is what the earlier attempt was rejected for. */}
      <section className="relative overflow-hidden xl:min-h-[720px]">
        <div className="relative z-10 flex max-w-[620px] flex-col justify-center px-6 py-14 sm:px-10 sm:py-20 xl:min-h-[720px] xl:px-14 xl:py-24">
          <span className="text-[10px] font-bold uppercase tracking-[0.26em] text-mut">
            NutriFlow — weekly meal planning
          </span>

          {/* Two lines, and it must STAY two lines: the boards' headline is a block, and a
              headline that wraps to four is a different composition. The clamp ceiling is the
              largest size at which "Share a reel." still fits this column at 1440. */}
          <h1 className="font-serif-display mt-6 text-[clamp(42px,4.7vw,80px)] font-semibold leading-[0.9] tracking-[-0.035em]">
            Share a reel.
            <br />
            Eat the week.
          </h1>

          <p className="mt-7 max-w-[44ch] text-[16px] leading-[1.65] text-plum-mid">
            Paste a recipe video and it becomes a meal in your plan. Macros are computed from real
            food data, never guessed — and when you ask for pancakes, the rest of the day rebalances
            so your targets still hold.
          </p>

          <div className="mt-9 flex flex-wrap gap-2.5">
            <Link
              href="/sage/plan"
              className="inline-flex items-center gap-2 rounded-full bg-vio px-6 py-3 text-[13px] font-semibold text-white transition hover:bg-vio-deep"
            >
              Plan my week
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12h13M12 5.5 18.5 12 12 18.5" />
              </svg>
            </Link>
            <Link
              href="/sage/explore"
              className="inline-flex items-center rounded-full bg-tint px-6 py-3 text-[13px] font-semibold text-plum transition hover:bg-line"
            >
              Browse {RECIPES.length} recipes
            </Link>
          </div>

          {/* The boards run micro-data in hairline-ruled rows rather than in badges. */}
          {/* Plain elements, not a <dl>: the value is set above its label here, and a definition
              list whose <dt> is the value and <dd> the term is backwards for a screen reader. */}
          <div className="mt-12 flex max-w-[440px] border-t border-line pt-4 text-[11.5px]">
            {(
              [
                [`${RECIPES.length}`, "recipes"],
                [`${uniqueDishes}/${totalMeals}`, "unique this week"],
                ["USDA", "every macro"],
              ] as const
            ).map(([v, l], i) => (
              <p key={l} className={"flex-1 " + (i ? "border-l border-line pl-5" : "pr-5")}>
                <b className="block text-[15px] font-bold tracking-[-0.02em] tabular-nums">{v}</b>
                <span className="mt-0.5 block text-mut">{l}</span>
              </p>
            ))}
          </div>
        </div>

        {/* SLOT: the plate. Bigger than the space it is given on purpose — `-right-[14%]` puts a
            seventh of it past the frame, so the FRAME does the cropping, and `z-20` puts it over
            the text block's right margin instead of politely beside it. */}
        {heroPlate && heroDish && (
          <div
            aria-hidden
            // Absolute only from `xl`. Below that the text column and the plate would fight for
            // the same 900-odd pixels and the card would land on top of the figures — so the
            // composition stacks instead, and the plate still runs off the right edge.
            className="pointer-events-none relative z-20 -mt-10 ml-[16%] w-[94%] max-w-[620px] sm:-mt-20 xl:absolute xl:-right-[14%] xl:top-1/2 xl:ml-0 xl:mt-0 xl:w-[56%] xl:max-w-none xl:-translate-y-1/2"
          >
            <Image
              src={heroPlate}
              alt=""
              width={908}
              height={908}
              priority
              sizes="(max-width: 1024px) 92vw, 56vw"
              className="h-auto w-full drop-shadow-[0_36px_60px_rgba(28,36,25,0.26)]"
            />
            {/* sage-03's badge, on the rim of the plate rather than in a corner of a rectangle. */}
            <span className="absolute left-[2%] top-[8%] grid h-[74px] w-[74px] place-items-center rounded-full bg-panel text-center text-white sm:h-[86px] sm:w-[86px]">
              <span>
                <b className="block text-[20px] font-bold leading-none tabular-nums sm:text-[23px]">
                  {heroDish.proteinGrams}g
                </b>
                <span className="text-[8.5px] font-bold uppercase tracking-[0.14em] text-white/60">
                  protein
                </span>
              </span>
            </span>
          </div>
        )}

        {/* The third layer: this card sits on the plate, which sits on the page. */}
        {heroDish && (
          <div className="relative z-30 mx-6 -mt-14 bg-cream px-6 py-5 sm:mx-10 sm:-mt-24 sm:w-[340px] sm:rounded-[12px] xl:absolute xl:bottom-16 xl:left-[47%] xl:mx-0 xl:mt-0">
            <span className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-mut">
              In the library
            </span>
            <p className="font-serif-display mt-2 text-[24px] font-semibold leading-[1.08] tracking-[-0.02em]">
              {heroDish.name}
            </p>
            <div className="mt-4 flex border-t border-line pt-3 text-[11px]">
              {(
                [
                  [heroDish.calories.toLocaleString(), "kcal"],
                  [`${heroDish.fiberGrams ?? 0}g`, "fibre"],
                  [`${heroDish.timeMinutes}`, "minutes"],
                ] as const
              ).map(([v, l], i) => (
                <div key={l} className={"flex-1 " + (i ? "border-l border-line pl-4" : "")}>
                  <b className="block text-[16px] font-bold leading-none tracking-[-0.03em] tabular-nums">
                    {v}
                  </b>
                  <span className="mt-1 block text-mut">{l}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ============ §2 UNEQUAL BLOCK ROW — sage-09's panel + photo + sage-06's numbers ======== */}
      <section className="mt-20 px-6 sm:mt-28 sm:px-10 xl:px-14">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
          <h2 className="font-serif-display text-[clamp(26px,3vw,40px)] font-semibold leading-[1.04] tracking-[-0.03em]">
            What one dish is made of.
          </h2>
          <p className="max-w-[38ch] text-[12.5px] leading-relaxed text-mut">
            Not printed on the recipe — added up from its ingredients against USDA FoodData
            Central, every time the page renders.
          </p>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[1.15fr_0.85fr_0.7fr]">
          {/* a) the sage block: hairline-ruled figures, the boards' data pattern */}
          {bandDish && (
            <div className="bg-tint p-7 sm:p-9 lg:rounded-[12px]">
              <span className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-mut">
                {bandDish.cuisine.replace("_", " ")} · {bandDish.type}
              </span>
              <p className="font-serif-display mt-3 text-[clamp(26px,2.6vw,34px)] font-semibold leading-[1.05] tracking-[-0.025em]">
                {bandDish.name}
              </p>
              <p className="mt-2.5 max-w-[40ch] text-[13px] leading-relaxed text-plum-mid">
                {bandDish.description}
              </p>

              <dl className="mt-7">
                {(
                  [
                    ["Calories", bandDish.calories.toLocaleString(), "kcal"],
                    ["Protein", bandDish.proteinGrams, "g"],
                    ["Carbohydrate", bandDish.carbsGrams, "g"],
                    ["Fat", bandDish.fatGrams, "g"],
                    ["Fibre", bandDish.fiberGrams ?? 0, "g"],
                    ["Hands-on", bandDish.timeMinutes, "min"],
                  ] as const
                ).map(([label, value, unit]) => (
                  <div
                    key={label}
                    className="flex items-baseline justify-between border-t border-plum/12 py-2.5 text-[12.5px]"
                  >
                    <dt className="text-mut">{label}</dt>
                    <dd className="tabular-nums">
                      <b className="text-[15px] font-bold tracking-[-0.02em]">{value}</b>
                      <span className="ml-1 text-[10.5px] text-mut">{unit}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* b) the photograph, as a block — no caption underneath, the type sits on it */}
          {bandDish && (
            <div className="relative min-h-[300px] overflow-hidden lg:min-h-0 lg:rounded-[12px]">
              {imageForMeal(bandDish.name) ? (
                <Image
                  src={imageForMeal(bandDish.name)!}
                  alt={bandDish.name}
                  fill
                  sizes="(max-width: 1024px) 100vw, 30vw"
                  className="object-cover"
                />
              ) : (
                <div className="absolute inset-0" style={{ background: gradientForMeal(bandDish.name) }} />
              )}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-panel/85 to-transparent px-6 pb-5 pt-16">
                <p className="font-serif-display text-[20px] font-semibold leading-tight tracking-[-0.02em] text-white">
                  {bandDish.name}
                </p>
                <p className="mt-1 text-[11px] tabular-nums text-white/70">
                  {bandDish.calories.toLocaleString()} kcal · {bandDish.proteinGrams} g protein ·{" "}
                  {bandDish.timeMinutes} min
                </p>
              </div>
            </div>
          )}

          {/* c) sage-06's two deep cards, each one very large number */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            {(
              [
                [avgKcal.toLocaleString(), "kcal", `Daily average across ${days.length} days`, `Target ${DEMO.targetCalories.toLocaleString()}`],
                [avgProtein, "g protein", "Daily average, computed not claimed", `Target ${DEMO.proteinGrams} g`],
              ] as const
            ).map(([value, unit, caption, target]) => (
              <div key={unit} className="flex flex-col justify-between bg-panel p-6 text-white lg:rounded-[12px]">
                <span className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-white/60">
                  {target}
                </span>
                <p className="mt-8 text-[clamp(44px,4.6vw,62px)] font-bold leading-[0.85] tracking-[-0.05em] tabular-nums">
                  {value}
                  <span className="ml-1.5 align-baseline text-[13px] font-medium tracking-normal text-white/60">
                    {unit}
                  </span>
                </p>
                <p className="mt-4 border-t border-white/15 pt-3 text-[11px] leading-relaxed text-white/65">
                  {caption}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ================= §3 THE WEEK AS A LEDGER — sage-08's table of numbers ================ */}
      <section className="mt-20 px-6 sm:mt-28 sm:px-10 xl:px-14">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="font-serif-display max-w-[16ch] text-[clamp(28px,3.4vw,46px)] font-semibold leading-[1.02] tracking-[-0.03em]">
            {days.length} days, {totalMeals} meals, nothing invented.
          </h2>
          <Link
            href="/sage/plan"
            className="rounded-full bg-tint px-5 py-2.5 text-[12.5px] font-semibold transition hover:bg-line"
          >
            Open the planner
          </Link>
        </div>

        <div className="mt-8 overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-left">
            <thead>
              <tr className="border-b border-plum/25 text-[9px] font-bold uppercase tracking-[0.18em] text-mut">
                <th className="w-[9%] pb-2.5 font-bold">Day</th>
                {SLOTS.slice(0, DEMO.mealsPerDay).map((s) => (
                  <th key={s} className="pb-2.5 pl-5 font-bold">
                    {s}
                  </th>
                ))}
                <th className="w-[9%] pb-2.5 pl-5 text-right font-bold">kcal</th>
                <th className="w-[9%] pb-2.5 pl-5 text-right font-bold">protein</th>
                <th className="w-[8%] pb-2.5 pl-5 text-right font-bold">fibre</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day} className="border-b border-line align-top">
                  <th scope="row" className="py-4 pr-4 text-left font-normal">
                    <span className="font-serif-display text-[17px] font-semibold tracking-[-0.02em]">
                      {d.short}
                    </span>
                    {d.day === lowest.day && (
                      <span className="mt-1 block text-[9px] font-bold uppercase tracking-[0.14em] text-vio">
                        Lowest
                      </span>
                    )}
                  </th>
                  {d.meals.map((m, i) => (
                    <td key={i} className="py-4 pl-5 text-[12.5px] leading-snug">
                      {m.name}
                      <span className="mt-0.5 block text-[10.5px] tabular-nums text-mut">
                        {m.calories} kcal · {m.proteinGrams} g
                      </span>
                    </td>
                  ))}
                  <td className="py-4 pl-5 text-right text-[15px] font-bold tracking-[-0.02em] tabular-nums">
                    {d.kcal.toLocaleString()}
                  </td>
                  <td className="py-4 pl-5 text-right text-[15px] font-bold tracking-[-0.02em] tabular-nums">
                    {d.protein}
                  </td>
                  <td className="py-4 pl-5 text-right text-[13px] tabular-nums text-mut">
                    {d.fibre}
                  </td>
                </tr>
              ))}
              <tr className="text-[10px] font-bold uppercase tracking-[0.16em] text-mut">
                <td className="pt-3">Average</td>
                <td colSpan={DEMO.mealsPerDay} className="pt-3" />
                <td className="pt-3 pl-5 text-right tabular-nums">{avgKcal.toLocaleString()}</td>
                <td className="pt-3 pl-5 text-right tabular-nums">{avgProtein}</td>
                <td className="pt-3 pl-5 text-right tabular-nums">{avgFibre}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p className="mt-6 flex max-w-[70ch] items-start gap-2.5 text-[12.5px] leading-relaxed text-mut">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" className="mt-0.5 shrink-0" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5M12 16.5v.01" />
          </svg>
          <span>
            <b className="font-semibold text-plum">
              {lowest.day} lands {DEMO.proteinGrams - lowest.protein} g under on protein.
            </b>{" "}
            The assistant can lift it without moving your calories — and it will say what it moved.
          </span>
        </p>
      </section>

      {/* ====== §4 LIBRARY — sage-06's photograph on the page ground + sage-07's list card ====== */}
      <section className="mt-20 sm:mt-28">
        <div className="grid items-stretch gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-0">
          {/* SLOT: a photograph laid on the page and cropped by the LEFT edge — sage-06 does this
              with a bowl of pasta whose plate runs off the frame. No card, no radius, no caption. */}
          <div className="relative min-h-[340px] lg:min-h-[560px]">
            {bleedDish && imageForMeal(bleedDish.name) ? (
              <Image
                src={imageForMeal(bleedDish.name)!}
                alt={bleedDish.name}
                fill
                sizes="(max-width: 1024px) 100vw, 42vw"
                className="object-cover"
              />
            ) : (
              <div className="absolute inset-0" style={{ background: "var(--tile-6)" }} />
            )}
          </div>

          <div className="px-6 sm:px-10 lg:pl-12 xl:px-14">
            <span className="text-[10px] font-bold uppercase tracking-[0.26em] text-mut">
              The library
            </span>
            <h2 className="font-serif-display mt-4 max-w-[15ch] text-[clamp(28px,3.4vw,46px)] font-semibold leading-[1.02] tracking-[-0.03em]">
              {RECIPES.length} recipes. {shot.length} of them photographed.
            </h2>
            <p className="mt-4 max-w-[46ch] text-[13.5px] leading-relaxed text-plum-mid">
              A picture appears only on the dish it actually shows. The other{" "}
              {(RECIPES.length - shot.length).toLocaleString()} carry a typographic tile until
              their own photograph exists — partial coverage, honestly.
            </p>

            <ul className="mt-8 border-t border-plum/25">
              {listed.map((r) => (
                <li key={r.id} className="border-b border-line">
                  <div className="flex items-center gap-4 py-3.5">
                    <span className="relative h-11 w-11 shrink-0 overflow-hidden rounded-[6px]">
                      {imageForMeal(r.name) ? (
                        <Image
                          src={imageForMeal(r.name)!}
                          alt=""
                          fill
                          sizes="44px"
                          className="object-cover"
                        />
                      ) : (
                        <span
                          className="absolute inset-0"
                          style={{ background: gradientForMeal(r.name) }}
                        />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <b className="block truncate text-[14px] font-semibold tracking-[-0.01em]">
                        {r.name}
                      </b>
                      <span className="mt-0.5 block truncate text-[11.5px] text-mut">
                        {r.description}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-[11px] tabular-nums text-mut">
                      <b className="block text-[14px] font-bold tracking-[-0.02em] text-plum">
                        {r.calories.toLocaleString()}
                      </b>
                      {r.proteinGrams} g protein
                    </span>
                  </div>
                </li>
              ))}
            </ul>

            <Link
              href="/sage/explore"
              className="mt-7 inline-flex items-center gap-2 text-[13px] font-semibold text-vio hover:text-vio-deep"
            >
              Browse every recipe
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12h13M12 5.5 18.5 12 12 18.5" />
              </svg>
            </Link>
          </div>
        </div>
      </section>

      {/* ================= §5 the solid forest band — sage-03's full-width bar ================= */}
      <section className="mt-20 bg-panel px-6 py-14 text-white sm:mt-28 sm:px-10 sm:py-20 xl:px-14">
        <div className="flex flex-wrap items-end justify-between gap-8">
          <h2 className="font-serif-display max-w-[17ch] text-[clamp(28px,3.6vw,50px)] font-semibold leading-[1.02] tracking-[-0.03em]">
            Tell it what to change. It says what it moved.
          </h2>
          <Link
            href="/sage/assistant"
            className="rounded-full bg-cream px-6 py-3 text-[13px] font-semibold text-panel transition hover:bg-white"
          >
            Open the assistant
          </Link>
        </div>

        <dl className="mt-12 grid gap-px border-t border-white/15 pt-6 sm:grid-cols-3">
          {(
            [
              ["Hard rules", "Diet, allergies and exclusions are never traded for a macro."],
              ["Two layers", "The model decides what; deterministic code guarantees it is correct."],
              ["Honest", "If the engine adjusts a portion, the interface says so in words."],
            ] as const
          ).map(([term, def]) => (
            <div key={term} className="sm:pr-8">
              <dt className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/60">
                {term}
              </dt>
              <dd className="mt-2 max-w-[34ch] text-[13px] leading-relaxed text-white/75">{def}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
