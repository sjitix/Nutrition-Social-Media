/**
 * THE LOCAL LIVE RUN: the real client.ts and storage.ts against the REAL GoTrue, PostgREST and Postgres
 * (scripts/account-live/stack.sh), not the fake every other suite uses. Run by scripts/account-live/run.mjs,
 * which brings the stack up, bundles one copy of the app's modules per device, and tears it all down.
 *
 * Why it exists: this lane's worst bugs hid behind fakes that were kinder than the platform (lesson 52).
 * Every check here is something only the real servers can answer: the email GoTrue really sends and
 * where its link really lands, its 60-second limit and one-link-per-person rule, token rotation and
 * PostgREST's answer to an expired token, RLS and upsert_state as PostgREST really runs them, and what a
 * deleted account's still-valid token really gets back.
 *
 * EVERY CHECK MUST BE ABLE TO FAIL FOR THE REASON ITS NAME GIVES (the 2026-10-18 review of this file).
 * The first version's RLS write check forged a row Sam already had, so a broken insert policy still got a
 * refusal, from the primary key; its renewal never sent an expired token; and nothing looked at where a
 * link landed. Each check below names what it proves and asserts exactly that, preconditions included.
 *
 * Devices: Sam's laptop and phone (separate browsers), Rob on a browser of his own, a fourth browser
 * ("Late") where Max asks for a link that the desk then opens, and which later opens a link Rob already
 * used, and two more ("Desk", "Tablet") that Ivy and Jo each ask from in turn: GoTrue issues a link's
 * code for the person's LATEST request, whichever browser made it.
 * Jo later signs in on the desk as well, and signs out there: only that browser's session may end. And
 * one more browser, seen at two web addresses, each with storage of its own: a preview deployment the
 * allow list does not admit ("Prev"), where Kai asks, and the Site URL's account page ("Site"), where
 * GoTrue sends that link instead. Lee uses the same two: asks at the Site URL, leaves it, then asks on
 * the preview, so that link lands where Lee's earlier request is still held. And four browsers
 * ("ConfA" to "ConfD") talk to a second GoTrue with "Confirm email" on, a hosted project's default, where
 * Nia, Oli and Pat are new: a first link's five minutes, and a refused request that takes nothing over.
 */
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { MemoryStorage, Events, PROFILE, week, summary } from "../account-fakes";

type Device = { storage: typeof import("@/lib/persistence"); client: typeof import("@/lib/account/client") };
type Session = { accessToken: string; refreshToken: string; expiresAt: number; userId: string; email: string };
type Win = Events & {
  localStorage: MemoryStorage;
  sessionStorage: MemoryStorage;
  location: { origin: string; pathname: string; search: string; hash: string; reload: () => void };
};
type Logged = { n: number; method: string; path: string; status: number; token: string | null };

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SECRET = process.env.LIVE_JWT_SECRET!;
const PAGE = "http://localhost:3000/sage/account"; // where every device asks for its link, so where it must land
/** Step 3's Site URL, as stack.sh sets it: where GoTrue sends a link whose return address it refuses. */
const SITE_URL = "https://ntrux.vercel.app/sage/account";
/** A preview deployment's account page: another host than the Site URL's, and not on the allow list. */
const PREVIEW = "https://ntrux-git-preview.vercel.app/sage/account";
const windows: Record<string, Win> = {};
const docs: Record<string, Events & { visibilityState: "visible" | "hidden" }> = {};
const landed: Record<string, string> = {};

