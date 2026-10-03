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
import type { PushResult, Remote, RemoteRow } from "./sync";

export interface AccountConfig {
  url: string;
  anonKey: string;
}

/**
 * The project's public URL and key, or null when accounts are not switched on for this build.
 * Written as literal `process.env.NEXT_PUBLIC_…` reads because Next inlines exactly that form into
 * the client bundle at build time and nothing else.
 *
 * The key is the PUBLISHABLE key (`sb_publishable_…`), which Supabase's Connect dialog names
 * `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, or the legacy anon key under the older name. Either name
 * works, so pasting Supabase's own snippet switches accounts on (review 2: with only the old name, it
 * silently left them off). The legacy anon keys are being deactivated, so prefer the publishable one.
 */
export function readAccountConfig(
  env: { url?: string; anonKey?: string } = {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
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

/**
 * What went wrong, in a form the sync layer can ACT on, not only show:
 *  - `network`  — couldn't reach the server at all. Retry later; nothing is wrong with the data.
 *  - `server`   — the server was reachable but busy or broken (429, 5xx). Retry later.
 *  - `auth`     — the sign-in is no longer valid (an expired or revoked refresh token). Retrying
 *                 cannot help; the person has to sign in again.
 *  - `rejected` — the server refused THIS request (a check constraint, a malformed row). Retrying the
 *                 same request will fail the same way forever, so it must not block everything else.
 *  - `superseded` — this browser is now signed in as SOMEONE ELSE (another tab signed in). Whatever was
 *                 running for the previous account must stop at once and must not touch the new one.
 */
export type AccountErrorKind = "network" | "server" | "auth" | "rejected" | "superseded";

export class AccountError extends Error {
  constructor(message: string, readonly kind: AccountErrorKind = "rejected") {
    super(message);
  }
  /** Whether trying the same thing again later could succeed. */
  get retryable(): boolean {
    return this.kind === "network" || this.kind === "server";
  }
}

/** Classify a failed response. 401 means the token was refused; 429 and 5xx are transient. */
function kindOf(status: number): AccountErrorKind {
  if (status === 401) return "auth";
  if (status === 429 || status >= 500) return "server";
  return "rejected";
}

/* ------------------------------------------------------------------------------------------------
 * Sign-in: an email magic link, with PKCE. No passwords to store, leak or reset.
 *
 * WHY PKCE AND NOT THE PLAIN ("IMPLICIT") LINK. A plain link lands with the session tokens in the
 * URL fragment, and a page that accepts whatever tokens arrive that way can be signed into ANYONE'S
 * account by a link someone else made — after which this browser's profile (health notes included)
 * would upload into a stranger's account (login CSRF; the adversarial review reproduced it). With PKCE
 * this browser keeps a secret (the verifier) when it ASKS for a link; the link carries only a one-time
 * code, and that code is worthless without the verifier. A sign-in therefore only completes in the
 * browser that started it. Tokens in a URL fragment are ignored entirely.
 *
 * Request and exchange shapes are from the GoTrue source (supabase/auth): `OtpParams` takes
 * `code_challenge` + `code_challenge_method`, a non-empty challenge selects the PKCE flow, the verified
 * link redirects with `?code=`, and `/token?grant_type=pkce` takes `{auth_code, code_verifier}`.
 * ---------------------------------------------------------------------------------------------- */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** base64url without padding — the encoding PKCE uses for the challenge. */
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A fresh PKCE pair: a 64-character random verifier (kept in this browser) and its S256 challenge (sent
 * with the link request). The verifier uses only the unreserved characters RFC 7636 allows.
 */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const random = new Uint8Array(48);
  crypto.getRandomValues(random);
  const verifier = base64url(random); // 64 chars of [A-Za-z0-9_-]
  return { verifier, challenge: await challengeFor(verifier) };
}

/** The S256 challenge for a verifier: what a link request carries in place of the secret itself. */
export async function challengeFor(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** Whether a string can be an email address. Checked before anything is stored or sent. */
export function looksLikeEmail(address: string): boolean {
  return EMAIL.test(address.trim());
}

/** Ask for a sign-in link. The person clicks it in their email and lands back on `redirectTo`. */
export async function requestMagicLink(
  cfg: AccountConfig,
  email: string,
  redirectTo: string,
  codeChallenge: string,
  f: Fetch = fetch,
): Promise<void> {
  const address = email.trim();
  if (!EMAIL.test(address)) throw new AccountError("That doesn't look like an email address.");
  const res = await call(f, `${cfg.url}/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: "POST",
    headers: base(cfg),
    body: JSON.stringify({ email: address, create_user: true, code_challenge: codeChallenge, code_challenge_method: "s256" }),
  });
  // The limit is per HOUR on Supabase (and very low on its built-in mailer), so "a minute" would be a lie.
  if (res.status === 429) throw new AccountError(await errorText(res, "Too many sign-in emails have been sent recently. Try again later."), "server");
  if (!res.ok) throw new AccountError(await errorText(res, "Couldn't send the sign-in email."), kindOf(res.status));
}

/** What the URL a sign-in link lands on says. */
export type RedirectResult =
  | { kind: "none" }
  | { kind: "code"; code: string }
  | { kind: "error"; message: string };

/**
 * Fixed sentences for the failures a link can report. The error text in a URL is attacker-controlled
 * (anyone can make a link to this page with any `error_description`), so it is NEVER shown; only a
 * known `error_code` chooses which of OUR sentences to show.
 */
const LINK_ERRORS: Record<string, string> = {
  otp_expired: "That sign-in link has expired or was already used. Ask for a new one.",
  access_denied: "That sign-in link has expired or was already used. Ask for a new one.",
  flow_state_expired: "That sign-in link took too long to open: a first link works for five minutes after you ask for it. Ask for a new one, and open it straight away.",
  flow_state_not_found: "That sign-in link was opened in a different browser from the one that asked for it. Ask for a new one here.",
};
const LINK_ERROR_FALLBACK = "Sign-in didn't complete. Ask for a new link.";

/**
 * Read a landing URL. PKCE reports success as `?code=` and failure as `?error=…&error_code=…` (GoTrue
 * also mirrors errors into the fragment); both places are read for errors. A fragment carrying
 * `access_token` is deliberately NOT a sign-in — see the section header.
 */
export function readRedirect(search: string, hash: string): RedirectResult {
  const q = new URLSearchParams(search.replace(/^\?/, ""));
  const h = new URLSearchParams(hash.replace(/^#/, ""));
  const code = q.get("error_code") ?? h.get("error_code");
  const err = q.get("error") ?? h.get("error");
  if (err || code) return { kind: "error", message: (code && LINK_ERRORS[code]) || (err && LINK_ERRORS[err]) || LINK_ERROR_FALLBACK };
  const authCode = q.get("code");
  if (authCode && /^[A-Za-z0-9._~-]{8,512}$/.test(authCode)) return { kind: "code", code: authCode };
  return { kind: "none" };
}

/** Does this URL carry anything sign-in related that must be cleared from the address bar? */
export function hasAuthParams(search: string, hash: string): boolean {
  return /(^|[?&#])(code|error|error_code|error_description|access_token|refresh_token)=/.test(`${search}#${hash.replace(/^#/, "")}`);
}

/** Exchange the one-time code from a link for a session, proving this browser asked with the verifier. */
export async function exchangeCode(
  cfg: AccountConfig,
  code: string,
  verifier: string,
  f: Fetch = fetch,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<Session> {
  const res = await call(f, `${cfg.url}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: base(cfg),
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  // 422 is GoTrue's flow_state_expired. A new user's FIRST link (Supabase's "Confirm email", on by
  // default) expires five minutes after it was REQUESTED, not after it was opened, so a link opened
  // six minutes later lands here (review 2). The emailed link was used up when it was opened, so the
  // only way forward is a new one, and saying "try the link again" would send them in a circle.
  if (res.status === 422) throw new AccountError(LINK_ERRORS.flow_state_expired, "auth");
  if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
    throw new AccountError("That sign-in link has expired, was already used, or was opened in a different browser from the one that asked for it. Ask for a new one here.", "auth");
  }
  // Transient (offline, 429, 5xx): the code is still good for a few minutes, so the caller keeps it,
  // with its verifier, and offers to try the exchange again. Opening the link again would not work.
  if (!res.ok) throw new AccountError("Couldn't finish signing in just now.", kindOf(res.status));
  const s = sessionFromTokenResponse(await res.json(), nowSec);
  if (!s) throw new AccountError(LINK_ERROR_FALLBACK, "auth");
  return s;
}

/** The session in a GoTrue token response, or null if it isn't one. */
function sessionFromTokenResponse(raw: unknown, nowSec: number): Session | null {
  const d = raw as {
    access_token?: string; refresh_token?: string; expires_in?: number; expires_at?: number;
    user?: { id?: string; email?: string };
  };
  if (!d || !d.access_token || !d.refresh_token) return null;
  const claims = jwtClaims(d.access_token);
  const userId = d.user?.id ?? claims?.sub ?? "";
  if (!userId) return null;
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    // Measured on THIS DEVICE's clock: now plus the token's lifetime. GoTrue's `expires_at` is the
    // SERVER's clock, and comparing it with the device's made a device a few minutes slow keep
    // sending a token the server had already expired; the 401 then signed the person out with a
    // refresh token that was still good (review 2). `expires_at` is used only if no lifetime comes.
    expiresAt: typeof d.expires_in === "number" ? nowSec + d.expires_in : d.expires_at ?? nowSec + 3600,
    userId,
    email: d.user?.email ?? claims?.email ?? "",
  };
}

/** Swap a refresh token for a new session. Supabase rotates refresh tokens, so keep the new one. */
export async function refreshSession(cfg: AccountConfig, refreshToken: string, f: Fetch = fetch, nowSec = Math.floor(Date.now() / 1000)): Promise<Session> {
  const res = await call(f, `${cfg.url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: base(cfg),
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  // A refused refresh token comes back 400 (invalid_grant) or 401: the sign-in is over and only a new
  // one can fix it. Anything else (429, 5xx) is the server having a moment — retry later, and do NOT
  // throw away a session that is still good.
  if (res.status === 400 || res.status === 401) {
    throw new AccountError("Your sign-in has expired. Sign in again to keep syncing.", "auth");
  }
  if (!res.ok) throw new AccountError("Couldn't renew your sign-in just now. It will try again.", kindOf(res.status));
  const s = sessionFromTokenResponse(await res.json(), nowSec);
  if (!s) throw new AccountError("Your sign-in has expired. Sign in again to keep syncing.", "auth");
  return s;
}

/** A session good for at least another minute — refreshed if it isn't. */
export async function freshSession(cfg: AccountConfig, s: Session, f: Fetch = fetch, nowSec = Math.floor(Date.now() / 1000)): Promise<Session> {
  return s.expiresAt - nowSec > 60 ? s : refreshSession(cfg, s.refreshToken, f, nowSec);
}

/**
 * End this browser's session on the server. Returns whether the server confirmed it — the caller
 * signs out locally either way, but must not CLAIM the server session ended when it didn't (an expired
 * access token is refused by /logout, which would otherwise leave a live refresh token behind silently).
 */
export async function signOutRemote(cfg: AccountConfig, s: Session, f: Fetch = fetch): Promise<boolean> {
  try {
    // scope=local ends THIS browser's session only. Without it GoTrue defaults to global and signs the
    // person out of every device, silently stopping sync on their phone because they left a laptop.
    const res = await call(f, `${cfg.url}/auth/v1/logout?scope=local`, { method: "POST", headers: authed(cfg, s) });
    if (res.ok) return true;
    // Already ended on the server (another tab or device signed it out): the outcome asked for, not a
    // failure to report. Any other refusal (403 bad_jwt: an expired access token) leaves it alive.
    const code = await res.json().then((d: { error_code?: string; code?: string }) => d?.error_code ?? d?.code, () => undefined);
    return (res.status === 403 || res.status === 404) && code === "session_not_found";
  } catch {
    return false; // offline — the local session is dropped regardless
  }
}

/** Delete the account and, by cascade, every row it owns (supabase/migrations: delete_my_account). */
export async function deleteAccountRemote(cfg: AccountConfig, session: Session | SessionSource, f: Fetch = fetch): Promise<void> {
  const res = await authorized(f, sourceOf(session), (s) => [`${cfg.url}/rest/v1/rpc/delete_my_account`, {
    method: "POST",
    headers: { ...authed(cfg, s), "Content-Type": "application/json" },
    body: "{}",
  }], "Couldn't delete the account just now. Nothing was deleted.");
  if (!res.ok) throw new AccountError(await errorText(res, "Couldn't delete the account just now. Nothing was deleted."), kindOf(res.status));
}

/**
 * Where an authorised request gets its session. `renew` asks for a refreshed one whatever the local
 * expiry says: what `authorized` does when the server refuses the access token it was given.
 */
export type SessionSource = (opts?: { renew?: boolean }) => Promise<Session>;

const sourceOf = (s: Session | SessionSource): SessionSource => (typeof s === "function" ? s : async () => s);

/**
 * Make an authorised request, and if the server refuses the access token (401), renew it once and
 * try again.
 *
 * A refused ACCESS token is not a dead sign-in. The clock that judged it fresh may be off, or the
 * token may have been revoked a moment ago. Treating every 401 as "signed out" (as this once did)
 * threw away refresh tokens that were still good, signing people out every hour on a device whose
 * clock was a few minutes slow (review 2). Only a refused REFRESH means signed out: the renewal
 * throws "auth" then. A second 401, even with a just-renewed token, means the server refused something
 * other than the sign-in (this app's key, say). That is reported as a retryable outage, which keeps
 * the sign-in and the queued edits.
 */
async function authorized(
  f: Fetch,
  session: SessionSource,
  request: (s: Session) => [string, RequestInit],
  refused = "Your account refused this app's request. Your data is safe on this device, and it will try again.",
): Promise<Response> {
  const first = await call(f, ...request(await session()));
  if (first.status !== 401) return first;
  const renewed = await session({ renew: true });
  const second = await call(f, ...request(renewed));
  if (second.status === 401) throw new AccountError(await errorText(second, refused), "server");
  return second;
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
export function supabaseRemote(cfg: AccountConfig, session: SessionSource, f: Fetch = fetch): Remote {
  const table = `${cfg.url}/rest/v1/user_state`;
  return {
    async pull(): Promise<RemoteRow[]> {
      const res = await authorized(f, session, (s) => [
        `${table}?select=key,value,updated_at&user_id=eq.${encodeURIComponent(s.userId)}`,
        { headers: authed(cfg, s) },
      ]);
      if (!res.ok) throw new AccountError(await errorText(res, "Couldn't read your account."), kindOf(res.status));
      const rows = (await res.json()) as Row[];
      return rows.map((r) => ({ name: r.key, value: r.value, at: Date.parse(r.updated_at) || 0 }));
    },
    async push(rows: RemoteRow[]): Promise<PushResult> {
      if (!rows.length) return { skipped: [] };
      // Through upsert_state (supabase/migrations/0002), which writes a store only if this write is
      // NEWER than the account's copy and returns the keys it skipped. A plain table upsert would let a
      // device that was offline for days overwrite a newer week from another device. The user id is
      // not sent: the function takes it from the verified token.
      const body = JSON.stringify({
        rows: rows.map((r) => ({
          key: r.name,
          value: wellFormed(r.value ?? null),
          updated_at: new Date(r.at).toISOString(),
        })),
      });
      const res = await authorized(f, session, (s) => [`${cfg.url}/rest/v1/rpc/upsert_state`, {
        method: "POST",
        headers: { ...authed(cfg, s), "Content-Type": "application/json" },
        body,
      }]);
      if (!res.ok) throw new AccountError(await errorText(res, "Couldn't save to your account."), kindOf(res.status));
      const skipped = (await res.json().catch(() => [])) as unknown;
      const sent = new Set(rows.map((r) => r.name));
      return {
        skipped: Array.isArray(skipped) ? skipped.filter((k): k is StoreName => typeof k === "string" && sent.has(k as StoreName)) : [],
      };
    },
    async removeAll(): Promise<void> {
      const res = await authorized(f, session, (s) => [
        `${table}?user_id=eq.${encodeURIComponent(s.userId)}`,
        { method: "DELETE", headers: authed(cfg, s) },
      ]);
      if (!res.ok) throw new AccountError(await errorText(res, "Couldn't clear your account."), kindOf(res.status));
    },
  };
}

/**
 * A copy of a value with every string made well-formed: lone UTF-16 surrogates (half an emoji, left
 * by cutting a string at a fixed length) and NUL characters become U+FFFD.
 *
 * Postgres jsonb REFUSES both, and PostgREST sends a batch as one statement, so a single bad character
 * anywhere in one store would fail the whole push — every store, every time. Cleaning on the way out
 * costs a character that was already broken.
 */
export function wellFormed(v: unknown): unknown {
  if (typeof v === "string") {
    return v.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u0000/g, "\uFFFD");
  }
  if (Array.isArray(v)) return v.map(wellFormed);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [wellFormed(k) as string, wellFormed(x)]));
  }
  return v;
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
    throw new AccountError("Couldn't reach your account — you may be offline. Your data is safe on this device.", "network");
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
