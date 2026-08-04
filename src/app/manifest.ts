import type { MetadataRoute } from "next";

// A web app manifest so NutriFlow can be installed to a phone's home screen and run standalone
// (no browser chrome) — the app-like experience a mobile-first, widely-used product needs.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "NutriFlow — AI Meal Planner",
    short_name: "NutriFlow",
    description: "Your week of meals, planned by AI, adjusted by chat, with the grocery list built in.",
    start_url: "/",
    display: "standalone",
    background_color: "#f3f1fb",
    theme_color: "#2d2650",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
