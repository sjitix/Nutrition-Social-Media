// The local stack's front door, standing in for the gateway (Kong) a Supabase project puts in front of
// GoTrue and PostgREST, plus a mail catcher for the sign-in emails. Runs INSIDE WSL with the cache's Node;
// stack.sh starts it. No dependencies.
//
//   :54321  /auth/v1/*  -> GoTrue     (prefix stripped)          the URL the app is given
//           /rest/v1/*  -> PostgREST  (prefix stripped)
//           /confirm/…  the same two, but /auth/v1/* goes to the second GoTrue ("Confirm email" on, :54331):
//                       the URL four of the live run's browsers are given
//           /__live/anon-key          the key the app sends as `apikey` (signed here, from the stack's secret),
//                                     and this stack's id, so run.mjs knows it reached THIS gateway
//           /__live/mail?to=…         the newest email sent to that address, with its sign-in link
//           /__live/log?after=N       every proxied request after number N: method, path, status, and the
//                                     first 12 hex of the SHA-256 of its bearer token (no headers, no bodies),
//                                     so the live run can see which requests the app made, and with which token
//           /__live/fail-next?path=P  the next request to path P has its connection dropped before anything
//                                     reaches GoTrue or PostgREST, as a lost network would
//           /__live/drop-response-next?path=P  the next request to path P is served, and then its connection
//                                     is dropped before the answer goes back: a lost response, after the
//                                     server has done (and committed) the work
//           /__live/drop-body-next?path=P  the same, but the status and headers go back first: an answer cut
//                                     off after its headers
//           /__live/arms              which of those one-shots are still armed. P matches a request whose
//                                     path AND query start with it, so "/auth/v1/token?grant_type=pkce"
//                                     never takes a token renewal (same path, another grant). P must be a
//                                     path this gateway proxies, or the arm is refused (400): an empty or
//                                     mistyped P would match every request, the run's own log reads too
//   :54325  SMTP, for GoTrue's mailer: every message kept in memory
//
// Both listen on 127.0.0.1 only. WSL forwards loopback ports to Windows' localhost, which is all the run
// needs; on all interfaces, the sign-in links in /__live/mail would be one network setting away from the LAN.
//
// Kong's behaviour that matters to the app, and only that: a request without the project's key is refused
// with 401, except the routes a browser opens straight from an email (/verify and friends), and a REST call
// with no Authorization header goes on as the anon role.
import http from "node:http";
import net from "node:net";
import { createHash, createHmac } from "node:crypto";

const SECRET = process.env.LIVE_JWT_SECRET;
if (!SECRET) throw new Error("LIVE_JWT_SECRET is not set");
const STACK = process.env.LIVE_STACK_ID ?? "";
const PORT = 54321;
const AUTH = 54329;
const AUTH_CONFIRM = 54331;
const REST = 54330;
const SMTP = 54325;