function makeDevice(name: string, at = PAGE) {
  const page = new URL(at);
  const window = Object.assign(new Events(), {
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    location: { origin: page.origin, pathname: page.pathname, search: "", hash: "", reload: () => {} },
  }) as Win;
  const document = Object.assign(new Events(), { visibilityState: "visible" as "visible" | "hidden" });
  const history = {
    replaceState: (_s: unknown, _t: string, url: string) => {
      const u = new URL(url, window.location.origin);
      window.location.pathname = u.pathname;
      window.location.search = u.search;
      window.location.hash = u.hash;
    },
  };
  windows[name] = window;
  docs[name] = document;
  (globalThis as unknown as Record<string, unknown>)[`__TAB_${name}`] = { window, document, history };
}
const load = async (page: string): Promise<Device> => import(new URL(`./account-tab-${page}.mjs`, import.meta.url).href);

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; failures.push(label); console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ""}`); }
}
const json = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const errText = (v: unknown) => (v instanceof Error ? v.message : json(v));
async function mayThrow<T>(p: Promise<T>): Promise<T | Error> {
  try { return await p; } catch (e) { return e as Error; }
}
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 4000) {
  for (let t = 0; t < ms; t += 100) {
    if (await cond()) return true;
    await sleep(100);
  }
  return cond();
}

// ---- the real servers, seen from outside the app ----
const seen = new Map<string, number>();
/** The newest sign-in email for this address, once it arrives (GoTrue sends it, the catcher keeps it). */
async function newMail(email: string): Promise<string> {
  let last: { status: number; n?: number; url?: string } = { status: 0 };
  for (let i = 0; i < 80; i++) {
    const r = await fetch(`${URL_}/__live/mail?to=${encodeURIComponent(email)}`);
    last = { status: r.status };
    if (r.ok) {
      const m = (await r.json()) as { url: string; n: number };
      last = { status: r.status, n: m.n, url: m.url };
      if (m.n > (seen.get(email) ?? 0)) { // the catcher's sequence, never a clock (see gateway.mjs)
        seen.set(email, m.n);
        return m.url;
      }
    }
    await sleep(100);
  }
  throw new Error(`no new email for ${email} (waiting past message ${seen.get(email)}; the newest: ${json(last)})`);
}
/**
 * Ask for a link once GoTrue's 60-second limit has passed BY GOTRUE'S CLOCK. That clock is WSL's, which
 * steps backwards at times, so a request made after a 61-second wait here can still be "too soon"
 * there. Retried a few times, and said out loud when it happens.
 */
async function askOnceAllowed(d: Device, email: string) {
  for (let tries = 0; ; tries++) {
    const r = await mayThrow(d.client.sendSignInLink(email));
    if (!(r instanceof Error)) return;
    if (!/too many sign-in emails/i.test(r.message) || tries >= 6) throw r;
    console.log(`      (GoTrue still counted ${email}'s last link as under a minute old: WSL's clock stepped back; retrying in 5 s)`);
    await sleep(5000);
  }
}
/** Open a link as a browser would, up to the first redirect: where /verify sends the browser. */
async function open(url: string): Promise<URL> {
  const r = await fetch(url, { redirect: "manual" });
  const to = r.headers.get("location");
  if (r.status !== 303 || !to) throw new Error(`/verify answered ${r.status} with ${to ? `Location ${to}` : "no redirect"}`);
  return new URL(to);
}
/**
 * The browser arrives where /verify sent it. It must be the page that asked. When the allow list refuses
 * that return address, GoTrue sends the link to the asking page's origin (the browser's Referer) if the
 * list admits it, and otherwise to the Site URL, which stack.sh sets to PRODUCTION as step 3 does. Node's
 * fetch sends no Referer, so this run can only ever see the second. A device whose link landed anywhere
 * else would, in the real app, never finish signing in.
 */
async function landOn(name: string, to: URL, which = "link") {
  check(`redirect: ${name}'s ${which} lands back on ${PAGE}`, to.origin + to.pathname === PAGE, to.origin + to.pathname);
  landed[name] = to.search;
  windows[name].location.search = to.search;
  windows[name].location.hash = to.hash;
}
async function signIn(d: Device, name: string, email: string, which = "link") {
  await d.client.sendSignInLink(email);
  await landOn(name, await open(await newMail(email)), which);
  return d.client.completeSignInFromUrl();
}
/** PostgREST as a signed-in user, the way the app reaches it. */
async function rest(path: string, token: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await r.text();
  return { status: r.status, body: body ? JSON.parse(body) : null };
}
async function refresh(token: string) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: json({ refresh_token: token }),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as { refresh_token?: string; error_code?: string } };
}
/** Postgres as the project's own SQL editor sees it (superuser), for what no API shows. */
function db(sql: string): unknown[] {
  const out = execFileSync("wsl", ["-d", process.env.LIVE_WSL_DISTRO || "Ubuntu", "--exec",
    `${process.env.LIVE_WSL_HOME}/.cache/nutriflow-live/node/bin/node`,
    `${process.env.LIVE_REPO}/scripts/account-live/db.mjs`, "query", sql], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop()!);
}
const count = (sql: string) => (db(`select count(*)::int as n from (${sql}) q`)[0] as { n: number }).n;
const uuid = (s: string) => (/^[0-9a-f-]{36}$/.test(s) ? s : (() => { throw new Error(`not a uuid: ${s}`); })());
const tokenSql = (s: string) => (/^[A-Za-z0-9_-]+$/.test(s) ? s : (() => { throw new Error("unexpected refresh-token shape"); })());
/** The refresh token GoTrue rotated into this one: exactly one rotation means its parent is the old one. */
const parentOf = (t: string) => (db(`select parent from auth.refresh_tokens where token = '${tokenSql(t)}'`)[0] as { parent?: string } | undefined)?.parent;
/** The gateway's numbered request log: which requests the app made, and with which token. */
async function logMark(): Promise<number> {
  return ((await (await fetch(`${URL_}/__live/log?after=${Number.MAX_SAFE_INTEGER}`)).json()) as { last: number }).last;
}
async function logAfter(mark: number): Promise<Logged[]> {
  return ((await (await fetch(`${URL_}/__live/log?after=${mark}`)).json()) as { requests: Logged[] }).requests;
}
const tag = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 12);
const renewals = (reqs: Logged[]) => reqs.filter((r) => r.path.startsWith("/auth/v1/token?grant_type=refresh_token"));
/** This session's access token with the same claims, expired ten minutes ago, signed with the stack's secret. */
function expiredCopy(token: string): string {
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ ...claims, iat: nowSec() - 4200, exp: nowSec() - 600 });
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
/**
 * Is this device's pending request the one GoTrue now treats as the person's LATEST? GoTrue decides by
 * flow_state.created_at on WSL's clock, which steps backwards at times, so a request made a moment
 * after another can still sort before it. A takeover check must not start until this holds. If a clock
 * step got in the way, the device asks again, which GoTrue refuses as too soon but still records, and
 * the run says so.
 */
