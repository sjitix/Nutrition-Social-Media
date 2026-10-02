"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The dialog shell every direct-manipulation panel sits in.
 *
 * A real `role="dialog"`, not a styled div: Escape closes it, the page behind does not scroll, focus
 * moves in and comes back out to whatever opened it, and Tab stays inside. Those four are the
 * difference between a modal and a trap, and they are easy to leave out.
 *
 * The mechanics here are the ones `explore/RecipeModal.tsx` already proved in use — extracted so a
 * second panel does not become a second copy of them. RecipeModal predates this and still carries
 * its own; folding it onto this shell is a tidy-up for the presentation split, not for today.
 */
export function Sheet({
  title,
  labelledBy,
  onClose,
  children,
  footer,
}: {
  title: string;
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();

    // Locking with `overflow` alone makes the page jump sideways by the scrollbar's width as it
    // disappears, which reads as the layout breaking. Pad the body by the width we removed.
    const { overflow, paddingRight } = document.body.style;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (gap > 0) document.body.style.paddingRight = `${gap}px`;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
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
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
      returnTo?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-plum-deep/45 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full max-w-[560px] overflow-y-auto rounded-t-[16px] bg-bgsoft shadow-2xl sm:rounded-[16px]"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-bgsoft px-5 py-4">
          <h2 id={labelledBy} className="text-[16px] font-bold leading-tight tracking-[-0.02em]">
            {title}
          </h2>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 shrink-0 rounded-full p-2 text-mut transition hover:bg-tint hover:text-plum"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="sticky bottom-0 border-t border-line bg-bgsoft px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}
