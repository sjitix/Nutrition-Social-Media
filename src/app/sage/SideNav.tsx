"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarIcon,
  CartIcon,
  ChatIcon,
  ClockIcon,
  CompassIcon,
  HomeIcon,
} from "@/components/icons";

/**
 * The sidebar nav, and the mobile bar that replaces it.
 *
 * A client component only because it needs the current path to mark the active item — everything
 * it links to stays a server component.
 *
 * The active item is a solid CREAM pill on the forest panel, which is what the reference boards
 * do (sage-10 / sage-12): the selected row is the one light block in the dark column. A tinted
 * hover state would have been the safer choice and reads as generic; the boards are emphatic.
 */
const TABS = [
  ["/sage", "Home", HomeIcon],
  ["/sage/today", "Today", ClockIcon],
  ["/sage/plan", "Week", CalendarIcon],
  ["/sage/explore", "Explore", CompassIcon],
  ["/sage/groceries", "Groceries", CartIcon],
  ["/sage/assistant", "Assistant", ChatIcon],
] as const;

// Exact match for Home, prefix for the rest, so /sage/plan does not light up Home.
function isActive(href: string, path: string) {
  return href === "/sage" ? path === "/sage" : path.startsWith(href);
}

export function SideNav({ collapsed = false }: { collapsed?: boolean }) {
  const path = usePathname();

  return (
    <nav className="flex flex-col gap-0.5" aria-label="Sections">
      {TABS.map(([href, label, Icon]) => {
        const active = isActive(href, path);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            // Collapsed, the label is still in the DOM for a screen reader — visually hidden, not
            // removed. `title` gives the sighted reader the same thing on hover.
            title={collapsed ? label : undefined}
            // Every fragment ends with a space. Without one, `px-0` + `bg-cream` concatenated into
            // `px-0bg-cream` and the collapsed rail silently lost its active pill AND its padding —
            // a class name built by joining strings fails by producing a DIFFERENT class, not by
            // producing nothing, so nothing warns.
            className={
              "flex items-center rounded-[9px] py-2.5 text-[13.5px] transition " +
              (collapsed ? "justify-center px-0 " : "gap-3 px-3.5 ") +
              (active
                ? "bg-cream font-semibold text-plum shadow-[0_1px_3px_rgba(28,36,25,0.10)]"
                : "font-medium text-mut hover:bg-cream/70 hover:text-plum")
            }
          >
            <Icon className="h-[15px] w-[15px] shrink-0" />
            <span className={collapsed ? "sr-only" : undefined}>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/** Below `lg` the panel becomes a bar. Targets stay >= 44px tall, which the pill padding gives. */
export function MobileNav() {
  const path = usePathname();

  return (
    <nav
      className="flex gap-1.5 overflow-x-auto px-4 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="Sections"
    >
      {TABS.map(([href, label]) => {
        const active = isActive(href, path);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={
              // py-3 on a 13px line box clears the 44px touch target the accessibility pass set.
              "shrink-0 rounded-full px-4 py-3 text-[13px] transition " +
              (active ? "bg-cream font-semibold text-plum" : "font-medium text-mut")
            }
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
