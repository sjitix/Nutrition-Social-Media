import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ThemeSwitch, THEME_BOOT_SCRIPT } from "@/components/ThemeSwitch";

const TITLE = "NutriFlow — AI Meal Planner";
const DESCRIPTION =
  "Your week of meals, planned by AI and adjusted by chat. Import any recipe from a link; grocery list included.";

export const metadata: Metadata = {
  // So Open Graph / Twitter image URLs resolve to the real domain in production instead of
  // localhost. Set NEXT_PUBLIC_SITE_URL at deploy time; falls back to localhost for dev.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "NutriFlow",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  appleWebApp: { capable: true, title: "NutriFlow", statusBarStyle: "default" },
  // Rich previews when a NutriFlow link is shared (the social/virality loop).
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    siteName: "NutriFlow",
    // No image: the stock food photos were removed (one stood in for 46 different recipes).
    // A missing OG image degrades to a text card; a BROKEN one renders as a grey box on every
    // share, which is worse for the thing this block exists for. Restore with a real branded
    // share card when the visual language is settled.
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
  },
};

// Mobile-first: tint the browser/status bar to match the app chrome, and keep the layout at device
// width so a phone renders the responsive design instead of a zoomed-out desktop page.
export const viewport: Viewport = {
  themeColor: "#2d2650",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/* Applies the stored theme before first paint, so a returning sage user
            never sees a violet flash. Must be inline and blocking to beat the
            first render; a component cannot run early enough. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">
        {children}
        <ThemeSwitch />
      </body>
    </html>
  );
}
