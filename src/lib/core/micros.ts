/**
 * The micronutrient VOCABULARY: which nine nutrients the app tracks, what each is called and in what
 * unit. It is a contract every layer speaks (the symptom and condition tables name them, the maths
 * sums them, the UI labels them), not maths, so it lives at L0 (V1 D5a, 2026-10-03). It sat in
 * nutrients.ts, which made the data tables in data/ import upward from the maths layer — two listed
 * debts of the boundary gate. nutrients.ts re-exports all of it, so no caller changed.
 */
export const MICRO_KEYS = [
  "iron", "calcium", "magnesium", "potassium", "zinc", "vitD", "vitC", "folate", "b12",
] as const;
export type MicroKey = (typeof MICRO_KEYS)[number];
export type Micros = Record<MicroKey, number>;

export const MICRO_LABEL: Record<MicroKey, string> = {
  iron: "iron", calcium: "calcium", magnesium: "magnesium", potassium: "potassium",
  zinc: "zinc", vitD: "vitamin D", vitC: "vitamin C", folate: "folate", b12: "vitamin B12",
};

export const MICRO_UNIT: Record<MicroKey, string> = {
  iron: "mg", calcium: "mg", magnesium: "mg", potassium: "mg", zinc: "mg",
  vitD: "µg", vitC: "mg", folate: "µg", b12: "µg",
};
