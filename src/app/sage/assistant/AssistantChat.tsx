"use client";

import { useRef, useState } from "react";
import { summariseWeek } from "../weekStats";
import type { ChatMessage, PlanSnapshot, UserProfile, WeekPlan } from "@/lib/types";

/**
 * The assistant screen, live against `/api/assistant-v2` — the AGENT LOOP.
 *
 * This screen used to be a typed transcript: convincing, and completely fake. The loop has been
 * built and tested for a while (`agentLoop.ts`, `agentTools.ts`) and the route has run it since it
 * was wired, but nothing called it, so none of it was visible. This is the client.
 *
 * ── THE HONESTY RULES THIS SCREEN HAS TO KEEP ──────────────────────────────────────────────────
 * The engine is the only thing allowed to say the plan changed, so `planChanged` comes off the
 * response and is never inferred here — not from the reply text, not from whether the plan object
 * looks different. When it is false the result panel SAYS "plan unchanged" rather than showing a
 * number that implies a change happened.
 *
 * `steps` and `gaveUp` are surfaced for the same reason they are returned: hitting MAX_STEPS means
 * the agent stopped without finishing, and a half-finished change handed back silently is the
 * failure mode this project keeps writing rules against.
 *
 * ── WHY IT RECOMPUTES FIGURES INSTEAD OF ASKING FOR THEM ───────────────────────────────────────
 * `summariseWeek` is a pure function over the returned plan, imported from a module that touches
 * no engine code. Importing `demo.ts` here to reuse its arithmetic would have pulled all 501
 * recipes into the browser bundle. This is display of the engine's own output, not a second
 * opinion about it: no macro is computed here that the engine did not already put in the plan.
 *
 * ── THE THREE WAYS IT CAN FAIL, ALL OF WHICH ARE REAL ──────────────────────────────────────────
 * 1. No server at all — the GitHub Pages preview is a static export, so `/api/*` is a 404 page and
 *    parsing it as JSON throws. Say that plainly instead of spinning.
 * 2. Demo mode — the Vercel deployment sets no key on purpose, so the route answers `demo: true`.
 * 3. Provider offline — a 503 while LM Studio is not running, which is this laptop's normal state.
 * Each gets its own message, because "something went wrong" for three different causes is what
 * makes a bug take an afternoon to find.
 */
interface Turn {
  me: string;
  reply: string;
  /** Straight off the response. Never inferred. */
  planChanged: boolean;
  steps?: number;
  maxSteps?: number;
  gaveUp?: boolean;
  avgProtein?: number;
  /** Set when the turn did not reach the agent at all. */
  problem?: "no-server" | "offline" | "demo" | "error";
}

/**
 * Why a turn produced nothing, in the reader's terms. Four causes that all look identical from the
 * outside get four different sentences on purpose: "something went wrong" for a static export, a
 * missing key and a stopped model server is what turns a one-minute diagnosis into an afternoon.
 */
const WHY_NOTHING: Record<NonNullable<Turn["problem"]>, string> = {
  "no-server": "there is no server in this preview",
  offline: "the assistant could not be reached",
  demo: "no assistant is configured here",
  error: "the request failed",
};

const EXAMPLES = [
  "make thursday vegetarian but keep my protein up",
  "what is my weakest day this week?",
  "I am out of chicken — work around it",
];

