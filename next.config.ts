import type { NextConfig } from "next";

/**
 * STATIC_EXPORT=1 produces a fully static site in out/, used by the GitHub Pages workflow to
 * publish a public preview of the design. The /sage screens prerender completely, because their
 * pages are server components rendered from a fixed week.
 *
 * ONE of them is no longer purely static at runtime: /sage/assistant embeds a client component
 * that posts to /api/assistant-v2. It still PRERENDERS fine — what ships is the empty
 * conversation — but on Pages there is no server, so that request returns the 404 page. The
 * component detects exactly this (a response that will not parse as JSON) and says the preview
 * has no server, rather than failing in a way that reads like a broken assistant.
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
