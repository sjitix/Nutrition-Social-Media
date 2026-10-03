/**
 * The accounts suites' shared fakes: a browser's storage and event targets, and an in-memory Supabase.
 * ONE copy, imported by `test-account.mts` and `test-account-tabs.mts`, so the two suites can never
 * disagree about what the backend does. A second copy would drift, and lesson 52 is what a fake that
 * drifts from the real backend costs.
 *
 * Nothing here installs a global. Each suite builds its own browser out of these pieces.
 */
import { createHash } from "node:crypto";
import type { UserProfile, WeekPlan } from "@/lib/types";

export class MemoryStorage {
  private m = new Map<string, string>();
  /** Total characters allowed, like a browser's per-origin quota. Infinity unless a test sets it. */
  quota = Infinity;
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) {
    const next = String(v);
    const used = [...this.m.entries()].reduce((s, [key, val]) => s + (key === k ? 0 : key.length + val.length), 0);
    if (used + k.length + next.length > this.quota) throw new Error("QuotaExceededError");
    this.m.set(k, next);
  }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  keys() { return [...this.m.keys()]; }
}

export class Events {
  private l = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(t: string, f: (e: unknown) => void) { (this.l.get(t) ?? this.l.set(t, new Set()).get(t)!).add(f); }
  removeEventListener(t: string, f: (e: unknown) => void) { this.l.get(t)?.delete(f); }
  dispatch(t: string, e: unknown = {}) { for (const f of [...(this.l.get(t) ?? [])]) f(e); }
  count(t: string) { return this.l.get(t)?.size ?? 0; }
}

