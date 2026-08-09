import { demoWeek, DEMO } from "../demo";

/**
 * The assistant. Static conversation, but the numbers in it are pulled from the same
 * generated week as every other tab — including the shortfall it offers to fix, so the
 * reply cannot contradict the board on /sage/plan.
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
        ["Lunch", "Beef & Broccoli Rice Bowl → **Tempeh & Quinoa Protein Bowl**"],
        ["Dinner", "Turkey & Bean Chilli → **Red Lentil Dahl**, portion ×1.2"],
        ["Result", "**1,988 kcal · 128 g protein** — 7 g under, the best any vegetarian combination reaches today"],
      ],
    },
    {
      me: `${lowest.day.toLowerCase()} looks low on protein, fix it`,
      reply: `${lowest.day} was ${short} g short. Lifted without touching your calories.`,
      changes: [
        ["Swapped", `${swap?.name ?? "Lunch"} → a higher-protein dish in the same slot`],
        ["Adjusted", "Portions nudged within realistic limits so the day still lands at target"],
        ["Result", `Week average moves from **${avgProtein} g** toward your ${DEMO.proteinGrams} g target`],
      ],
    },
  ];

  return (
    <>
      <div className="mb-6">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-mut">
          It changes the plan, and says what it moved
        </span>
        <h1 className="mt-2 text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-[-0.04em]">
          Just tell it.
        </h1>
      </div>

      <div className="flex max-w-[760px] flex-col gap-4">
        {turns.map((t, i) => (
          <div key={i} className="contents">
            <div className="flex gap-3">
              <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg bg-lav text-[11.5px] font-bold text-plum-mid">
                A
              </span>
              <p className="rounded-2xl bg-lav px-4 py-3.5 text-[14.5px] leading-relaxed">{t.me}</p>
            </div>

            <div className="flex gap-3">
              <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg bg-vio text-[11.5px] font-bold text-white">
                N
              </span>
              <div className="card-shadow rounded-2xl bg-white px-4 py-3.5 text-[14.5px] leading-relaxed">
                {t.reply}
                <div className="mt-3 flex flex-col gap-1.5">
                  {t.changes.map(([tag, text]) => (
                    <div key={tag} className="flex gap-3 rounded-xl bg-lav px-3 py-2.5 text-[12.5px]">
                      <span className="w-[68px] shrink-0 pt-0.5 text-[9.5px] font-bold uppercase tracking-[0.13em] text-mut">
                        {tag}
                      </span>
                      <span dangerouslySetInnerHTML={{ __html: text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>") }} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 flex max-w-[760px] gap-2.5">
        <span className="card-shadow flex-1 rounded-full border border-line bg-white px-5 py-3.5 text-[14px] text-mut">
          Tell it what to change…
        </span>
        <button className="rounded-full bg-vio px-6 py-3.5 text-[13px] font-semibold text-white transition hover:bg-vio-deep">
          Send
        </button>
      </div>
    </>
  );
}
