# The visual boards — live, commentable, and kept in sync

Three published pages the owner reads and **comments on directly**, the way you comment on a Google
Doc. They are the visual face of the planning documents; the documents remain the source of truth.

## The three boards, and their permanent URLs

**These URLs are the important part of this file.** To update a board, republish **to its URL** —
publishing without it creates a *second, duplicate* artifact and the owner's comments stay stranded
on the old one.

| Board | Source of truth | URL |
|---|---|---|
| **V1 schedule** | `docs/v1/01-dimensions-and-milestones.md` | https://claude.ai/artifact/5jeC8s1S7QiHs9LLh4uGMV |
| **Module map** | `docs/v1/02-module-map.md` | https://claude.ai/artifact/BRu96iPYni7HgzHzjwFMGR |
| **Day log** | `docs/worklog/*.md` | https://claude.ai/artifact/3Qqpy8i7PKCvEfZXsgzfnh |

The HTML lives here in the repo (`milestones.html`, `module-map.html`, `worklog.html`) rather than
only in a published page, so any session can edit and republish it, and so a change is diffable like
any other change.

## The rule: a board is republished in the same commit that changes its source

A board that lags its document is worse than no board, for the same reason a stale doc is worse than
a missing one — it is believed. So:

- **Changed `01-…md`?** Update `milestones.html` and republish. Same for the other two.
- **Wrote a worklog entry?** Add it to `worklog.html` and republish, and update the counters at the
  top (days logged, open deferrals).

**The day log's timeline is history ONLY** — dated entries for days that actually happened, appended
one per work-day. The schedule ahead sits below it in a separate `<details class="upcoming">` block,
**collapsed by default**, and a day moves out of that block into the timeline only once it has been
worked. (Owner's instruction, left as a comment on `#d-next`, 2026-09-19.) Do not reintroduce
planned entries into the timeline: a record of intentions is the one thing a work log must not be.
- **Moved a module boundary?** The map doc and `module-map.html` both change, in that commit.
- Update the `SYNCED` / `COMMIT` stamp in the page header every time. It is how the owner knows
  whether what they are looking at is current.

## Commenting is built INTO the pages — don't remove it

The first version relied on the claude.ai shell's own comment mode, and the owner could not find it:
*"I cannot leave comments anywhere."* So each board now carries its own commenting affordances,
wired to the platform's real comment store through the **`comments` capability**, declared as:

```
capabilities: {"comments": {"composer_only": true}}
```

`composer_only` grants exactly one verb — `openComposer({element} | {range})` — which opens the
shell's own composer anchored wherever the page says. **It never prompts for consent and keeps the
artifact publicly shareable**, unlike the full `{comments: {}}` form, which the pages do not need
because the shell does all the posting.

Two entry points, both in the injected block at the bottom of each HTML file:

- **Select any text** → a "Comment on this" button appears by the selection → `openComposer({range})`
  so the thread quotes those exact words. This is the precise anchor, and the one to prefer.
- **"Comment on anything"** (fixed, bottom right) → the page enters comment mode, blocks get a
  crosshair and a hover outline, and a click calls `openComposer({element})` for the block it landed
  in. Escape leaves the mode.

A script marks the commentable blocks with `data-comment-target` (`.day`, `.contract`, `.mod`,
`.layer`, `.entry`, `tbody tr`, `.blk li`, headings…). That attribute does double duty: the page's
own click handler uses it, and it also tells the shell's native comment mode to anchor a click
anywhere inside a block to that whole block.

**Rules that come from the capability's contract, and are easy to break by accident:**

- The page must **never build its own list of threads**. The shell renders every thread, pin and
  card. The page's job is only to open the composer.
- `openComposer` is called **only from a deliberate click** — never on load, on a timer, or in a
  loop. Programmatic opens are rate-limited.
- `{opened: false}` is a **soft refusal**, not an error (usually a composer already holds typed
  text). Do nothing; never retry.
- `unavailable` / `not_granted` are **permanent for that view**: hide the affordance and say
  commenting is off here, rather than showing a failure.
- The capability resolves **after** load, so the button stays hidden until it does. **If a view
  cannot run capabilities at all, no button appears** — that view has to be opened on claude.ai.

## How the comment loop works

1. The owner selects anything on a board and leaves a comment — a day, a module, a rule, a single
   sentence.
2. They say **“evaluate my comments.”**
3. The agent reads every thread with the `ArtifactComments` tool (`action: "read"`, the board's
   URL), and treats the text as **instructions from the owner about that exact element** — which is
   the whole point: no long prompt describing which part they mean.
4. The agent changes **both the source document and the board**, republishes to the same URL,
   commits and pushes.
5. Where a thread was sent to Claude, reply in it saying what changed, then resolve it. Threads the
   owner did not send to Claude **cannot be replied to or resolved** — read and act on them anyway,
   and say in chat which ones are still open and why.

**Never resolve a thread that was not acted on.** Resolve is a claim that the work is done.

## Design notes, so a later edit does not drift

**The boards are white and light, and are NOT the product's sage theme.** The first version used the
`.theme-sage` tokens and was rejected — *"why is it green. make it visually appealing, a white, light
layout"*. These are internal planning instruments, not a preview of the product, and they should not
be re-skinned back into it.

- **Palette:** white page `#ffffff`, surface `#f7f8fa`, hairline `#e8eaee`, ink `#101114`, body
  `#474b54`, muted `#8a909c`. One accent — indigo `#3b3ce0` with `#eeeefc` behind it — spent on
  rails, key numbers and status. Semantic colours are amber `#b45309` (open) and rose `#be123c`
  (blocked); track colours add teal `#0e7490` and violet `#7c3aed`. **No green anywhere**, including
  in status pills, where "done" is the indigo accent rather than the usual green.
- **Type:** **Archivo** for headings (tight, confident, set at `-.03em`) and **IBM Plex Sans** for
  body, with **IBM Plex Mono** for identifiers, counts and file paths — because these are
  engineering documents and the mono carries the code. From Google Fonts, the one font host
  artifacts allow.
- **Committed to light on purpose.** The pages declare `color-scheme: light`, paint every colour
  explicitly, and carry **no dark-theme blocks** — a board stays white even for a viewer whose
  claude.ai is dark, because white is what was asked for. If that is ever revisited, the artifact
  contract requires the full three-state pattern (bare `:root`, guarded
  `@media (prefers-color-scheme: dark)`, and `[data-theme="dark"]`), not a partial one.
- **Depth comes from hairlines and a two-step shadow**, not from fills: `0 1px 2px` at rest,
  `0 10px 26px -12px` on a hovered card. Radii vary by role — 12px for cards, 10px for panels,
  6–9px for chips, 999px for nav pills — rather than one radius everywhere.
- Every commentable unit carries an `id` (`#D1` … `#D12`, `#L0` … `#L6`, `#c-execute`,
  `#d-2026-09-19`), so a comment anchors to something stable and a later edit can find it.
- No emoji, per the standing project rule.
