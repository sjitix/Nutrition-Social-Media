// The local stack's front door, standing in for the gateway (Kong) a Supabase project puts in front of
// GoTrue and PostgREST, plus a mail catcher for the sign-in emails. Runs INSIDE WSL with the cache's Node;
// stack.sh starts it. No dependencies.
//
//   :54321  /auth/v1/*  -> GoTrue     (prefix stripped)          the URL the app is given
//           /rest/v1/*  -> PostgREST  (prefix stripped)
//           /__live/anon-key          the key the app sends as `apikey` (signed here, from the stack's secret)
//           /__live/mail?to=…         the newest email sent to that address, with its sign-in link
//   :54325  SMTP, for GoTrue's mailer: every message kept in memory
//
// Kong's behaviour that matters to the app, and only that: a request without the project's key is refused
// with 401, except the routes a browser opens straight from an email (/verify and friends), and a REST call
// with no Authorization header goes on as the anon role.
import http from "node:http";
import net from "node:net";
import { createHmac } from "node:crypto";

const SECRET = process.env.LIVE_JWT_SECRET;
if (!SECRET) throw new Error("LIVE_JWT_SECRET is not set");
const PORT = 54321;
const AUTH = 54329;
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

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/__live/anon-key") return send(res, 200, { anonKey: ANON });
    if (u.pathname === "/__live/mail") {
      const to = (u.searchParams.get("to") ?? "").toLowerCase();
      const m = mail.filter((x) => x.to.some((t) => t.toLowerCase() === to)).at(-1);
      return send(res, m ? 200 : 404, m ?? { message: `no mail for ${to}` });
    }
    let upstream;
    let path;
    if (u.pathname.startsWith("/auth/v1/")) [upstream, path] = [AUTH, u.pathname.slice("/auth/v1".length)];
    else if (u.pathname.startsWith("/rest/v1/")) [upstream, path] = [REST, u.pathname.slice("/rest/v1".length)];
    else return send(res, 404, { message: `no route ${u.pathname}` });
    if (!OPEN.has(u.pathname) && req.headers.apikey !== ANON) return send(res, 401, { message: "Invalid API key" });
    const headers = { ...req.headers, host: `127.0.0.1:${upstream}` };
    if (upstream === REST && !headers.authorization) headers.authorization = `Bearer ${ANON}`;
    const out = http.request({ host: "127.0.0.1", port: upstream, method: req.method, path: path + u.search, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    out.on("error", (e) => send(res, 502, { message: String(e) }));
    req.pipe(out);
  })
  .listen(PORT, "0.0.0.0", () => console.log(`gateway on :${PORT}`));

// ---- the mail catcher: just enough SMTP for GoTrue's mailer (no TLS or AUTH offered, so none is used) ----
function keep(to, raw) {
  let text = raw.replace(/\r\n\.\./g, "\r\n."); // undo dot-stuffing
  if (/content-transfer-encoding:\s*quoted-printable/i.test(text)) {
    text = text.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  const link = text.match(/https?:\/\/[^\s"'<>]*\/verify\?[^\s"'<>]*/);
  const url = link ? link[0].replace(/&amp;/g, "&") : null;
  mail.push({ to, url, at: Date.now(), raw: text });
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
