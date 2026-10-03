/**
 * Supabase, spoken directly over its REST API — sign-in (GoTrue) and the `user_state` table
 * (PostgREST) — with no SDK.
 *
 * WHY NO `@supabase/supabase-js`: this app needs five calls (request a magic link, read the redirect,
 * refresh a token, read/write one table, call one function). The SDK would add a dependency to a
 * `package.json` both lanes share and tens of kB to every screen that syncs; five `fetch` calls add
 * neither, and they are testable with a fake `fetch` (`scripts/test-account.mts`).
 *
 * `fetch` is INJECTED into every function. Nothing here touches `window` or storage: the browser glue
 * (`client.ts`) supplies the session and persists it.
 *
 * With no URL/key configured, `readAccountConfig()` returns null and nothing in this file is ever
 * called — the app is exactly what it was before accounts (VISION: "$0 is a floor").
 */
import type { StoreName } from "../storage";
import type { Remote, RemoteRow } from "./sync";

export interface AccountConfig {
  url: string;
  anonKey: string;
}

/**
 * The project's public URL and anon key, or null when accounts are not switched on for this build.
 * Written as two literal `process.env.NEXT_PUBLIC_…` reads because Next inlines exactly that form
 * into the client bundle at build time and nothing else.
 */
export function readAccountConfig(
  env: { url?: string; anonKey?: string } = {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
): AccountConfig | null {
  const url = env.url?.trim().replace(/\/+$/, "");
  const anonKey = env.anonKey?.trim();
  if (!url || !anonKey || !/^https?:\/\//.test(url)) return null;
  return { url, anonKey };
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Seconds since epoch when the access token stops working. */
  expiresAt: number;
  userId: string;
  email: string;
}

type Fetch = typeof fetch;

export class AccountError extends Error {}

/* ------------------------------------------------------------------------------------------------
 * Sign-in: an email magic link. No passwords to store, leak or reset.
 * ---------------------------------------------------------------------------------------------- */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Ask for a sign-in link. The person clicks it in their email and lands back on `redirectTo`. */
export async function requestMagicLink(cfg: AccountConfig, email: string, redirectTo: string, f: Fetch = fetch): Promise<void> {
  const address = email.trim();
  if (!EMAIL.test(address)) throw new AccountError("That doesn't look like an email address.");
  const res = await call(f, `${cfg.url}/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: "POST",
    headers: base(cfg),
    body: JSON.stringify({ email: address, create_user: true }),
  });
  if (res.status === 429) throw new AccountError("Too many sign-in emails just now. Wait a minute, then try again.");
  if (!res.ok) throw new AccountError(await errorText(res, "Couldn't send the sign-in email."));
}

/**
 * Read the session out of the URL the magic link lands on: `#access_token=…&refresh_token=…`.
 * Returns null when the URL carries no sign-in at all, and throws when it carries a FAILED one
 * (an expired or already-used link), so the page can say which happened.
 */
export function sessionFromRedirect(hash: string, nowSec: number = Math.floor(Date.now() / 1000)): Session | null {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const err = p.get("error_description") ?? p.get("error");
  if (err) {
    throw new AccountError(/expired|invalid/i.test(err)
      ? "That sign-in link has expired or was already used. Ask for a new one."
      : `Sign-in didn't complete: ${err.replace(/\+/g, " ")}`);
  }
  const accessToken = p.get("access_token");
  const refreshToken = p.get("refresh_token");
  if (!accessToken || !refreshToken) return null;
  const claims = jwtClaims(accessToken);
  if (!claims?.sub) throw new AccountError("The sign-in link returned a token this app can't read.");
  const expiresAt = Number(p.get("expires_at")) || nowSec + (Number(p.get("expires_in")) || 3600);
  return { accessToken, refreshToken, expiresAt, userId: claims.sub, email: claims.email ?? "" };
}

/** Swap a refresh token for a new session. Supabase rotates refresh tokens, so keep the new one. */
export async function refreshSession(cfg: AccountConfig, refreshToken: string, f: Fetch = fetch, nowSec = Math.floor(Date.now() / 1000)): Promise<Session> {
  const res = await call(f, `${cfg.url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: base(cfg),
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) throw new AccountError("Your sign-in has expired. Sign in again to keep syncing.");
  const d = (await res.json()) as {
    access_token?: string; refresh_token?: string; expires_in?: number; expires_at?: number;
    user?: { id?: string; email?: string };
  };
  if (!d.access_token || !d.refresh_token) throw new AccountError("Your sign-in has expired. Sign in again to keep syncing.");
  const claims = jwtClaims(d.access_token);
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresAt: d.expires_at ?? nowSec + (d.expires_in ?? 3600),
    userId: d.user?.id ?? claims?.sub ?? "",
    email: d.user?.email ?? claims?.email ?? "",
  };
}

/** A session good for at least another minute — refreshed if it isn't. */
export async function freshSession(cfg: AccountConfig, s: Session, f: Fetch = fetch, nowSec = Math.floor(Date.now() / 1000)): Promise<Session> {
  return s.expiresAt - nowSec > 60 ? s : refreshSession(cfg, s.refreshToken, f, nowSec);
}

/** End the session on the server. Best effort: signing out locally must work even offline. */
export async function signOutRemote(cfg: AccountConfig, s: Session, f: Fetch = fetch): Promise<void> {
  try {
    await call(f, `${cfg.url}/auth/v1/logout`, { method: "POST", headers: authed(cfg, s) });
  } catch {
    /* offline — the local session is dropped regardless */
  }
}

/** Delete the account and, by cascade, every row it owns (supabase/migrations: delete_my_account). */
export async function deleteAccountRemote(cfg: AccountConfig, s: Session, f: Fetch = fetch): Promise<void> {
  const res = await call(f, `${cfg.url}/rest/v1/rpc/delete_my_account`, {
    method: "POST",
    headers: { ...authed(cfg, s), "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new AccountError(await errorText(res, "Couldn't delete the account just now. Nothing was deleted."));
}

/* ------------------------------------------------------------------------------------------------
 * The table: the `Remote` that `sync.ts` drives.
 * ---------------------------------------------------------------------------------------------- */

interface Row {
  key: StoreName;
  value: unknown;
  updated_at: string;
}

/**
 * The account side of sync, over PostgREST. `session` is asked for on EVERY call so a token refreshed
 * between calls is always the one used. RLS (supabase/migrations) is what limits each call to the
 * signed-in user's rows; the explicit `user_id` filter and field are belt-and-braces, not the guard.
 */
export function supabaseRemote(cfg: AccountConfig, session: () => Promise<Session>, f: Fetch = fetch): Remote {
  const table = `${cfg.url}/rest/v1/user_state`;
  return {
    async pull(): Promise<RemoteRow[]> {
      const s = await session();
      const res = await call(f, `${table}?select=key,value,updated_at&user_id=eq.${s.userId}`, { headers: authed(cfg, s) });
      if (!res.ok) throw new AccountError(await errorText(res, "Couldn't read your account."));
      const rows = (await res.json()) as Row[];
      return rows.map((r) => ({ name: r.key, value: r.value, at: Date.parse(r.updated_at) || 0 }));
    },
    async push(rows: RemoteRow[]): Promise<void> {
      if (!rows.length) return;
      const s = await session();
      const res = await call(f, `${table}?on_conflict=user_id,key`, {
        method: "POST",
        headers: {
          ...authed(cfg, s),
          "Content-Type": "application/json",
          // Upsert: one row per (user, store), replaced in place.
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(rows.map((r) => ({
          user_id: s.userId,
          key: r.name,
          value: r.value ?? null,
          updated_at: new Date(r.at).toISOString(),
        }))),
      });
      if (!res.ok) throw new AccountError(await errorText(res, "Couldn't save to your account."));
    },
    async removeAll(): Promise<void> {
      const s = await session();
      const res = await call(f, `${table}?user_id=eq.${s.userId}`, { method: "DELETE", headers: authed(cfg, s) });
      if (!res.ok) throw new AccountError(await errorText(res, "Couldn't clear your account."));
    },
  };
}

/* ------------------------------------------------------------------------------------------------ */

function base(cfg: AccountConfig): Record<string, string> {
  return { apikey: cfg.anonKey, "Content-Type": "application/json" };
}
function authed(cfg: AccountConfig, s: Session): Record<string, string> {
  return { apikey: cfg.anonKey, Authorization: `Bearer ${s.accessToken}` };
}

/** fetch, with "the network is down" turned into a sentence rather than a TypeError. */
async function call(f: Fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await f(url, init);
  } catch {
    throw new AccountError("Couldn't reach your account — you may be offline. Your data is safe on this device.");
  }
}

async function errorText(res: Response, fallback: string): Promise<string> {
  try {
    const d = (await res.json()) as { msg?: string; message?: string; error_description?: string };
    const m = d.msg ?? d.error_description ?? d.message;
    return m ? `${fallback} (${m})` : fallback;
  } catch {
    return fallback;
  }
}

/** The payload of a JWT, unverified — used only to learn the user's id and email for display and
 *  for the `user_id` field. The SERVER verifies the token on every request; this never authorises. */
export function jwtClaims(token: string): { sub?: string; email?: string } | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const text = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
    return JSON.parse(decodeURIComponent(escape(text))) as { sub?: string; email?: string };
  } catch {
    return null;
  }
}
