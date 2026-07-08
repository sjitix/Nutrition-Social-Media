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
