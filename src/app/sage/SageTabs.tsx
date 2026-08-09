"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The tab strip. A client component only because it needs the current path to mark
 * the active tab — everything it links to stays a server component.
 */
const TABS = [
  ["/sage", "Home"],
  ["/sage/plan", "Plan"],
  ["/sage/explore", "Explore"],
  ["/sage/groceries", "Groceries"],
  ["/sage/assistant", "Assistant"],
] as const;

export function SageTabs() {
  const path = usePathname();

  return (
    <div className="flex flex-wrap gap-1">
      {TABS.map(([href, label]) => {
        // Exact match for Home, prefix for the rest, so /sage/plan does not light up Home.
        const active = href === "/sage" ? path === "/sage" : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={
              "rounded-full px-4 py-2 text-[13.5px] transition " +
              (active
                ? "bg-vio font-semibold text-white"
                : "font-medium text-plum-mid hover:bg-lav hover:text-plum")
            }
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}
