import type { Metadata, Viewport } from "next";
import "./globals.css";

const TITLE = "NutriFlow — AI Meal Planner";
const DESCRIPTION =
  "Your week of meals, planned by AI and adjusted by chat. Import any recipe from a link; grocery list included.";

export const metadata: Metadata = {
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
    images: [{ url: "/food/bowl1.jpg", alt: "A balanced NutriFlow meal" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/food/bowl1.jpg"],
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
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
