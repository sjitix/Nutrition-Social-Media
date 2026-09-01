import AssistantChat from "./AssistantChat";
import { demoWeek, DEMO } from "../demo";

/**
 * The assistant. LIVE against `/api/assistant-v2` — the agent loop — rather than the typed
 * transcript this page used to be.
 *
 * The page stays a server component so the starting week is the same engine-generated one every
 * other /sage screen shows; only the conversation itself is a client component. That split matters
 * for a specific reason: `demo.ts` imports the engine, and the engine carries all 501 recipes, so
 * a client component importing it would ship the whole recipe database to the browser.
 *
 * What the reader is editing is the SAMPLE week, in their own browser, and the page says so. It is
 * not persisted — /sage has no per-reader storage — and claiming otherwise would be the kind of
 * quiet lie the rest of this design avoids.
 */
export default function SageAssistantPage() {
  const { raw } = demoWeek();

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

      <AssistantChat initialPlan={raw} profile={DEMO} />

      <p className="mt-6 max-w-[70ch] pb-14 text-[12px] leading-relaxed text-mut">
        You are editing the sample week shown across these screens, in your browser only — nothing
        here is saved. Every change is made by the engine and reported by it; the assistant decides
        what to do and never does the arithmetic. With no AI key configured the route answers in
        demo mode and leaves the plan alone, which is how the public deployment is set up on
        purpose.
      </p>
    </div>
  );
}
