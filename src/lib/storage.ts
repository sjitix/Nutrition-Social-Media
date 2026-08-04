import type { ChatMessage, UserProfile, WeekPlan } from "./types";
import type { ImportedRecipe } from "./import";

// Client-side persistence. Phase 1 keeps all state in the browser; a real
// database + accounts arrive when we need cross-device sync.

const KEYS = {
  profile: "nutriflow.profile",
  plan: "nutriflow.plan",
  chat: "nutriflow.chat",
  imports: "nutriflow.imports",
  saved: "nutriflow.saved",
  groceriesChecked: "nutriflow.groceriesChecked",
  visits: "nutriflow.visits",
} as const;

const IMPORTS_CAP = 24;
const VISITS_CAP = 400; // ~13 months of daily-use history is plenty for a streak

function read<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  window.localStorage.setItem(key, JSON.stringify(value));
}

export const loadProfile = () => read<UserProfile>(KEYS.profile);
export const saveProfile = (p: UserProfile) => write(KEYS.profile, p);

export const loadPlan = () => read<WeekPlan>(KEYS.plan);
export const savePlan = (p: WeekPlan) => write(KEYS.plan, p);

export const loadChat = () => read<ChatMessage[]>(KEYS.chat) ?? [];
export const saveChat = (m: ChatMessage[]) => write(KEYS.chat, m);

// A history of recipes imported from a link, newest first, deduped by source URL. Lets someone
// re-add something they imported before without re-fetching it.
export const loadImports = () => read<ImportedRecipe[]>(KEYS.imports) ?? [];
export function rememberImport(r: ImportedRecipe): ImportedRecipe[] {
  const rest = loadImports().filter((x) => x.sourceUrl !== r.sourceUrl);
  const next = [r, ...rest].slice(0, IMPORTS_CAP);
  write(KEYS.imports, next);
  return next;
}

// Saved / favorited recipes, by name (works for both library and imported recipes).
export const loadSaved = () => read<string[]>(KEYS.saved) ?? [];
export function toggleSaved(name: string): string[] {
  const cur = loadSaved();
  const next = cur.includes(name) ? cur.filter((n) => n !== name) : [name, ...cur];
  write(KEYS.saved, next);
  return next;
}

// Which grocery items are ticked off, by their lowercased name key, so a mid-shop reload keeps them.
export const loadGroceriesChecked = () => read<string[]>(KEYS.groceriesChecked) ?? [];
export const saveGroceriesChecked = (keys: string[]) => write(KEYS.groceriesChecked, keys);

// Days the app was opened (ISO "YYYY-MM-DD"), for the daily-use streak. Recording today is
// idempotent, and the list is capped and kept sorted-newest-first.
export const loadVisits = () => read<string[]>(KEYS.visits) ?? [];
export function recordVisit(todayIso: string): string[] {
  const cur = loadVisits();
  if (cur.includes(todayIso)) return cur;
  const next = [todayIso, ...cur].sort((a, b) => (a < b ? 1 : -1)).slice(0, VISITS_CAP);
  write(KEYS.visits, next);
  return next;
}

export function clearAll(): void {
  Object.values(KEYS).forEach((k) => window.localStorage.removeItem(k));
}
