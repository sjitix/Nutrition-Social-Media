// core, browser-safe: the vocabulary WITHOUT zod (types.ts carries every schema).
// V1 D5a part 3 (2026-10-03). Only what someone outside this folder uses is here; everything else in
// the folder is private, and check:boundaries fails an import that reaches past this file.
export * from "./slots";
export * from "./micros";
export * from "./imported";
export * from "./defaults";