export default function AssistantChat({
  initialPlan,
  profile,
}: {
  initialPlan: WeekPlan;
  profile: UserProfile;
}) {
  const [plan, setPlan] = useState<WeekPlan>(initialPlan);
  const [prof, setProf] = useState<UserProfile>(profile);
  const [previous, setPrevious] = useState<PlanSnapshot | undefined>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setInput("");

    // The route takes the whole conversation and acts on the LAST user message, so the new one
    // goes on the end. Prior turns are what give the agent its memory — the server keeps none.
    // A failed turn contributes only the question: pairing it with an error string would teach the
    // model that "the assistant is offline" was something it once said.
    const history: ChatMessage[] = [
      ...turns.flatMap((t): ChatMessage[] =>
        t.problem
          ? [{ role: "user", text: t.me }]
          : [
              { role: "user", text: t.me },
              { role: "assistant", text: t.reply },
            ],
      ),
      { role: "user", text: message },
    ];

    const push = (t: Turn) => setTurns((prev) => [...prev, t]);

    try {
      const res = await fetch("/api/assistant-v2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: prof, plan, history, previous }),
      });

      // A static export answers with an HTML 404, which is not JSON. That is a missing SERVER, not
      // a broken assistant, and saying so saves the next person a debugging session.
      let data: Record<string, unknown> | null = null;
      try {
        data = (await res.json()) as Record<string, unknown>;
      } catch {
        push({
          me: message,
          reply:
            "This preview is a static export, so there is no server here to run the assistant. It works on the deployed app and with the dev server running.",
          planChanged: false,
          problem: "no-server",
        });
        return;
      }

      if (res.status === 503 || data?.offline) {
        push({
          me: message,
          reply: String(data?.error ?? "The assistant is offline right now."),
          planChanged: false,
          problem: "offline",
        });
        return;
      }

      if (!res.ok) {
        push({
          me: message,
          reply: String(data?.error ?? "The assistant hit a snag. Please try that again."),
          planChanged: false,
          problem: "error",
        });
        return;
      }

      const nextPlan = (data?.plan as WeekPlan | undefined) ?? plan;
      const nextProf = (data?.profile as UserProfile | undefined) ?? prof;
      setPlan(nextPlan);
      setProf(nextProf);
      // Undo is one level deep by design, and the snapshot rides the conversation because the
      // server keeps no state. Threading it back is what makes "undo that" work on the next turn.
      setPrevious(data?.previous as PlanSnapshot | undefined);

      push({
        me: message,
        reply: String(data?.reply ?? ""),
        planChanged: data?.planChanged === true,
        steps: typeof data?.steps === "number" ? data.steps : undefined,
        maxSteps: typeof data?.maxSteps === "number" ? data.maxSteps : undefined,
        gaveUp: data?.gaveUp === true,
        avgProtein: summariseWeek(nextPlan).avgProtein,
        problem: data?.demo ? "demo" : undefined,
      });
    } catch {
      push({
        me: message,
        reply: "Could not reach the assistant. Check that the app is running and try again.",
        planChanged: false,
        problem: "no-server",
      });
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="mt-8 max-w-[880px]">
      {turns.length === 0 && (
        <div className="rounded-[12px] border border-line bg-cream p-6">
          <p className="font-serif-display text-[20px] font-semibold leading-[1.15] tracking-[-0.02em]">
            Ask it to change the week.
          </p>
          <p className="mt-3 max-w-[62ch] text-[12.5px] leading-relaxed text-plum-mid">
            It can look things up before it decides — your plan, your profile, the recipe library,
            what a change would do — then make the edit and tell you what moved. The engine makes
            every change and reports it; the assistant does no arithmetic of its own.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {EXAMPLES.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => send(e)}
                disabled={busy}
                className="rounded-full bg-tint px-4 py-2 text-[12px] text-plum-mid transition hover:opacity-80 disabled:opacity-50"
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      )}

      <div aria-live="polite">
        {turns.map((t, i) => (
          <section key={i} className="mb-10">
            <p className="inline-block rounded-[10px] bg-tint px-4 py-3 text-[14.5px] leading-relaxed">
              {t.me}
            </p>

            <div className="mt-3 grid gap-3 lg:grid-cols-[1.35fr_0.65fr]">
              <div className="rounded-[12px] bg-cream p-6">
                <p className="font-serif-display text-[20px] font-semibold leading-[1.15] tracking-[-0.02em]">
                  {t.reply}
                </p>
                {t.problem === "demo" && (
                  <p className="mt-4 border-t border-line pt-3 text-[11.5px] leading-relaxed text-mut">
                    Demo mode — no AI key is set on this deployment, deliberately. Your plan is
                    untouched.
                  </p>
                )}
                {t.gaveUp && (
                  <p className="mt-4 border-t border-line pt-3 text-[11.5px] leading-relaxed text-mut">
                    It stopped at the step limit rather than finishing. Whatever it had already
                    changed is kept — ask it to carry on.
                  </p>
                )}
              </div>

              <div className="flex flex-col justify-between rounded-[12px] bg-panel p-6 text-white">
                <span className="text-[9.5px] font-bold uppercase tracking-[0.2em] text-white/60">
                  Result
                </span>
                {t.problem ? (
                  <p className="mt-6 text-[15px] font-semibold leading-tight">
                    No change
                    <span className="mt-2 block text-[11.5px] font-medium text-white/60">
                      {WHY_NOTHING[t.problem]}
                    </span>
                  </p>
                ) : (
                  <p className="mt-6 text-[34px] font-bold leading-[0.9] tracking-[-0.045em] tabular-nums">
                    {t.avgProtein}
                    <span className="ml-1.5 block pt-2 text-[12px] font-medium tracking-normal text-white/60">
                      g protein · week average
                    </span>
                  </p>
                )}
                <p className="mt-5 border-t border-white/15 pt-3.5 text-[11.5px] leading-relaxed text-white/65">
                  {t.planChanged ? "Plan updated." : "Plan unchanged."}
                  {typeof t.steps === "number" ? ` ${t.steps} of ${t.maxSteps} steps.` : ""}
                </p>
              </div>
            </div>
          </section>
        ))}
      </div>

      {busy && (
        <p className="mb-6 text-[12.5px] text-mut" role="status">
          Working — it may look things up before it answers.
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex max-w-[880px] items-center gap-2.5 border-t border-plum/25 pt-5"
      >
        <label htmlFor="assistant-input" className="sr-only">
          Tell the assistant what to change
        </label>
        <input
          id="assistant-input"
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          placeholder="Tell it what to change…"
          className="flex-1 rounded-full bg-tint px-5 py-3.5 text-[13.5px] text-plum placeholder:text-mut focus:outline-none focus:ring-2 focus:ring-vio disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-full bg-vio px-6 py-3.5 text-[12.5px] font-semibold text-white transition hover:bg-vio-deep disabled:opacity-50"
        >
          {busy ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}
