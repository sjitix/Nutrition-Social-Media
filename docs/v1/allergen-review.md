# The allergen review — 2026-10-18

**Invariant I2: an allergen never reaches a plate.** The models lane found it broken. A remembered fact
bound the engine only when the model labelled it `allergy`, and a 20B model often did not:
"allergic to shellfish" with no label left shrimp in the week. The lane's patch (`49385e5`) made any
fact that SAYS allergy bind. Before landing it, six agents reviewed it adversarially:
- three probers, one each for over-blocks, under-blocks, and lifecycle and honesty;
- a skeptic for each prober, who re-ran every finding;
- every proposed fix measured on a scratch copy before any of it was believed.

The result: **36 findings**, all reproduced. Each status below was re-measured on `5d1c529` (after A and
B1) with the review's own facts, on an empty profile. A "(n)" is how many of the 501 library recipes the
stored allergies block.

| Commit | What it did |
|---|---|
| **A** `09f325f` | A fact that says allergy binds, whatever its label. A fact whose every cue is denied binds nothing. A carrier word ("oil", "powder", "breast") never binds on its own. test:engine 971/0. |
| **B1** `ba23884` | One closed cue list (plurals, misspellings), every cue in a fact read, plural category words, a linear-time parse. 984/0. |
| **B2** `c8ccfb0` | What the person is told: an engine note on every allergy remark, swap notes that name the blocking allergy, the undo wording, the bound list in the prompt, dedupe, and a false-claim guard widened with the models lane's audit (38/38 claims caught, 0/37 honest lines tripped). test:engine 1010/0. |
| **C** *(in its gate)* | An imported dish holding a newly bound allergen is re-picked, and named. A logged meal stays; a dislike never removes an import. |

## Status

**Over-blocks** (a fact that is not an allergy banned food):

| ID | The fact | Now | Status |
|---|---|---|---|
| OVER-1 | "Not lactose intolerant, drinks milk every day" | nothing | fixed, A |
| OVER-2 | "No allergies; eats dairy and gluten" (was 59% of the library) | nothing | fixed, A |
| OVER-3 | "allergic to cats but loves fish" | fish (70) | **open**. The review's fix for allowance clauses was unsafe. |
| OVER-4 | "allergic to essential oils" | "essential oils" (0) | fixed, A. "oils" never binds alone; the stored phrase blocks nothing. |
| OVER-5 | "I was allergic to milk as a child but grew out of it" | nothing | fixed, A |
| OVER-6 | "my coeliac friend visits on Saturday" | gluten (163), all week | **owner decision 12** (does everyone mentioned stay protected?) |
| OVER-7 | "intolerant to spice" | spice (47) | **open**, low harm: a preference filed as an allergy |
| UNDO-1 | a correction turn adds a second allergy | two-turn form: nothing | fixed, A. **Accepted:** the one-fact form "not lactose intolerant, I meant gluten intolerant" binds both (299). Dropping a single denied cue's foods is the per-clause rule the review measured as unsafe. |

**Under-blocks** (an allergen could reach a plate):

| ID | The fact | Now | Status |
|---|---|---|---|
| U1 = LC-01 | an imported dish when its allergen is bound later | the dish stays | **C** (in its gate) |
| U2 | "can't have dairy" (no cue word) | nothing unlabelled | **open by design**: every cue-less fix over-blocks. Labelled, it binds. |
| U3 | "food intolerances: lactose" | lactose (193) | fixed, B1 |
| U4 | "allergic to crustaceans" | crustaceans (24) | fixed, B1 |
| U5 | "lactose intolerent" | lactose (193) | fixed, B1 |
| U6 | "Allergic to peanuts. Also allergic to sesame." | both (100) | fixed, B1 |
| U7 | "egg-allergic toddler"; "allergic to the following: peanuts" | nothing (labelled: "toddler"; "following") | **open** |
| U8 | the model's "I've excluded it" stands when nothing bound | | fixed, B2 `c8ccfb0` |
| U9 | "I love prawns but I'm allergic to them" | nothing | **open**: "them" is not resolved |
| U10 | "allergic to satay" / "allergic to hummus" | satay (0) / hummus (8) | **open**: the dish is stored, its allergen (peanut, sesame) is not |
| U11 | "allergic to legumes" | nothing (labelled: blocks 0) | **open**: chickpeas and lentils are still planned |
| U12 | coeliac leaves unlabelled oats | | **owner decision 11** |
| LC-08 | "allergic to hazelnuts" (unlabelled) | nothing | **open**, needs its own design (see below) |

