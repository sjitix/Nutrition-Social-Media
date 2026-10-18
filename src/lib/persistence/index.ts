// persistence — the browser's own copy of everything a person keeps: one key per store, and the only
// folder that names one (check:boundaries rule 3): storage.ts for the stores, theme.ts for the theme's
// key. storage.ts re-exports theme.ts, so this one line offers both. Browser-safe: no zod, no engine.
// V1 D5a (2026-10-18). savedStore lives in account/, not here: it chooses between this and the
// account, so here it would close a cycle (account/client -> persistence -> savedStore -> account/client).
export * from "./storage";
