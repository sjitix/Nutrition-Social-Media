import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NutriFlow — AI Meal Planner",
  description:
    "Your week of meals, planned by AI and adjusted by chat. Grocery list included.",
  applicationName: "NutriFlow",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  appleWebApp: { capable: true, title: "NutriFlow", statusBarStyle: "default" },
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
