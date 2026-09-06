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
 * The server hands it the shared demo week; on the client, AssistantChat swaps in THIS person's
 * saved plan if they have one and persists the engine's edits back to it (so the Week and Groceries
 * screens reflect them). A first-time visitor with no saved plan edits the sample, in-browser only,
 * and the disclaimer under the chat says exactly which of the two is happening — no quiet lie.
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
    </div>
  );
}
