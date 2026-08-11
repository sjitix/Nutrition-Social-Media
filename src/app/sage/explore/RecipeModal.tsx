"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";
import type { FeedItem } from "@/lib/feed";

/**
 * The full recipe: everything the library holds about one dish.
 *
 * It needs no fetch. `FeedItem.meal` already carries the ingredients, the steps and every macro,
 * because the whole library is bundled for the filtering — so opening a recipe is instant and works
 * on the static export with no server behind it.
 *
 * A real `role="dialog"`, not a styled div: Escape closes it, the page behind does not scroll, focus
 * moves in on open and returns to the card on close. The meal drawer in `/plan` was made a proper
 * modal in the accessibility pass; a second one that was not would be a regression.
 */
export function RecipeModal({
  item,
  saved,
  onToggleSave,
  onClose,
}: {
  item: FeedItem;
  saved: boolean;
  onToggleSave: () => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();

    // Scroll-lock by overflow alone makes the page jump by the scrollbar's width as it disappears.
    const { overflow, paddingRight } = document.body.style;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // A minimal focus trap: keep Tab inside the panel rather than letting it walk the wall of
      // cards behind, which is what makes a dialog usable from the keyboard at all.
      if (e.key !== "Tab" || !panel.current) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
      returnTo?.focus();
    };
  }, [onClose]);

  const m = item.meal;
  const macros = [
    [m.calories.toLocaleString(), "kcal"],
    [`${m.proteinGrams}`, "g protein"],
    [`${m.carbsGrams}`, "g carbs"],
    [`${m.fatGrams}`, "g fat"],
    [`${m.fiberGrams ?? 0}`, "g fibre"],
  ] as const;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-panel/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      onMouseDown={(e) => {
        // mousedown, not click: a click that STARTED inside the panel and ended on the backdrop
        // (a text selection dragged out of it) would otherwise close the dialog.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="recipe-title"
        className="max-h-[92vh] w-full max-w-[860px] overflow-y-auto rounded-t-[16px] bg-bgsoft sm:rounded-[16px]"
      >
        {/* the photograph, or the dish's own typographic tile — never another dish's picture */}
        <div className="relative aspect-[16/9] w-full">
          {item.image ? (
            <Image src={item.image} alt={m.name} fill sizes="(max-width: 860px) 100vw, 860px" className="object-cover" />
          ) : (
            <div className="absolute inset-0" style={{ background: item.gradient }}>
              <div className="absolute inset-0 bg-gradient-to-t from-panel/80 via-panel/20 to-transparent" />
            </div>
          )}

          <button
            ref={closeButton}
            onClick={onClose}
            className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-bgsoft text-plum transition hover:bg-cream"
          >
            <span className="sr-only">Close</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>

          <div className="absolute inset-x-0 bottom-0 p-5 sm:p-7">
            <span className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-white/75">
              {m.type} · {m.timeMinutes} min
              {item.dietTags.length > 0 && ` · ${item.dietTags.map((t) => t.replace("_", " ")).join(" · ")}`}
            </span>
            <h2
              id="recipe-title"
              className="font-serif-display mt-2 text-balance text-[clamp(26px,4vw,40px)] font-semibold leading-[1.04] tracking-[-0.03em] text-white"
            >
              {m.name}
            </h2>
          </div>
        </div>

        <div className="p-5 sm:p-7">
          <p className="max-w-[62ch] text-[13.5px] leading-[1.7] text-plum-mid">{m.description}</p>

          {/* Macros, hairline-ruled, in the boards' data style. Every figure is derived from the
              ingredient list against USDA data — none of it is written on the recipe. */}
          <div className="mt-6 flex flex-wrap border-t border-line pt-4">
            {macros.map(([v, l], i) => (
              <p key={l} className={"min-w-[86px] flex-1 " + (i ? "border-l border-line pl-4" : "")}>
                <b className="block text-[21px] font-bold tracking-[-0.03em] tabular-nums">{v}</b>
                <span className="mt-0.5 block text-[9.5px] font-bold uppercase tracking-[0.14em] text-mut">
                  {l}
                </span>
              </p>
            ))}
          </div>

          <div className="mt-8 grid gap-8 sm:grid-cols-[0.85fr_1.15fr]">
            <div>
              <h3 className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-mut">
                What goes in it
              </h3>
              <ul className="mt-3">
                {m.ingredients.map((ing) => (
                  <li
                    key={ing.name}
                    className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 text-[13px]"
                  >
                    <span>{ing.name}</span>
                    <span className="shrink-0 tabular-nums text-mut">{ing.quantity}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-mut">
                How to cook it
              </h3>
              <ol className="mt-3">
                {m.steps.map((step, i) => (
                  <li key={i} className="flex gap-3.5 border-b border-line py-3 text-[13px] leading-[1.6]">
                    <span className="mt-[1px] grid h-[21px] w-[21px] shrink-0 place-items-center rounded-full bg-tint text-[10.5px] font-bold tabular-nums">
                      {i + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              {m.steps.length === 0 && (
                <p className="mt-3 text-[13px] text-mut">
                  No method is recorded for this dish yet — the ingredients and macros are complete,
                  the steps are not. Saying so beats inventing them.
                </p>
              )}
            </div>
          </div>

          <div className="mt-8 flex flex-wrap gap-2.5 border-t border-line pt-5">
            <button
              onClick={onToggleSave}
              aria-pressed={saved}
              className={
                "inline-flex items-center gap-2 rounded-full px-6 py-3 text-[13px] font-semibold transition " +
                (saved ? "bg-vio text-white hover:bg-vio-deep" : "bg-tint text-plum hover:bg-line")
              }
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
                <path d="M6 4h12v16l-6-4.5L6 20z" />
              </svg>
              {saved ? "Saved" : "Save this recipe"}
            </button>
            <button
              onClick={onClose}
              className="rounded-full px-6 py-3 text-[13px] font-semibold text-mut transition hover:text-plum"
            >
              Back to the library
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