async function becomeLatest(d: Device, email: string): Promise<boolean> {
  for (let tries = 0; tries < 6; tries++) {
    const pending = d.storage.loadPendingSignIn() as { verifier: string } | null;
    const latest = db(
      `select f.code_challenge from auth.flow_state f join auth.users u on u.id = f.user_id
       where u.email = '${email}' and f.authentication_method = 'magiclink' order by f.created_at desc, f.id desc limit 1`,
    )[0] as { code_challenge?: string } | undefined;
    if (pending && latest?.code_challenge === createHash("sha256").update(pending.verifier).digest("base64url")) return true;
    console.log(`      (GoTrue holds another request for ${email} as the latest: WSL's clock stepped back; asking again)`);
    await sleep(1500);
    await mayThrow(d.client.sendSignInLink(email));
  }
  return false;
}
async function hide(name: string) {
  docs[name].visibilityState = "hidden";
  docs[name].dispatch("visibilitychange");
  await sleep(800);
  docs[name].visibilityState = "visible";
}

for (const name of ["Lap", "Pho", "Rob", "Late", "Desk", "Tablet", "ConfA", "ConfB", "ConfC", "ConfD"]) makeDevice(name);
makeDevice("Prev", PREVIEW);
makeDevice("Site", SITE_URL);
const Lap = await load("Lap");
const Pho = await load("Pho");
const Rob = await load("Rob");
const Late = await load("Late");
const Desk = await load("Desk");
const Tablet = await load("Tablet");
const Prev = await load("Prev");
const Site = await load("Site");
const ConfA = await load("ConfA");
const ConfB = await load("ConfB");
const ConfC = await load("ConfC");
const ConfD = await load("ConfD");
const sam = "sam.live@example.com";
const rob = "rob.live@example.com";
const ivy = "ivy.live@example.com";
const jo = "jo.live@example.com";
const kai = "kai.live@example.com";
const lee = "lee.live@example.com";
const max = "max.live@example.com";
const nia = "nia.live@example.com";
const oli = "oli.live@example.com";
const pat = "pat.live@example.com";
const sessionOf = (d: Device) => d.storage.loadSessionRaw() as Session | null;
/**
 * Move a person's sign-in requests six minutes back, in GoTrue's own table: what waiting out its 300 s
 * flow-state expiry would do, without adding five minutes to the run.
 */
const ageRequests = (email: string, method?: string) =>
  db(
    `update auth.flow_state f set created_at = f.created_at - interval '6 minutes' from auth.users u
     where u.id = f.user_id and u.email = '${email}'${method ? ` and f.authentication_method = '${method}'` : ""}
     returning f.authentication_method`,
  ) as { authentication_method: string }[];

// =================================================================================================
// 1. Sign in on a laptop that already has a week, and the week goes up
// =================================================================================================
Lap.storage.saveProfile({ ...PROFILE, name: "Sam", allergies: "peanuts" });
Lap.storage.savePlan(week("LAPTOP"));
const lapSession = await mayThrow(signIn(Lap, "Lap", sam));
check("sign-in: the real GoTrue's PKCE link signs the laptop in",
  !(lapSession instanceof Error) && !!lapSession && /^[0-9a-f-]{36}$/.test(lapSession.userId), errText(lapSession));
check("sign-in: the code reached the address bar, and was cleared from it",
  (landed.Lap ?? "").includes("code=") && windows.Lap.location.search === "", json({ landed: landed.Lap, now: windows.Lap.location.search }));
await Lap.client.startSync();
const samToken = Lap.client.currentSession()!.accessToken;
const samId = uuid(Lap.client.currentSession()!.userId);
const rows = await rest("user_state?select=key,value", samToken);
check("first sync: the laptop's week and profile are in Sam's account, through the real PostgREST",
  rows.status === 200 && rows.body.some((r: { key: string; value: unknown }) => r.key === "plan" && summary(r.value) === "week LAPTOP") &&
    rows.body.some((r: { key: string }) => r.key === "profile"), json(rows));

// =================================================================================================
// 2. The phone: GoTrue's per-person email limit is real, and a refused request keeps the link already sent
// =================================================================================================
const tooSoon = await mayThrow(Pho.client.sendSignInLink(sam));
check("rate limit: a second link for the same person within a minute is refused (429), and says so",
  tooSoon instanceof Error && /too many sign-in emails/i.test(tooSoon.message), errText(tooSoon));
// Rob asks for a link now, and again after the wait: GoTrue retires this first one then (section 6).
await Rob.client.sendSignInLink(rob);
const robFirst = await newMail(rob);

