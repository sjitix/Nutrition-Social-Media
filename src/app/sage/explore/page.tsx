import { FEED_RECIPES } from "@/lib/feed";
import { ExploreClient } from "./ExploreClient";

/** The library. Heading is server-rendered; the filtering below it is live in the browser. */
export default function SageExplorePage() {
  // Counted off the feed itself, not off the size of the image map — a map key that no longer
  // matches a recipe would inflate the claim while rendering nothing.
  const photographed = FEED_RECIPES.filter((f) => f.image).length;

  return (
    <div className="px-6 pt-10 sm:px-10 sm:pt-12 xl:px-14">
      <div className="flex flex-wrap items-end justify-between gap-5 pb-7">
        <div>
          <span className="text-[10px] font-bold uppercase tracking-[0.26em] text-mut">
            {FEED_RECIPES.length} recipes · {photographed} photographed
          </span>
          <h1 className="font-serif-display mt-4 max-w-[13ch] text-[clamp(34px,4.6vw,62px)] font-semibold leading-[0.95] tracking-[-0.035em]">
            Find something to cook.
          </h1>
        </div>
        <button className="rounded-full bg-vio px-5 py-2.5 text-[12.5px] font-semibold text-white transition hover:bg-vio-deep">
          Import from a link
        </button>
      </div>

      <ExploreClient />
    </div>
  );
}
