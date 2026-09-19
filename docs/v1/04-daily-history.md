# The daily history — what exists, and what we should use

*Deliverable 4 of the planning conversation briefed in `docs/v1-modularization-kickoff.md`.
Written 2026-09-19. The brief said to **search for existing software first** rather than build
something bespoke. That was done; this is the survey, the recommendation, and the reason.*

**What was asked for:** a page/log recording, per work-day — which milestone was tackled, what was
accomplished, **how much of it was solved**, what other issues came up, and **whether those go on
tomorrow's todo or a later day's**.

---

## 1. The finding that decides it

**The four things the owner asked to record are not in git, and cannot be derived from it.**

Git knows what changed. It does not know what was *attempted*, how much of the milestone the change
actually covers, what broke along the way, or what we decided to defer. Those are **judgements made
at the end of a day**, and no commit parser can recover them — which rules out the whole category of
"generate a devlog from your git history" tools as the *primary* store. They would reproduce
`git log`, which we already have, and miss all four of the things that were asked for.

That inverts the usual build-vs-buy question. The storage is trivial; the **content** is the whole
value, and it has to be written by whoever (or whatever) did the day's work, at the end of it.

---

## 2. What is out there

| Tool / approach | What it does | Fit here |
|---|---|---|
| **Plain markdown in the repo** | a file per day, versioned with the code | **Best fit.** Travels between the laptop and the desktop by the mechanism this project already uses; readable by the next session; writable by an agent with no auth at all |
| **[Obsidian](https://obsidian.md) / [Logseq](https://logseq.com) daily notes** | local-first markdown journals; Logseq opens on today's journal by default, Obsidian has Daily Notes as a core plugin | **Not a competitor — a free upgrade.** Both read plain markdown folders, so pointing a vault at `docs/worklog/` gives a proper journal UI over the same files. Adopt only if the owner wants it; nothing depends on it |
| **GitHub Issues + Projects + Milestones** | issues on a board, grouped into milestones | **Good for the milestone board, wrong for the narrative.** Milestones hold only issues, so anything not tied to a repo item is tracked elsewhere; `gh` is not installed on this machine, and an agent would need a token to write. Worth adopting later for the V1 board, not for the daily record |
| **Notion / Linear / Jira** | full PM suites | Rejected. Not in git (so it does not travel and the next session cannot read it), and every write needs OAuth this environment does not have. The heavier the tool, the more certain it is that a solo project stops updating it |
| **[WeekBlast](https://weekblast.com/blog/daily-work-log-app), [BragBook](https://bragbook.io/best-tools-for-tracking-work)** | hosted daily-log / "brag doc" SaaS | Rejected. Framed around career accomplishments and performance reviews, not shipping a product; hosted, paid, outside the repo |
| **[DevLog](https://github.com/unseasonable-deposer640/DevLog)** | one command turns git history into daily/weekly/standup summaries with AI | Rejected on both counts: it answers a question we can already answer (§1), and it is an unvetted repo under an anonymous-looking account — not something to run over this codebase |
| **[auto-changelog](https://github.com/cookpete/auto-changelog)** and conventional-commit parsers | group commits into a release changelog | Different job (releases, not work-days). Worth revisiting at v1 tagging time |
| **[WakaTime](https://wakatime.com)** | automatic editor-time tracking per project/file | Interesting as a *supplement* — it answers "how long" mechanically — but it needs a plugin and an account, and "how long" was not one of the four questions |

**The pattern across the writing on this** (the [Pragmatic Engineer's work-log
template](https://blog.pragmaticengineer.com/work-log-template-for-software-engineers/),
[Aaron Bos](https://aaronbos.dev/posts/daily-work-log-productivity),
[Level Up Coding](https://levelup.gitconnected.com/every-software-engineer-should-start-writing-work-log-template-f91197acd630))
is consistent and worth repeating: **the tool does not matter, the consistency does**, and entries
should record outcomes rather than activity — "resolved X by doing Y, which improved Z", not "fixed
bugs".

---

## 3. The recommendation

**One markdown file per work-day at `docs/worklog/YYYY-MM-DD.md`, in this repo, with a fixed
template. Optionally read through Obsidian or Logseq. No new dependency, no account, no cost.**

Five reasons, in order of how much they decide it:

1. **The writer is usually an agent in a terminal, not a person in an app.** A file it can write with
   no OAuth is the only option that gets written every day.
2. **The repo is how this project moves between the laptop and the desktop.** A log outside git does
   not travel, and a log that does not travel is invisible to the machine that needs it.
3. **The docs already are the cross-session memory.** `CONTEXT.md` exists precisely because separate
   conversations cannot see each other. The daily history is the same mechanism at a finer grain —
   and it should relieve `CONTEXT.md` of the narrative it keeps accumulating.
4. **One file per day avoids the merge conflicts a single growing file guarantees.** Two machines
   writing two different days never touch the same file. A single `WORKLOG.md` appended from both
   would conflict constantly — and this repo has already had a doc silently duplicate and diverge
   (WORKPLAN lesson 40).
5. **It is already a page.** GitHub renders `docs/worklog/` as browsable markdown with no build step.
   If it should live on `ntrux.vercel.app` too, generate `public/worklog.html` the way
   `public/status.html` is already served — but that is an upgrade, not a prerequisite.

### The one piece of automation worth building

Not a generator — a **scaffolder**. `npm run log:day` creates today's file pre-filled with the parts
a machine genuinely knows:

- the day's commits (`git log --since=midnight --oneline`),
- the gate results if they were run (`test:engine` count, `tsc`, `build`),
- the files and modules touched,

…leaving the four judgement fields blank for the person or agent who did the work. **That split is
the whole design:** machines fill in what happened, humans fill in what it meant. It is also the
honest version of the git-to-devlog tools — use git for the part git actually knows.

### The template

Deliberately short. A template long enough to feel like paperwork is one that stops being filled in.

```markdown
# 2026-09-19 — <the day's milestone>

**Milestone:** <which one, from docs/v1/01-dimensions-and-milestones.md>
**Solved:** <none | partial — what's left | done>

## What moved
- <outcome, not activity: what it does now that it didn't before>

## What got in the way
- <the problem, and what it cost>

## Deferred
- <thing> → <tomorrow | day N | backlog>, because <reason>

## Gate
`test:engine` <n/0> · `tsc` <ok> · `build` <ok> · pushed: <sha>
```

---

## 4. What was set up today

- **`docs/worklog/`** exists, with a `README.md` explaining the format and the rules.
- **`docs/worklog/2026-09-19.md`** — this planning day's entry, written as the first real example
  rather than a placeholder.
- The schedule in `01-dimensions-and-milestones.md` makes the entry **part of a day's definition of
  done** (§7, point 4), which is the only thing that makes a log like this survive past week one.

**Not built, deliberately:** the `log:day` scaffolder and the rendered HTML page. Both are small,
and both should wait until the format has survived a week of real use — a scaffolder that
pre-fills the wrong fields is worse than no scaffolder.
