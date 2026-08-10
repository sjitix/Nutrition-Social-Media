import { FEED_RECIPES } from "@/lib/feed";
import { ExploreClient } from "./ExploreClient";

/** The library. Heading is server-rendered; the filtering below it is live in the browser. */
export default function SageExplorePage() {
  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-5">
        <div>
          <span className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-mut">
            {FEED_RECIPES.length} recipes · macros from USDA data
          </span>
          <h1 className="mt-2 text-[clamp(28px,4vw,44px)] font-bold leading-tight tracking-[-0.04em]">
            Find something to cook.
          </h1>
        </div>
        <button className="rounded-full border border-line px-5 py-2.5 text-[13px] font-semibold transition hover:border-vio">
          Import from a link
        </button>
      </div>

      <ExploreClient />
    </>
  );
}