**Lifecycle and honesty:**

| ID | What happens | Status |
|---|---|---|
| LC-02 | undoing a swap also drops an allergy bound in the same turn | **decision 12**. Since B2 the undo says so ("That also took eggs off your allergies"). |
| LC-03 | nothing in chat removes an allergy | **decision 12** |
| LC-04 | "not allergic to eggs any more" ADDED eggs | fixed, A |
| LC-05 | a carrier word bound alone ("oil") | fixed, A |
| LC-06 | an allergy remark with no engine note lets the model's prose stand | fixed, B2 `c8ccfb0` |
| LC-07 | a swap refused for an allergy said "I didn't have …" | fixed, B2 `c8ccfb0` |
| LC-09 | a token the matcher ignores ("red" from "red dye") was stored and announced | fixed, B2 `c8ccfb0` |
| LC-10 | a re-sent memory would re-add a removed allergy | **decision 12**; latent until removal exists |
| LC-11 | restating a bound allergy wrote no note | fixed, B2 `c8ccfb0` |
| LC-12 | the undo reply's grammar ("before I your last change") | fixed, B2 `c8ccfb0` |
| LC-13 | the next prompt never shows the bound list | fixed, B2 `c8ccfb0` |
| LC-14 | the before-cue scan was quadratic (3.2 s on 40k characters) | fixed, B1 (32 ms) |
| LC-15 | a logged meal can be re-picked by a bind | with D7 meal logging (a logged meal needs a mark) |
| LC-16 | the same allergy stored by surface form ("peanuts, peanut") | fixed, B2 `c8ccfb0` |

## Rejected fixes, and why (do not repeat these)

- **Parse only the clauses a fact affirms** (a per-clause denial regex). On 10 real allergy statements
  it dropped 9, among them "not allergic to anything except peanuts", "never outgrew my peanut
  allergy" and "used to be able to eat shellfish, now allergic". A uses **every cue denied** instead:
  a fact binds nothing only when each of its cues is denied.
- **The wide cue `\ballerg\w*`** read "allergist cleared him to eat eggs" as an egg allergy. B1 uses a
  closed list of the forms people actually type.
- **Bind every unknown word after a cue** (LC-08). "hay fever allergy in spring" banned spring onions;
  "skin allergies" banned two recipes; pet, drug and seasonal allergies bound nonsense. Unknown food
  words need a vocabulary built from the library's own ingredients, with its own over-block probe set.
- **A model-invoked `remove_allergy` op** (LC-03). It would be the one path that puts an allergen back
  on a plate on the model's word ("my daughter isn't allergic to eggs any more" could remove YOUR egg
  allergy). Removal belongs to a deterministic control: decision 12.
- **Reaction phrases as cues** ("sensitive to", "reacts badly", "can't have"; U2). They over-block, and a
  labelled fact already binds.

## Where the evidence lives

- The review's must-bind and must-not-bind rows are tests in `scripts/test-engine.mts`: MUST_BIND,
  OTHER_BIND, MUST_NOT_BIND, the carriers, and B1's under-block rows plus its linear-time bound.
- The models lane's model-free probe, `scripts/models/probe-allergy-labels.mts` (28 rows), passes on
  B1, and B1's parent fails exactly the new rows.
- The "Now" column is `npm run probe:allergens` (`scripts/probe-allergen-review.mts`): each finding's
  fact through one `remember`, unlabelled and labelled, with the number of recipes the stored allergies
  block. Re-run it before trusting a row older than the last allergen commit.