// Two browsers, one person: GoTrue issues the code a link yields for the person's LATEST request, from
// whichever browser, and records a request even when it refuses to email it as too soon (magic_link.go
// writes the flow state before the limit). Ivy asks on the desk, then on the tablet (refused): her link,
// opened on the desk that asked for it, cannot finish there, and the app must say why.
await Desk.client.sendSignInLink(ivy);
const ivyLink = await newMail(ivy);
const ivyFromTablet = await mayThrow(Tablet.client.sendSignInLink(ivy));
const ivyTabletLatest = await becomeLatest(Tablet, ivy);
await landOn("Desk", await open(ivyLink), "link (asked for here, then from the tablet)");
const ivyOnDesk = await mayThrow(Desk.client.completeSignInFromUrl());
check("takeover: once another browser asks, even refused as too soon (429), the link fails where it was asked for, and says why",
  ivyFromTablet instanceof Error && /too many sign-in emails/i.test(ivyFromTablet.message) && ivyTabletLatest && ivyOnDesk instanceof Error &&
    ivyOnDesk.message.includes("newer sign-in request took it over") && Desk.client.currentSession() === null,
  json({ tablet: errText(ivyFromTablet), tabletLatest: ivyTabletLatest, desk: errText(ivyOnDesk) }));
// The same refusal's other cause: a link asked for in ANOTHER browser, opened where this browser holds a
// request of its own. Max asks on the Late browser; the link is opened on the desk, which still holds
// Ivy's request (a failed link keeps its verifier). Nothing took Max's link over (it is his newest), so
// of the sentence's causes only "a different browser" is true, and it must be there.
await Late.client.sendSignInLink(max);
const maxTo = await open(await newMail(max));
windows.Desk.location.search = maxTo.search;
windows.Desk.location.hash = maxTo.hash;
const maxOnDesk = await mayThrow(Desk.client.completeSignInFromUrl());
check("takeover: a fresh link asked for in another browser, opened where this one holds a request of its own, is refused, and names a different browser",
  maxOnDesk instanceof Error && maxOnDesk.message.includes("asked for in a different browser") && maxOnDesk.message.includes("took it over") &&
    Desk.client.currentSession() === null && (Desk.storage.loadPendingSignIn() as { email?: string } | null)?.email === ivy &&
    (Late.storage.loadPendingSignIn() as { email?: string } | null)?.email === max,
  errText(maxOnDesk));
// …and the other side of the same rule: Jo's link, sent for the desk's request, finishes on the tablet.
await Desk.client.sendSignInLink(jo);
const joLink = await newMail(jo);
const joFromTablet = await mayThrow(Tablet.client.sendSignInLink(jo));
const joTabletLatest = await becomeLatest(Tablet, jo);
await landOn("Tablet", await open(joLink), "link (sent for the desk's request)");
const joOnTablet = await mayThrow(Tablet.client.completeSignInFromUrl());
check("takeover: …while the browser that asked last finishes with it, though the link was sent for the other's request",
  joFromTablet instanceof Error && joTabletLatest && !(joOnTablet instanceof Error) && !!joOnTablet && joOnTablet.email === jo,
  json({ tablet: errText(joFromTablet), tabletLatest: joTabletLatest, session: errText(joOnTablet) }));

// A return address the allow list refuses. Kai asks on a preview deployment nobody added to it, so
// GoTrue sends the link to the Site URL instead (with no Referer, as here, its only fallback). That is
// another origin, with storage of its own, so the request is not held there: the sign-in cannot finish,
// and the page must not say another browser was used, since none was. Asked before the wait, so that
// Kai can ask again after it without adding a minute to the run (below the phone's sign-in).
await Prev.client.sendSignInLink(kai);
const kaiTo = await open(await newMail(kai));
check("redirect: a link asked for at an address the allow list refuses lands on the Site URL, the production account page (step 3)",
  kaiTo.origin + kaiTo.pathname === SITE_URL && kaiTo.searchParams.has("code"), kaiTo.origin + kaiTo.pathname);
windows.Site.location.search = kaiTo.search;
windows.Site.location.hash = kaiTo.hash;
// The precondition, and the branch: nothing is held at the Site URL's page yet, and the sentence is the
// no-request one ("data was cleared" is in it alone). The takeover sentence names both addresses too, so
// the phrases alone could not tell the two branches apart (the re-review of the Site URL batch).
const siteHeldBefore = Site.storage.loadPendingSignIn();
const kaiOnSite = await mayThrow(Site.client.completeSignInFromUrl());
check("redirect: …where the request is not held (another origin), so it cannot finish there, and the page names a different web address",
  siteHeldBefore === null && kaiOnSite instanceof Error && kaiOnSite.message.includes("at a different web address") &&
    kaiOnSite.message.includes("in a different browser") && kaiOnSite.message.includes("data was cleared") &&
    Site.client.currentSession() === null && (Prev.storage.loadPendingSignIn() as { email?: string } | null)?.email === kai,
  json({ heldBefore: siteHeldBefore, refusal: errText(kaiOnSite) }));
// Lee asks on the Site URL's page and leaves that link unopened: this browser now holds a request of
// its own at that address (below, after the wait, Lee asks again on the preview).
await Site.client.sendSignInLink(lee);
await newMail(lee);

// "Confirm email" ON, the hosted default that step 3 turns off: a second GoTrue on the same database,
// reached through the gateway's /confirm prefix, which the four Conf browsers are pointed at (run.mjs).
// A new person's first link is then a confirmation link, and opened at once it signs them in.
await ConfA.client.sendSignInLink(nia);
const niaLink = await newMail(nia);
await landOn("ConfA", await open(niaLink), "first link (Confirm email on)");
const niaSession = await mayThrow(ConfA.client.completeSignInFromUrl());
check("confirm email on: a new person's first link is a confirmation link, and opened at once it signs them in",
  new URL(niaLink).searchParams.get("type") === "signup" && !(niaSession instanceof Error) && niaSession?.email === nia,
  json({ type: new URL(niaLink).searchParams.get("type"), session: errText(niaSession) }));
