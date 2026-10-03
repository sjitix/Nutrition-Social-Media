// One browser TAB, for scripts/test-account-tabs.mts: its own instance of the real storage.ts and
// client.ts, so module state (the running sync, the status, every listener) belongs to this tab alone,
// as it does in a browser. scripts/test-account.mjs bundles this once per tab, with esbuild `define`
// pointing `window`, `document` and `history` at that tab's own objects.
export * as storage from "@/lib/storage";
export * as client from "@/lib/account/client";
