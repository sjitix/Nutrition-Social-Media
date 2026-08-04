interface IconProps {
  className?: string;
}

function base(className?: string) {
  return {
    className: className ?? "h-4 w-4",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    viewBox: "0 0 24 24",
    // Decorative — the accompanying text or the button's aria-label carries the meaning, so screen
    // readers shouldn't also announce the icon.
    "aria-hidden": true,
  };
}

export const HomeIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
  </svg>
);

export const CalendarIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </svg>
);

export const CartIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <circle cx="9" cy="21" r="1" />
    <circle cx="20" cy="21" r="1" />
    <path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6" />
  </svg>
);

export const ChatIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
  </svg>
);

export const CompassIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <circle cx="12" cy="12" r="10" />
    <path d="M16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z" />
  </svg>
);

export const PlusIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const CheckIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

export const ZapIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>
);

export const PlayIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M5 3l14 9-14 9V3z" />
  </svg>
);

export const ClockIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const RefreshIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M23 4v6h-6M1 20v-6h6" />
    <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
  </svg>
);

export const SendIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
  </svg>
);

// Save / favourite. Outline when unsaved, solid when saved — same language as the star.
export const HeartIcon = ({ className, filled = false }: IconProps & { filled?: boolean }) => (
  <svg {...base(className)} fill={filled ? "currentColor" : "none"}>
    <path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z" />
  </svg>
);

// Magnifier — feed search.
export const SearchIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </svg>
);

// Outbound link — used on an imported meal to open its original recipe page.
export const ExternalLinkIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
    <path d="M15 3h6v6M10 14L21 3" />
  </svg>
);

// A star that can be outline (unrated) or solid (rated). Same line-icon language as the rest —
// `filled` just swaps the fill so a rating reads at a glance without any emoji.
export const StarIcon = ({ className, filled = false }: IconProps & { filled?: boolean }) => (
  <svg {...base(className)} fill={filled ? "currentColor" : "none"}>
    <path d="M12 2.5l2.9 5.9 6.6.95-4.75 4.63 1.12 6.52L12 17.9l-5.9 3.1 1.12-6.52L2.5 9.85l6.6-.95z" />
  </svg>
);

// A pin/thumbtack for "keep this meal every week". `filled` marks a currently-pinned slot.
export const PinIcon = ({ className, filled = false }: IconProps & { filled?: boolean }) => (
  <svg {...base(className)} fill={filled ? "currentColor" : "none"}>
    <path d="M12 17v5" />
    <path d="M9 3h6l-1 6 3 3H7l3-3z" />
  </svg>
);

export const XIcon = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

export const Wordmark = ({ light = false }: { light?: boolean }) => (
  <span
    className={`font-display text-lg font-bold tracking-tight ${light ? "text-white" : "text-plum"}`}
  >
    NutriFlow
    <span className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-vio" />
  </span>
);