// That link's flow state expires 300 s after the REQUEST: GoTrue's FlowStateExpiryDuration, which it will
// not take lower, counted from the open only for a magic link (flow_state.go IsExpired). /verify still
// confirms the person and issues a code; the exchange is what refuses it (422 flow_state_expired).
await ConfB.client.sendSignInLink(oli);
const oliFirst = await newMail(oli);
const oliAged = ageRequests(oli);
const oliTo = await open(oliFirst);
windows.ConfB.location.search = oliTo.search;
windows.ConfB.location.hash = oliTo.hash;
const oliLate = await mayThrow(ConfB.client.completeSignInFromUrl());
check("confirm email on: a first link opened more than five minutes after it was asked for is refused, with the sentence for a slow first link",
  oliAged.length === 1 && oliAged[0].authentication_method === "email/signup" && oliLate instanceof Error &&
    oliLate.message.includes("took too long to open") && ConfB.client.currentSession() === null,
  json({ aged: oliAged, refusal: errText(oliLate) }));
// And with "Confirm email" on, a new person's request refused as too soon takes nothing over: GoTrue
// signs them up inside the request's transaction, and the refusal rolls it back, flow state and all
// (signup.go). Contrast Ivy's takeover above, where "Confirm email" is off.
await ConfC.client.sendSignInLink(pat);
const patLink = await newMail(pat);
const patFromD = await mayThrow(ConfD.client.sendSignInLink(pat));
const patRequests = count(`select 1 from auth.flow_state f join auth.users u on u.id = f.user_id where u.email = '${pat}'`);
const patTo = await open(patLink);
windows.ConfC.location.search = patTo.search;
windows.ConfC.location.hash = patTo.hash;
const patOn = await mayThrow(ConfC.client.completeSignInFromUrl());
check("confirm email on: a new person's second request, refused as too soon, is rolled back and takes nothing over: the link finishes where it was asked for",
  patFromD instanceof Error && /too many sign-in emails/i.test(patFromD.message) && patRequests === 1 &&
    !(patOn instanceof Error) && patOn?.email === pat,
  json({ second: errText(patFromD), requests: patRequests, session: errText(patOn) }));

console.log("      (waiting out GoTrue's 60-second per-person email limit)");
await sleep(61_000);
await askOnceAllowed(Pho, sam);
const phoLink = await newMail(sam);
// A second tap, refused (429): GoTrue still records it as Sam's latest request.
const phoAgain = await mayThrow(Pho.client.sendSignInLink(sam));
// A third, whose connection drops before GoTrue sees it: GoTrue's latest stays where it was, so a phone
// that had replaced its verifier for it could no longer finish with the link already sent.
await fetch(`${URL_}/__live/fail-next?path=/auth/v1/otp`);
const phoLost = await mayThrow(Pho.client.sendSignInLink(sam));
await landOn("Pho", await open(phoLink));
const phoSession = await mayThrow(Pho.client.completeSignInFromUrl());
check("sign-in: requests GoTrue refuses (429) or never receives (a dropped connection) leave the link already sent working",
  phoAgain instanceof Error && /too many sign-in emails/i.test(phoAgain.message) && phoLost instanceof Error && /offline/i.test(phoLost.message) &&
    !(phoSession instanceof Error) && phoSession?.userId === samId,
  json({ again: errText(phoAgain), lost: errText(phoLost), session: errText(phoSession) }));
await Pho.client.startSync();
check("second device: the phone pulls the laptop's week", summary(Pho.storage.loadPlan()) === "week LAPTOP", summary(Pho.storage.loadPlan()));

// Lee, more than a minute on, asks again, this time on the preview. That link also lands on the Site
// URL's page, which still holds Lee's earlier request, so the page exchanges the code with that
// request's verifier. GoTrue issued the code for Lee's newest request, the preview's, so it refuses the
// verifier (bad_code_verifier), and the page shows the takeover sentence. Its other two causes, a
// different browser and a newer request, are both false here (same browser, and this IS the newest
// link), so it must name the web address.
await askOnceAllowed(Prev, lee);
const leeLink = await newMail(lee);
const leePrevLatest = await becomeLatest(Prev, lee);
const leeTo = await open(leeLink);
windows.Site.location.search = leeTo.search;
windows.Site.location.hash = leeTo.hash;
const leeOnSite = await mayThrow(Site.client.completeSignInFromUrl());
check("redirect: …but where that page holds an earlier request of its own, the refusal is the takeover sentence, and it names a different web address too",
  leeTo.origin + leeTo.pathname === SITE_URL && leePrevLatest && leeOnSite instanceof Error &&
    leeOnSite.message.includes("newer sign-in request took it over") && leeOnSite.message.includes("at a different web address") &&
    Site.client.currentSession() === null && (Site.storage.loadPendingSignIn() as { email?: string } | null)?.email === lee,
  json({ landed: leeTo.origin + leeTo.pathname, latest: leePrevLatest, refusal: errText(leeOnSite) }));

