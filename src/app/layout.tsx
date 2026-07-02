import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NutriFlow — AI Meal Planner",
  description:
    "Your week of meals, planned by AI and adjusted by chat. Grocery list included.",
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
