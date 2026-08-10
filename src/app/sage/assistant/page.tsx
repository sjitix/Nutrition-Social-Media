import { demoWeek, DEMO } from "../demo";

/**
 * The assistant. A static conversation, but every number in it is pulled from the same generated
 * week as every other tab — including the shortfall it offers to fix, so the reply cannot
 * contradict the board on /sage/plan.
 *
 * Presentation follows the boards: the itemised changes are a hairline-ruled list (sage-07's
 * recipe card), and the outcome of each turn is a deep panel carrying the figure (sage-06). What
 * the assistant MOVED is the product's personality, so it is set as data, not as prose in a bubble.
 */
export default function SageAssistantPage() {
  const { lowest, avgProtein } = demoWeek();
  const short = DEMO.proteinGrams - lowest.protein;
  const swap = lowest.meals[1];

  const turns = [
    {
      me: "make thursday vegetarian but keep my protein up",
      reply: "Thursday is vegetarian and still lands on target.",
      changes: [
        ["Lunch", "Beef & Broccoli Rice Bowl → Tempeh & Quinoa Protein Bowl"],
        ["Dinner", "Turkey & Bean Chilli → Red Lentil Dahl, portion ×1.2"],
      ],
      outcome: { value: "1,988", unit: "kcal · 128 g protein", note: "7 g under — the best any vegetarian combination reaches today, and it says so rather than rounding up." },
    },
    // The second turn is written from the week's own weakest day, so it cannot contradict the
    // board on /sage/plan. When the week already reaches the target — which it does once the plan
    // is re-solved — the turn becomes the honest-decline case instead of claiming a fix nothing
    // needed. "I made your on-target day on-target" is the kind of sentence that costs trust.
    short > 0
      ? {
          me: `${lowest.day.toLowerCase()} looks low on protein, fix it`,
          reply: `${lowest.day} was ${short} g short. Lifted without touching your calories.`,
          changes: [
            ["Swapped", `${swap?.name ?? "Lunch"} → a higher-protein dish in the same slot`],
            ["Adjusted", "Portions nudged within realistic limits so the day still lands at target"],
          ],
          outcome: { value: `${avgProtein} g`, unit: `of ${DEMO.proteinGrams} g`, note: "Week average before the change. The engine reports what moved; the model does no arithmetic." },
        }
      : {
          me: `${lowest.day.toLowerCase()} looks low on protein, fix it`,
          reply: `${lowest.day} is already at ${lowest.protein} g. Nothing to lift.`,
          changes: [
            ["Checked", `Every meal on ${lowest.day}, against your ${DEMO.proteinGrams} g target`],
            ["Changed", "Nothing — a change that improves nothing is not worth the disruption"],
          ],
          outcome: { value: `${avgProtein} g`, unit: `of ${DEMO.proteinGrams} g`, note: "The week average. Refusing a pointless edit is a feature: the plan you already have is the answer." },
        },
  ];

  return (
    <div className="px-6 pt-10 sm:px-10 sm:pt-12 xl:px-14">
      <div className="border-b border-plum/25 pb-6">
        <span className="text-[10px] font-bold uppercase tracking-[0.26em] text-mut">
          It changes the plan, and says what it moved
        </span>
        <h1 className="font-serif-display mt-4 max-w-[14ch] text-[clamp(34px,4.6vw,62px)] font-semibold leading-[0.95] tracking-[-0.035em]">
          Just tell it.
        </h1>
      </div>

      <div className="mt-8 max-w-[880px]">
        {turns.map((t, i) => (
          <section key={i} className="mb-10">
            <p className="inline-block rounded-[10px] bg-tint px-4 py-3 text-[14.5px] leading-relaxed">
              {t.me}
            </p>

            <div className="mt-3 grid gap-3 lg:grid-cols-[1.35fr_0.65fr]">
              <div className="rounded-[12px] bg-cream p-6">
                <p className="font-serif-display text-[20px] font-semibold leading-[1.15] tracking-[-0.02em]">
                  {t.reply}
                </p>
                <dl className="mt-5 border-t border-line">
                  {t.changes.map(([tag, text]) => (
                    <div key={tag} className="flex gap-4 border-b border-line py-3">
                      <dt className="w-[74px] shrink-0 pt-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-mut">
                        {tag}
                      </dt>
                      <dd className="text-[12.5px] leading-relaxed text-plum-mid">{text}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              <div className="flex flex-col justify-between rounded-[12px] bg-panel p-6 text-white">
                <span className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-white/60">
                  Result
                </span>
                <p className="mt-6 text-[34px] font-bold leading-[0.9] tracking-[-0.045em] tabular-nums">
                  {t.outcome.value}
                  <span className="ml-1.5 block pt-2 text-[12px] font-medium tracking-normal text-white/60">
                    {t.outcome.unit}
                  </span>
                </p>
                <p className="mt-5 border-t border-white/15 pt-3.5 text-[11.5px] leading-relaxed text-white/65">
                  {t.outcome.note}
                </p>
              </div>
            </div>
          </section>
        ))}

        <div className="flex max-w-[880px] items-center gap-2.5 border-t border-plum/25 pt-5">
          <span className="flex-1 rounded-full bg-tint px-5 py-3.5 text-[13.5px] text-mut">
            Tell it what to change…
          </span>
          <button className="rounded-full bg-vio px-6 py-3.5 text-[12.5px] font-semibold text-white transition hover:bg-vio-deep">
            Send
          </button>
        </div>
        <p className="mt-4 max-w-[70ch] text-[12px] leading-relaxed text-mut">
          Read-only in this preview. The live assistant runs against `/api/assistant`, which is in
          demo mode on the public URL — no key is set, deliberately.
        </p>
      </div>
    </div>
  );
}