// Kai, more than a minute on, does what that page said: asks again there, and the link comes back to
// the page that asked, and finishes. Two rules of GoTrue's would each bring it back: IsRedirectURLValid
// admits the Site URL's own origin (same scheme, host and port; any path) without the allow list, and a
// refused address falls back to the Site URL, which here is the same address. So this check cannot tell
// which; under mutate-live's bare-domain Site URL it is required to PASS, which only the first can do.
await askOnceAllowed(Site, kai);
const kaiAgain = await newMail(kai);
const kaiSiteLatest = await becomeLatest(Site, kai);
const kaiBack = await open(kaiAgain);
windows.Site.location.search = kaiBack.search;
windows.Site.location.hash = kaiBack.hash;
const kaiOnSiteAgain = await mayThrow(Site.client.completeSignInFromUrl());
check("redirect: …and asking again on that page, as it says, brings the link back to it, where it signs Kai in",
  kaiBack.origin + kaiBack.pathname === SITE_URL && kaiSiteLatest && !(kaiOnSiteAgain instanceof Error) && kaiOnSiteAgain?.email === kai,
  json({ landed: kaiBack.origin + kaiBack.pathname, latest: kaiSiteLatest, session: errText(kaiOnSiteAgain) }));

// Oli, more than a minute on, does what the slow link's sentence said and asks again. Opening that link
// had already confirmed Oli, so this one is a magic link, and a magic link's five minutes run from its
// opening, not its request (flow_state.go): moved six minutes back like the first, it still works.
await askOnceAllowed(ConfB, oli);
const oliAgain = await newMail(oli);
const oliAgedAgain = ageRequests(oli, "magiclink");
const oliBack = await open(oliAgain);
windows.ConfB.location.search = oliBack.search;
windows.ConfB.location.hash = oliBack.hash;
const oliOn = await mayThrow(ConfB.client.completeSignInFromUrl());
check("confirm email on: …asking again, as that sentence says, sends a magic link, which still works six minutes after it was asked for",
  new URL(oliAgain).searchParams.get("type") === "magiclink" && oliAgedAgain.length === 1 && !(oliOn instanceof Error) && oliOn?.email === oli,
  json({ type: new URL(oliAgain).searchParams.get("type"), aged: oliAgedAgain.length, session: errText(oliOn) }));

// =================================================================================================
// 3. An edit on the phone reaches the laptop
// =================================================================================================
Pho.storage.savePlan(week("PHONE"));
await hide("Pho"); // leaving the tab sends what is waiting
windows.Lap.dispatch("online"); // the laptop comes back: it pulls
await waitFor(() => summary(Lap.storage.loadPlan()) === "week PHONE");
check("mirror: the phone's edit reaches the account and comes down on the laptop",
  summary(Lap.storage.loadPlan()) === "week PHONE", summary(Lap.storage.loadPlan()));

// =================================================================================================
// 4. upsert_state on the real server: a write older than the account's copy is skipped
// =================================================================================================
const stale = await rest("rpc/upsert_state", samToken, {
  method: "POST", body: json({ rows: [{ key: "plan", value: week("OLD"), updated_at: "2001-01-01T00:00:00Z" }] }),
});
check("upsert_state: an older write is skipped, and named as skipped", stale.status === 200 && json(stale.body) === json(["plan"]), json(stale));
check("upsert_state: …and the account still holds the newer week",
  summary((await rest("user_state?key=eq.plan&select=value", samToken)).body?.[0]?.value) === "week PHONE");

// =================================================================================================
// 5. Renewal, against tokens that have REALLY expired (minted with the stack's own secret)
// =================================================================================================
// (a) The device knows its token has expired: it renews BEFORE pushing, and the expired token never leaves.
const before = Pho.storage.loadSessionRaw() as Session;
const expiredA = expiredCopy(before.accessToken);
const refusedA = await rest("user_state?select=key", expiredA);
let mark = await logMark();
Pho.storage.saveSessionRaw({ ...before, accessToken: expiredA, expiresAt: nowSec() - 5 });
Pho.storage.toggleSaved("Lentil soup");
await hide("Pho");
// A broken renewal can sign the phone out, so the stored session may be gone: the checks then fail,
// rather than the run dying before it can say which one.
await waitFor(() => sessionOf(Pho)?.accessToken !== expiredA);
const afterA = sessionOf(Pho) ?? before;
await waitFor(async () => (await logAfter(mark)).some((r) => r.token === tag(afterA.accessToken) && r.status === 200));
const reqA = await logAfter(mark);
check("renewal: a token that has really expired is renewed by the real GoTrue before the push, which it never carries",
  refusedA.status === 401 && renewals(reqA).length === 1 && renewals(reqA)[0].status === 200 &&
    !reqA.some((r) => r.token === tag(expiredA)) && reqA.some((r) => r.token === tag(afterA.accessToken) && r.status === 200) &&
    parentOf(afterA.refreshToken) === before.refreshToken,
  json({ expiredRefused: refusedA.status, signedIn: !!sessionOf(Pho), requests: reqA }));
