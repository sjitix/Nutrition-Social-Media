import type { NextConfig } from "next";

/**
 * STATIC_EXPORT=1 produces a fully static site in out/, used by the GitHub Pages workflow to
 * publish a public preview of the design. The /sage screens are server components that call no
 * API, so they prerender completely.
 *
 * BASE_PATH is needed because GitHub Pages serves a project site from a subdirectory
 * (/Nutrition-Social-Media), and without it every asset and link would resolve against the domain
 * root and 404.
 *
 * The default build is untouched: with neither variable set this is an ordinary Next app with
 * working API routes, which is what `npm run dev` and any real deploy use.
 */
const nextConfig: NextConfig = process.env.STATIC_EXPORT
  ? {
      output: "export",
      images: { unoptimized: true },
      trailingSlash: true,
      basePath: process.env.BASE_PATH || "",
    }
  : {};

export default nextConfig;