const b64u = (s) => Buffer.from(s).toString("base64url");
function jwt(payload) {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
// A legacy-style anon key: what the app sends as `apikey` (its NEXT_PUBLIC_SUPABASE_ANON_KEY here).
const ANON = jwt({ role: "anon", iss: "supabase-local", iat: 1700000000, exp: 4102444800 });

const OPEN = new Set(["/auth/v1/verify", "/auth/v1/callback", "/auth/v1/authorize", "/auth/v1/health"]);
const mail = [];
const requests = []; // { n, method, path, status, token }: numbered, so the run never compares two machines' clocks
const failNext = new Set(); // paths whose next request is dropped
const dropResponseNext = new Set(); // paths whose next request is served, and its answer then dropped
const dropBodyNext = new Set(); // paths whose next request is served, its status and headers sent, then dropped
/** Arm a one-shot for the path in `?path=`: only a path this gateway proxies (see the header). */
function armFor(armed, u, res) {
  const p = u.searchParams.get("path") ?? "";
  if (!/^\/(auth\/v1|rest\/v1|confirm)\//.test(p)) return send(res, 400, { message: `not a path this gateway proxies: "${p}"` });
  armed.add(p);
  return send(res, 200, { dropping: [...armed] });
}
/** Use up the one-shot armed for this request, if any. */
function takeArm(armed, full) {
  for (const p of armed) {
    if (full.startsWith(p)) {
      armed.delete(p);
      return true;
    }
  }
  return false;
}
const tokenTag = (authorization) => {
  const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
  return token ? createHash("sha256").update(token).digest("hex").slice(0, 12) : null;
};

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/__live/anon-key") return send(res, 200, { anonKey: ANON, stack: STACK });
    if (u.pathname === "/__live/fail-next") return armFor(failNext, u, res);
    if (u.pathname === "/__live/drop-response-next") return armFor(dropResponseNext, u, res);
    if (u.pathname === "/__live/drop-body-next") return armFor(dropBodyNext, u, res);
    if (u.pathname === "/__live/arms") {
      return send(res, 200, { failNext: [...failNext], dropResponseNext: [...dropResponseNext], dropBodyNext: [...dropBodyNext] });
    }
    const full = u.pathname + u.search;
    if (takeArm(failNext, full)) {
      return req.socket.destroy(); // nothing reaches the server: the caller sees a failed fetch
    }
    if (u.pathname === "/__live/log") {
      const after = Number(u.searchParams.get("after") ?? 0);
      return send(res, 200, { last: requests.length, requests: requests.filter((r) => r.n > after) });
    }
    if (u.pathname === "/__live/mail") {
      const to = (u.searchParams.get("to") ?? "").toLowerCase();
      const m = mail.filter((x) => x.to.some((t) => t.toLowerCase() === to)).at(-1);
      return send(res, m ? 200 : 404, m ?? { message: `no mail for ${to}` });
    }
    let upstream;
    let path;
    const confirm = u.pathname.startsWith("/confirm/");
    const route = confirm ? u.pathname.slice("/confirm".length) : u.pathname;
    if (route.startsWith("/auth/v1/")) [upstream, path] = [confirm ? AUTH_CONFIRM : AUTH, route.slice("/auth/v1".length)];
    else if (route.startsWith("/rest/v1/")) [upstream, path] = [REST, route.slice("/rest/v1".length)];
    else return send(res, 404, { message: `no route ${u.pathname}` });
    if (!OPEN.has(route) && req.headers.apikey !== ANON) return send(res, 401, { message: "Invalid API key" });
    const headers = { ...req.headers, host: `127.0.0.1:${upstream}` };
    if (upstream === REST && !headers.authorization) headers.authorization = `Bearer ${ANON}`;
    const entry = { n: requests.length + 1, method: req.method, path: u.pathname + u.search, status: 0, token: tokenTag(req.headers.authorization) };
    requests.push(entry);
    const dropAnswer = takeArm(dropResponseNext, full);
    const dropBody = takeArm(dropBodyNext, full);
    const out = http.request({ host: "127.0.0.1", port: upstream, method: req.method, path: path + u.search, headers }, (r) => {
      entry.status = r.statusCode ?? 502;
      if (dropAnswer) {
        // The server has answered, so its work is done; the caller never hears it. The log keeps the status.
        r.resume();
        r.on("end", () => req.socket.destroy());
        return;
      }
      if (dropBody) {
        // The status and headers go back, then the connection drops before the body: the caller's fetch
        // resolves, and reading the body fails.
        res.writeHead(r.statusCode ?? 502, r.headers);
        res.flushHeaders();
        r.resume();
        r.on("end", () => req.socket.destroy());
        return;
      }
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    out.on("error", (e) => {
      entry.status = 502;
      send(res, 502, { message: String(e) });
    });
    req.pipe(out);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`gateway on 127.0.0.1:${PORT}`));

// ---- the mail catcher: just enough SMTP for GoTrue's mailer (no TLS or AUTH offered, so none is used) ----
function keep(to, raw) {
  let text = raw.replace(/\r\n\.\./g, "\r\n."); // undo dot-stuffing
  if (/content-transfer-encoding:\s*quoted-printable/i.test(text)) {
    text = text.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  const link = text.match(/https?:\/\/[^\s"'<>]*\/verify\?[^\s"'<>]*/);
  const url = link ? link[0].replace(/&amp;/g, "&") : null;
  // `n` orders the messages. Never a clock: WSL's clock steps backwards at times (dmesg: "Time jumped
  // backwards"), and a newer email stamped earlier than an older one once made the run miss it.
  mail.push({ n: mail.length + 1, to, url, at: Date.now(), raw: text });
  console.log(`mail to ${to.join(",")}: ${url ?? "(no link)"}`);
}

net
  .createServer((sock) => {
    let buf = "";
    let inData = false;
    let to = [];
    const say = (line) => sock.write(`${line}\r\n`);
    say("220 localhost ESMTP live-run mail catcher");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          keep(to, buf.slice(0, end));
          buf = buf.slice(end + 5);
          inData = false;
          say("250 OK queued");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") sock.write("250-localhost\r\n250-8BITMIME\r\n250 SIZE 10485760\r\n");
        else if (verb === "HELO") say("250 localhost");
        else if (verb === "MAIL") {
          to = [];
          say("250 OK");
        } else if (verb === "RCPT") {
          to.push(line.replace(/^RCPT TO:\s*/i, "").replace(/[<>]/g, "").trim());
          say("250 OK");
        } else if (verb === "DATA") {
          inData = true;
          say("354 End data with <CR><LF>.<CR><LF>");
        } else if (verb === "QUIT") {
          say("221 Bye");
          sock.end();
          return;
        } else say("250 OK");
      }
    });
    sock.on("error", () => {});
  })
  .listen(SMTP, "127.0.0.1", () => console.log(`mail catcher on :${SMTP}`));