const savedA = await rest("user_state?key=eq.saved&select=value", afterA.accessToken);
check("renewal: …and the edit reached the account", json(savedA.body?.[0]?.value ?? null).includes("Lentil soup"), json(savedA));
// GoTrue's rule for the refresh token a renewal just replaced: accepted, answered with the CURRENT token.
const reuse = await refresh(before.refreshToken);
check("renewal: the refresh token a renewal just replaced is answered with the session's current one (GoTrue's parent rule)",
  reuse.status === 200 && reuse.body.refresh_token === afterA.refreshToken,
  json({ status: reuse.status, current: reuse.body.refresh_token === afterA.refreshToken }));

// (b) The device thinks its token is fresh, but it has expired: PostgREST answers 401, the app renews
// once and retries (the path a device with a slow clock takes, batch 3).
const expiredB = expiredCopy(afterA.accessToken);
mark = await logMark();
Pho.storage.saveSessionRaw({ ...afterA, accessToken: expiredB, expiresAt: nowSec() + 3000 });
Pho.storage.toggleSaved("Dal");
await hide("Pho");
await waitFor(() => sessionOf(Pho)?.accessToken !== expiredB);
const afterB = sessionOf(Pho);
if (afterB) await waitFor(async () => (await logAfter(mark)).some((r) => r.token === tag(afterB.accessToken) && r.status === 200));
const reqB = await logAfter(mark);
const withExpired = reqB.filter((r) => r.token === tag(expiredB));
check("renewal: a token PostgREST refuses (401) though the device judged it fresh is renewed once, and the push retried with the new one",
  !!afterB && withExpired.length === 1 && withExpired[0].status === 401 && renewals(reqB).length === 1 && renewals(reqB)[0].status === 200 &&
    reqB.some((r) => r.token === tag(afterB.accessToken) && r.n > withExpired[0].n && r.status === 200) &&
    parentOf(afterB.refreshToken) === afterA.refreshToken,
  json({ signedIn: !!afterB, status: Pho.client.accountStatus(), requests: reqB }));
const savedB = afterB ? await rest("user_state?key=eq.saved&select=value", afterB.accessToken) : { status: 0, body: null };
check("renewal: …and that edit reached the account too", json(savedB.body?.[0]?.value ?? null).includes("Dal"), json(savedB));

// =================================================================================================
// 6. Another person: only the newest link works, RLS keeps the accounts apart, sign-out ends the session
//    (and, for Jo, signed in on two browsers, only the one it was pressed in)
// =================================================================================================
Rob.storage.savePlan(week("ROB"));
await askOnceAllowed(Rob, rob); // more than a minute after the first: accepted, and the first is retired
const robNewest = await newMail(rob);
await landOn("Rob", await open(robFirst), "replaced link");
const viaReplaced = await mayThrow(Rob.client.completeSignInFromUrl());
check("newest link: an unused link that a newer one replaced is refused, with the sentence that says only the newest works",
  robNewest !== robFirst && viaReplaced instanceof Error && viaReplaced.message.includes("only the newest link"), errText(viaReplaced));
await landOn("Rob", await open(robNewest), "newest link");
const robSession = await mayThrow(Rob.client.completeSignInFromUrl());
check("newest link: …and the newest one signs Rob in, on the same browser",
  !(robSession instanceof Error) && !!robSession && robSession.userId !== samId, errText(robSession));
await Rob.client.startSync();
const robToken = Rob.client.currentSession()!.accessToken;
const robId = uuid(Rob.client.currentSession()!.userId);

const peek = await rest(`user_state?user_id=eq.${samId}&select=key`, robToken);
check("RLS: Rob asking for Sam's rows by her id gets none", peek.status === 200 && Array.isArray(peek.body) && peek.body.length === 0, json(peek));

// INSERT: a key Sam has NO row for, so only the policy can refuse it (a collision would refuse it anyway).
const samImports = `select 1 from public.user_state where user_id = '${samId}' and key = 'imports'`;
const importsBefore = count(samImports);
const forge = await rest("user_state", robToken, { method: "POST", body: json({ user_id: samId, key: "imports", value: [] }) });
check("RLS: Rob cannot write a row carrying Sam's id: the insert policy itself refuses it (403, 42501)",
  importsBefore === 0 && forge.status === 403 && forge.body?.code === "42501" && count(samImports) === 0, json(forge));

// UPDATE and DELETE with NO filter: a filter would bring the select policy in, which alone hides Sam's
// rows (supabase/README.md, rows 5 and 5b). Without one, only the update/delete policy stands between.
const samRows = () => db(`select key, updated_at from public.user_state where user_id = '${samId}' order by key`);
const robRows = `select 1 from public.user_state where user_id = '${robId}'`;
const samBefore = json(samRows());
const robHad = count(robRows);
const upd = await rest("user_state", robToken, { method: "PATCH", body: json({ updated_at: "2000-01-01T00:00:00Z" }) });
check("RLS: Rob's update with no filter changes his own rows and none of Sam's",
  upd.status < 300 && robHad > 0 && count(`${robRows} and updated_at = '2000-01-01T00:00:00Z'`) === robHad && json(samRows()) === samBefore,
  json({ status: upd.status, body: upd.body, robHad }));
