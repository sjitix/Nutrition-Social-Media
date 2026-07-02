import type { ChatMessage, UserProfile, WeekPlan } from "./types";

// Client-side persistence. Phase 1 keeps all state in the browser; a real
// database + accounts arrive when we need cross-device sync.

const KEYS = {
  profile: "nutriflow.profile",
  plan: "nutriflow.plan",
  chat: "nutriflow.chat",
} as const;

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

export function clearAll(): void {
  Object.values(KEYS).forEach((k) => window.localStorage.removeItem(k));
}