/** Postgres jsonb's key order: shorter keys first, then by bytes. Values come back from the account so. */
export function jsonbOrder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(jsonbOrder);
  if (v && typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map((k) => [k, jsonbOrder((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export function fakeJwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}
export const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** An in-memory Supabase: GoTrue's PKCE sign-in and refresh, PostgREST with RLS, upsert_state, jsonb key order. */
export class FakeSupabase {
  users = new Map<string, { id: string; email: string }>();
  rows = new Map<string, Map<string, { value: unknown; updated_at: string }>>();
  access = new Map<string, string>();
  refresh = new Map<string, string>();
  codes = new Map<string, { email: string; challenge: string; at: number }>();
  lastCode = new Map<string, string>();
  down = false;
  refuseRefresh = false;
  /** A store whose rows Postgres refuses (e.g. a value jsonb can't hold); a batch containing it fails whole. */
  refuseKey: string | null = null;
  /** Make the next N pulls fail with a 503 while everything else works (a transient server error). */
  failPulls = 0;
  /** Make pulls take this long, so a test can act while one is in flight. */
  pullDelayMs = 0;
  /** Lifetime of the next issued access token, in seconds (negative = already expired). */
  nextExpiresIn = 3600;
  /** How far the SERVER's clock is from this process's: `expires_at` is stamped on the server's. */
  serverSkewMs = 0;
  /** Make the next N code exchanges fail with a 503 (a transient server error). */
  failExchange = 0;
  /** Make code exchanges take this long, so a test can act while one is in flight. */
  exchangeDelayMs = 0;
  /**
   * How long a link's code can be exchanged after the link was REQUESTED. GoTrue's default for a new
   * user's first link ("Confirm email" on) is 300 s, counted from the request; Infinity unless set.
   */
  codeTtlMs = Infinity;
  writes = 0;
  logouts = 0;
  private n = 0;
  /**
   * Refuse every access token issued so far, as PostgREST does once one is past its expiry or revoked.
   * Refresh tokens stay good, as they do on the real platform.
   */
  revokeAccess() {
    this.access.clear();
  }
  user(email: string) {
    const id = `uid-${email.split("@")[0]}`;
    if (!this.users.has(id)) this.users.set(id, { id, email });
    return this.users.get(id)!;
  }
  private issue(id: string) {
    const u = this.users.get(id)!;
    const access = fakeJwt({ sub: id, email: u.email, n: ++this.n });
    const refresh = `rt-${this.n}`;
    this.access.set(access, id);
    this.refresh.set(refresh, id);
    const expiresIn = this.nextExpiresIn;
    this.nextExpiresIn = 3600;
    // GoTrue always sends both: the lifetime, and `expires_at` on the SERVER's clock.
    const expiresAt = Math.floor((Date.now() + this.serverSkewMs) / 1000) + expiresIn;
    return { access_token: access, refresh_token: refresh, expires_in: expiresIn, expires_at: expiresAt, user: u };
  }
  /** Hand out a session directly (as an attacker would have for their OWN account). */
  sessionFor(email: string) {
    return this.issue(this.user(email).id);
  }
  table(id: string) {
    return this.rows.get(id) ?? this.rows.set(id, new Map()).get(id)!;
  }
  fetch = (async (input: string, init: RequestInit = {}) => {
    if (this.down) throw new TypeError("Failed to fetch");
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const reply = (status: number, data?: unknown) => new Response(data === undefined ? null : JSON.stringify(data), { status });
    if (headers.apikey !== "ANON") return reply(401, { message: "No API key found in request" });

    if (url.pathname === "/auth/v1/otp" && method === "POST") {
      if (!body?.code_challenge) return reply(400, { msg: "this fake only does PKCE" });
      this.user(body.email);
      const code = `code${++this.n}xyz`;
      this.codes.set(code, { email: body.email, challenge: body.code_challenge, at: Date.now() });
      this.lastCode.set(body.email, code);
      return reply(200, {});
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      if (this.exchangeDelayMs) await new Promise((r) => setTimeout(r, this.exchangeDelayMs));
      if (this.failExchange > 0) {
        this.failExchange--;
        return reply(503, { message: "upstream timeout" });
      }
      const c = this.codes.get(body?.auth_code);
      if (!c) return reply(404, { error_code: "flow_state_not_found" });
      if (Date.now() - c.at > this.codeTtlMs) return reply(422, { error_code: "flow_state_expired", msg: "invalid flow state, flow state has expired" });
      if (s256(body.code_verifier ?? "") !== c.challenge) return reply(400, { error_code: "bad_code_verifier" });
      this.codes.delete(body.auth_code); // one use
      return reply(200, this.issue(this.user(c.email).id));
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      const id = this.refresh.get(body?.refresh_token);
      if (!id || this.refuseRefresh || !this.users.has(id)) return reply(400, { error: "invalid_grant", error_description: "Invalid Refresh Token" });
      this.refresh.delete(body.refresh_token); // rotation: an old refresh token works once
      return reply(200, this.issue(id));
    }
    const uid = this.access.get((headers.Authorization ?? "").replace(/^Bearer /, ""));
    if (url.pathname === "/auth/v1/logout") {
      if (!uid) return reply(403, { error_code: "bad_jwt" });
      this.logouts++;
      return reply(204);
    }
    if (!uid || !this.users.has(uid)) return reply(401, { code: "PGRST303", message: "JWT expired" });

    if (url.pathname === "/rest/v1/rpc/delete_my_account" && method === "POST") {
      this.users.delete(uid);
      this.rows.delete(uid);
      return reply(204);
    }
    if (url.pathname === "/rest/v1/rpc/upsert_state" && method === "POST") {
      const incoming = (body?.rows ?? []) as { key: string; value: unknown; updated_at: string }[];
      // One SQL statement: refused whole.
      if (this.refuseKey && incoming.some((r) => r.key === this.refuseKey)) return reply(400, { code: "22P05", message: "unsupported Unicode escape sequence" });
      if (incoming.some((r) => JSON.stringify(r.value).length > 1_000_000)) return reply(400, { code: "23514", message: "user_state_value_size" });
      const skipped: string[] = [];
      for (const r of incoming) {
        const cur = this.table(uid).get(r.key);
        if (cur && Date.parse(cur.updated_at) >= Date.parse(r.updated_at)) skipped.push(r.key);
        else this.table(uid).set(r.key, { value: jsonbOrder(r.value), updated_at: r.updated_at });
      }
      this.writes++;
      return reply(200, skipped);
    }
    if (url.pathname === "/rest/v1/user_state") {
      const filterUser = (url.searchParams.get("user_id") ?? "").replace(/^eq\./, "");
      // RLS: only your own rows exist, whatever the filter says.
      const mine = filterUser && filterUser !== uid ? new Map() : this.table(uid);
      if (method === "GET") {
        if (this.failPulls > 0) {
          this.failPulls--;
          return reply(503, { message: "upstream timeout" });
        }
        if (this.pullDelayMs) await new Promise((r) => setTimeout(r, this.pullDelayMs));
        return reply(200, [...mine.entries()].map(([key, r]) => ({ key, value: r.value, updated_at: r.updated_at })));
      }
      if (method === "DELETE") {
        this.rows.delete(uid);
        return reply(204);
      }
    }
    return reply(404, { message: `no route ${method} ${url.pathname}` });
  }) as typeof fetch;
}

// ---- fixtures ------------------------------------------------------------------------------------
export const PROFILE: UserProfile = {
  name: "Ana", goal: "maintain", diet: "none", allergies: "", dislikes: "", budget: "medium",
  mealsPerDay: 3, targetCalories: 2000, proteinGrams: 150, carbsGrams: 200, fatGrams: 65,
  maxCookTime: 30, maxIngredients: 10,
};
function meal(name: string, type: "breakfast" | "lunch" | "dinner") {
  return {
    name, type, description: "", calories: 600, proteinGrams: 45, carbsGrams: 60, fatGrams: 20,
    timeMinutes: 20, ingredients: [{ name: "rice", quantity: "80 g" }], steps: ["cook"],
  };
}
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export function week(tag: string): WeekPlan {
  return {
    days: DAYS.map((day) => ({ day, meals: [meal(`${tag} oats`, "breakfast"), meal(`${tag} bowl`, "lunch"), meal(`${tag} stew`, "dinner")] })),
    weekSummary: `week ${tag}`,
  } as WeekPlan;
}
export const summary = (v: unknown) => (v as WeekPlan | null)?.weekSummary;