const del = await rest("user_state", robToken, { method: "DELETE" });
check("RLS: Rob's delete with no filter removes his own rows and none of Sam's",
  del.status < 300 && count(robRows) === 0 && json(samRows()) === samBefore, json({ status: del.status, body: del.body }));

const robRefresh = Rob.client.currentSession()!.refreshToken;
await Rob.client.signOut();
const afterOut = await refresh(robRefresh);
check("sign-out: the real GoTrue refuses the signed-out session's refresh token (400, refresh_token_not_found)",
  afterOut.status === 400 && afterOut.body.error_code === "refresh_token_not_found", json(afterOut));
check("sign-out: …and the page reports a plain sign-out, with nothing to add",
  Rob.client.accountStatus().state === "signed-out" && Rob.client.accountStatus().message === undefined, json(Rob.client.accountStatus()));

// Several sessions, one sign-out. Jo has been signed in on the tablet since section 2, signs in on the
// desk as well (more than a minute after Jo's last email), and signs out there. scope=local ends that
// browser's session only. GoTrue's default, global, would end the tablet's too: the tablet would keep
// syncing until its access token ran out (up to an hour), then stop, told only that its sign-in had
// expired (signOutRemote in supabase.ts). Rob above is signed in on one browser only, so his sign-out
// cannot tell. (GoTrue also keeps an unused session from each autoconfirmed sign-up, which nothing here
// holds a token for.)
const tabletRefresh = sessionOf(Tablet)?.refreshToken;
await askOnceAllowed(Desk, jo);
const joDeskLink = await newMail(jo);
const joDeskLatest = await becomeLatest(Desk, jo);
await landOn("Desk", await open(joDeskLink), "link (Jo's second device)");
const joOnDesk = await mayThrow(Desk.client.completeSignInFromUrl());
const deskRefresh = Desk.client.currentSession()?.refreshToken;
const deskOut = await mayThrow(Desk.client.signOut());
const deskAfter = deskRefresh ? await refresh(deskRefresh) : null;
const tabletAfter = tabletRefresh ? await refresh(tabletRefresh) : null;
check("sign-out: ends only the browser it was pressed in (scope=local): Jo's desk session is refused, and the tablet's still renews",
  joDeskLatest && !(joOnDesk instanceof Error) && joOnDesk?.email === jo && !(deskOut instanceof Error) &&
    deskAfter?.status === 400 && tabletAfter?.status === 200,
  json({ deskLatest: joDeskLatest, desk: errText(joOnDesk), signOut: errText(deskOut),
    deskAfter: deskAfter && [deskAfter.status, deskAfter.body.error_code], tabletAfter: tabletAfter && [tabletAfter.status, tabletAfter.body.error_code] }));

// The link Rob signed in with, opened again in another browser
await landOn("Late", await open(robNewest), "reopened link");
const reopened = await mayThrow(Late.client.completeSignInFromUrl());
check("used link: opening it again is refused, with the sentence that says only the newest link works",
  reopened instanceof Error && reopened.message.includes("only the newest link"), errText(reopened));

// =================================================================================================
// 7. Sam deletes her account on the phone; the laptop, still holding a valid token, finds out
// =================================================================================================
const lapToken = Lap.client.currentSession()!.accessToken;
const deleted = await mayThrow(Pho.client.deleteAccount());
check("delete: the account and every row of it are gone from the real database",
  !(deleted instanceof Error) && count(`select 1 from auth.users where id = '${samId}'`) === 0 &&
    count(`select 1 from public.user_state where user_id = '${samId}'`) === 0, errText(deleted));
Lap.storage.savePlan(week("LAPTOP-AFTER"));
await hide("Lap"); // the laptop's push meets the deleted account: 23503, a 409 from the real PostgREST
check("deleted elsewhere: the laptop says the account was deleted, stops, and keeps its week",
  Lap.client.accountStatus().state === "signed-out" && (Lap.client.accountStatus().message ?? "").includes("was deleted") &&
    summary(Lap.storage.loadPlan()) === "week LAPTOP-AFTER",
  json({ status: Lap.client.accountStatus(), plan: summary(Lap.storage.loadPlan()) }));
const logout = await fetch(`${URL_}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey: KEY, Authorization: `Bearer ${lapToken}` } });
const logoutBody = (await logout.json().catch(() => ({}))) as { error_code?: string; code?: string };
check("platform: /logout with a deleted account's token answers 403 user_not_found (what signOutRemote treats as ended)",
  logout.status === 403 && (logoutBody.error_code ?? logoutBody.code) === "user_not_found", json({ status: logout.status, logoutBody }));
const again = await mayThrow(signIn(Pho, "Pho", sam, "re-signup link"));
check("re-signup: the same address, signing up again after the delete, is a NEW account with a new id",
  !(again instanceof Error) && !!again && again.userId !== samId, errText(again));

// =================================================================================================
// 8. Step 3's privacy setting holds: no sign-in, renewal or sign-out above left a row in the database
// =================================================================================================
const audit = count("select 1 from auth.audit_log_entries");
check("step 3: \"Write audit logs to the database\" off, so auth.audit_log_entries is empty after all of the above",
  audit === 0, `${audit} rows`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail ? 1 : 0);
