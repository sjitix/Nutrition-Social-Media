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

0. **The history holds only what actually happened.** A file exists for a day once that day has been
   worked, and it carries its date. **Nothing planned goes in here** — the schedule ahead lives in
   `docs/v1/01-dimensions-and-milestones.md` and, on the board, in a separate collapsed block. Mixing
   the two makes a record of intentions, which is the one thing a work log must not become.
   (Owner's instruction, 2026-09-19, left as a comment on the day-log board.)
1. **One file per day, per lane.** Since 2026-10-03 two agents work in parallel (`docs/parallel/`): the v1 lane writes `YYYY-MM-DD.md`, the accounts lane `YYYY-MM-DD-accounts.md`. Never append to a shared file — two machines writing the same day's file is
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
| [2026-09-19](2026-09-19.md) | V1 planning: milestones, module map, Kimi call, daily history — plus the three boards | done |
| [2026-10-02](2026-10-02.md) | Library expansion + ingredient identity (day 5 added); context files brought current | done |
| [2026-10-03](2026-10-03.md) | Track E — the direct-manipulation layer, H1–H8: tap a meal and change it, no model anywhere | done |
| [2026-10-03 · accounts](2026-10-03-accounts.md) | Parallel lanes set up; accounts A1–A4 built, then an adversarial review fixed login CSRF (PKCE), cross-account uploads, jsonb key-order churn, restore-deletions and stale writes; the SQL executed for the first time (PGlite) and a TRUNCATE grant closed; clock skew fixed (a logical clock); a second review fixed in five batches (the write fence: a stale tab can no longer write into another person's data), and a third review of that work fixed in a sixth | done; live run waits on keys |
| [2026-10-03 · models](2026-10-03-models.md) | Models lane: the read-tool fix, the date line and the false-claim guard landed via v1; the conversation eval separates sizes (550B 11–12/14, 20B 6/14); a harness review fixed free passes; the speed claim withdrawn as not established | partial: the fair re-measurement cut short |
| [2026-10-18 · models](2026-10-18-models.md) | Models lane resumes on the laptop: the evals import only the folder barrels; a stub model server found and closed two free passes in the lane's own evals (no past score changed); v1's two bug fixes re-checked model-free (1/4 before, 4/4 after); the fair re-measurement must re-run arm A | partial: every model run waits on a missing `.env.local` |
| [2026-10-18](2026-10-18.md) | v1 resumes: the WIP branch landed (two assistant bugs, the hardened gate), D5a's last move (storage into persistence/), ThemeSwitch through storage; the allergen binding closed after a six-agent review (`09f325f`, `ba23884`); `ship.mjs` v2 with a 43-scenario harness after a 45-finding audit; every owner decision in one commentable doc; the owner's rules for every lane | partial: Track A done except the shims; the allergen notes (B2) in review, imported dishes (C) next |
| [2026-10-20](2026-10-20.md) | v1: the allergen notes landed (B2, `c8ccfb0`: a true note on every allergy remark, refused swaps name the allergy, the undo says when it took one off, the false-claim guard widened with the models lane's audit); script bundles per worktree (`6509cdb`); imported dishes (C) and the agent loop's lost answers (D) built and proven, shipping as one; duplicate lane agents stood down | partial: C+D queued behind the accounts lane's gate; the shims and a diet-boost bug next |
| [2026-10-18 · accounts](2026-10-18-accounts.md) | Accounts run live with no Supabase project: the real GoTrue, PostgREST and Postgres as user-level binaries in WSL, the real `client.ts` driven by six browsers; two adversarial reviews of that tooling (35, then 16 confirmed) rebuilt its checks to fail for the reason they name, 17 of the 38 proven so by mutation (38/38, 17/17), and GoTrue's latest-request rule for links found; "/" stops loading `storage.ts` (−3.16 kB gz); D5a's persistence move scoped and checked | done; the hosted project still waits on the owner |
| [2026-10-20 · accounts](2026-10-20-accounts.md) | Accounts: the live run's second review landed (`4663a81`): 17 of its 38 checks proven able to fail, the takeover sentence true for both causes, bundles and journals in the worktree's own `.cache/`. Its first ship passed its gate and delivered nothing, stopped by two other lanes' doc commits, so shared docs now ship in a commit of their own (lesson 69) | done; the hosted project still waits on the owner |
| [2026-10-21 · accounts](2026-10-21-accounts.md) | Accounts: all three items the README listed as not exercised now run live. The Site URL batch (`c284616`): sign-out on one of two devices ends only that one; a preview's link landing on the Site URL; each of the takeover sentence's three causes on the real GoTrue, and two sentences that blamed another browser for another web address fixed. Then "Confirm email" on (`a915d12`), on a second GoTrue: a first link's five minutes counted from the request, the magic link after it from the open, a refused request rolled back with the sign-up. Two reviews (21, then 14 findings) made the mutation runner measure instead of predict: 35 of the live run's 50 checks proven able to fail | done; "Try again" live and the hourly cap stay listed as not exercised |
| [2026-10-22 · accounts](2026-10-22-accounts.md) | Accounts: the "Confirm email" review's fixes landed just after midnight (`2bd92e8`): the rollback described as GoTrue does it (confirmed versus not), the first link's limit bracketed at four and six minutes, and "Try again" live and the hourly cap back under "Not exercised" | done |
| [2026-10-20 · models](2026-10-20-models.md) | Models lane: every eval check fixed (30 loop, 14 conversation), with 524 controls proving them (an audit had found 153 of 337 wrong answers passing), each must-fail control failing for its own reason; a held-out `contradiction`; the false-claim guard measured 1/15, then 15/15 with v1's B2 | the harness: done; model runs wait on `.env.local` |
| [2026-10-21 · models](2026-10-21-models.md) | Models lane: `probe-quotes.mjs` lists the eval messages the prompt the model is sent quotes (8 of 55 on main), and every one has a held-out paraphrase graded by the same code; an adversarial review reworded four held-outs and closed checks that passed wrong answers (offering both halves of a clash, a chosen "1,600 a day", a saved "low on iron"); on v1's `da023da` the probes pass and 633 controls hold, five of them flipped to must-pass by D | yes, key-free; model runs wait on `.env.local` |
| [2026-10-21](2026-10-21.md) | v1: the review fixes landed as one commit (`da023da`): imported dishes answer to the hard rules (C), the agent loop keeps answers and the undo slot (D), a boost keeps the new diet (E), a slot-scoped constrain keeps its slot (F), an undo beside a new allergy runs first (G, an I2 hole), and B2's notes are written from the final week; 51 new rows, 35 failing on the parent. The first gate died with the session after the laptop slept. Evening: Track A done, the 28 D5a shims deleted (`5b6d874`); cook time met exactly (decision 13, measured: 68 of 252 meals had run silently over a 15-min limit, landed in `4bc9e47` with the second review's loop and boost fixes) | yes: the batch, Track A, and the review's first three follow-ups (`4bc9e47` 1081/0, `7624008` 1094/0, `ef71993` 1101/0) |
| [2026-10-22](2026-10-22.md) | v1: F4 landed (`afa7f89`, 1167/0), the last of the second review's follow-ups. Its own review (31 findings, 12 sent to a skeptic, none refuted) caught four allergen holes before it shipped: the covered rule ignored the matcher's exceptions ("tortillas" under "gluten"), "glass noodle" stored "noodle", and two older ones (a dish's parts read as one phrase, so "rice" then "flour" passed a wheat allergy; a tortilla allergy served corn tortillas). Every allergen word the matcher knows now binds unlabelled (LC-08). Re-measuring after each fix found three over-blocks the fixes made (lesson 72): 0 of 1,800 rows block less than the parent. Evening: the fast finish landed (`b2b4285`, 1179/0), set per model with `AI_FAST_FINISH`: on Nemotron, 1.2 model calls a message against 1.8, but its review showed the skip also cuts a model's next write, safe only where the model never splits (the 550B: 0 of 275). The owner chose Nemotron (decision 1) and said not now to splitting the lane | yes; F5 next, its model-failure findings first (an urgent-care reply and a stated allergy lost on a failure); flour to decision 9 |
| [2026-10-22 · models](2026-10-22-models.md) | Models lane: the key is in, and Nemotron-3-Ultra 550B is measured. Reasoning off plus the fast finish is about 2.8 times faster at no loss (5.5 s median, 26-28 of 34 over four runs), so the fast finish shipped (v1, `b2b4285`). The evals can now run that native path (`0327c45`; no model run on it yet), and a sleep can no longer inflate a latency figure. 633 controls hold on `b2b4285`. The diagnosis is on record (8 of 9 clusters; three safety guards for v1), and NVIDIA's free endpoint turned out to be for testing only, so launch needs a paid host | partly: the speed range and the prompt fixes next |
| [2026-10-23](2026-10-23.md) | v1: model failures, part 1 (`950d243`, 1198/0). An urgent-care reply or any engine answer survives a later model failure (no more "offline" over it), and a turn the model sent but nobody could read keeps the allergy and symptom it stated. Its review (10 majors, each checked by probe) changed it before it shipped: the first version ended the run on any urgent reply, cutting an allergy the next step would bind. F6, the crisis op, built and waiting on the models lane's run; the history-allergy design agreed | yes for F5a-1; F6 waits on its measurement |
| [2026-10-23 · models](2026-10-23-models.md) | Models lane: the review of `0327c45` fixed (the lock polls every 5 s and survives a hard kill; arms N and convoN are the default; the docs claim only what was shown), and all seven of the diagnosis's harness corrections in: crisis rows graded on what the person reads (with held-out phrasings the pre-scan misses), an implied and a negative reserve scenario, twins for pin-then-shake and allergy-carry, pin-only rate controls, an offer to choose the person's number failing, full replies, and first-attempt failures counted. Loop 38 scenarios, convo 17 | partly: the timed runs wait for the charger |
