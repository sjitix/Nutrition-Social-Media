# Worklog — one file per work-day

What was tackled, how much of it was solved, what got in the way, and what moved to another day.
One file per day, named `YYYY-MM-DD.md`.

**Why this exists:** the owner works across many separate conversations and none of them can see the
others. `CONTEXT.md` carries the *state*; this carries the *history* — what was actually attempted
on a given day and what it cost. Neither is recoverable from git, because git records what changed,
not what was tried, how far it got, or what we decided to leave.

The survey of existing tools that led here, and why a hosted one was not chosen, is in
[`../v1/04-daily-history.md`](../v1/04-daily-history.md).

## Rules

1. **One file per day.** Never append to a shared file — two machines writing the same day's file is
   a merge conflict, and this repo has already had a doc silently duplicate and diverge
   (WORKPLAN lesson 40).
2. **Write it the same day**, as part of the day's definition of done
   ([`../v1/01-dimensions-and-milestones.md`](../v1/01-dimensions-and-milestones.md) §7). A log
   written from memory a week later is fiction.
3. **Outcomes, not activity.** "Explore's first-load JS fell 185 kB → N kB" beats "worked on
   bundling".
4. **Record what did NOT work, and why.** It is the part that cannot be recovered from the code, and
   it is the highest-value thing in these files — a rejected approach leaves no trace in the repo.
5. **Every deferral names a destination and a reason.** "Later" is not a destination.
6. **Numbers get their source.** A test count, a bundle size or a latency belongs with how it was
   measured, so the next session can re-measure the same way.

## Template

```markdown
# YYYY-MM-DD — <the day's milestone>

**Milestone:** <which one, from docs/v1/01-dimensions-and-milestones.md>
**Solved:** <none | partial — what's left | done>

## What moved
- <what it does now that it didn't before>

## What got in the way
- <the problem, and what it cost>

## Deferred
- <thing> → <tomorrow | day N | backlog>, because <reason>

## Gate
`test:engine` <n/0> · `tsc` <ok> · `build` <ok> · pushed: <sha>
```

## Index

| Day | Milestone | Solved |
|---|---|---|
| [2026-09-19](2026-09-19.md) | V1 planning: milestones, module map, Kimi call, daily history | done |
