import type { ChatMessage, UserProfile, WeekPlan } from "./types";
import type { ImportedRecipe } from "./import";

// Client-side persistence. Phase 1 keeps all state in the browser; a real
// database + accounts arrive when we need cross-device sync.

const KEYS = {
  profile: "nutriflow.profile",
  plan: "nutriflow.plan",
  chat: "nutriflow.chat",
  imports: "nutriflow.imports",
} as const;

const IMPORTS_CAP = 24;

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

export function clearAll(): void {
  Object.values(KEYS).forEach((k) => window.localStorage.removeItem(k));
}
