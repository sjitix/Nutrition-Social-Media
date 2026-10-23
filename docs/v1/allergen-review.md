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
| **C–G** `da023da` | An imported dish answers to the hard rules: always to an allergy, and to a new diet or a newly avoided food when that change introduced it. Its note names the dish and the rule, never a replacement a later step can change. A logged meal stays. An undo in the same turn as a new allergy runs first (G). Every allergy sentence is written from the turn's final week. Shipped with the agent-loop (D), boost (E) and scope (F) fixes, after a second adversarial review. test:engine 1061/0. |
| **F1, F2, F3** `4bc9e47`, `7624008`, `ef71993` | The second review's follow-ups. For allergies, F2 matters: an undo across loop steps no longer takes back an allergy the same run bound (LC-21), and the claim guard catches "I've excluded shellfish" again (LC-20). F3 gives imports a diet matcher of their own (LC-22). test:engine 1101/0 after F3. |
| **F4** `afa7f89` | The review's minors, LC-08, and what F4's own adversarial review found. An unlabelled allergy fact binds any of the matcher's 182 allergen words (93 bound nothing). A food a stored allergy already blocks entirely is named as covered, judged with the matcher's exception phrases (LC-23). A dish's parts are kept apart for the matcher (LC-25), a tortilla, noodle or cracker allergy blocks what the gluten words except (LC-26), and a phrase is never split into a word that serves it (LC-24). Against the parent: 0 of 126 stored facts bind differently; under three stored allergies, 0 of 1,800 rows block less. test:engine 1167/0. |
| **F7** `42b6e51` | The history allergy (LC-29): an allergy stated in an earlier message binds before the first model call, through the same gate. A message whose turn got no answer is read for statements; an answered one binds only what its reply promised or the speaker stated as their own. On the way, the gate stopped storing lead-in phrases ("fyi lactose", LC-30) and read "tho" as a contrast (LC-31). Against the parent: 3,702 stored-allergy rows, 0 block less. test:engine 1223/0. |

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
| U1 = LC-01 | an imported dish when its allergen is bound later | replaced, and named | fixed, C `da023da`. A pinned import is taken out and the pin goes back in its slot. |
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
| LC-08 | "allergic to hazelnuts" (unlabelled) | hazelnut | fixed, F4 `afa7f89`. 93 of the matcher's 182 allergen words bound nothing unlabelled; the vocabulary is the matcher's own words (see below) |

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
| LC-17 | "I'm allergic to peanuts" in the same turn as an undo, in either order, left no allergy and a peanut dish, under "nothing containing them will be planned" (the models lane's undo-flow audit) | fixed, G `da023da`: the undo runs first, alone |
| LC-18 | "nothing with it is planned" while an import still held the allergen; a restated allergy left that dish in place | fixed `da023da`: notes are written from the final week, and a restated or denied bound allergy that a planned dish holds re-solves the week |
| LC-19 | a refused swap blamed an allergy on a dish the person never asked for ("veggie burger" read "Cheeseburger & Fries contains dairy" in 45 of 92 such notes) | fixed `da023da`: a dish is named only when it matches every word asked; a dish the diet refuses says so |
| LC-20 | the claim guard replaced honest replies (a refusal, a decline, a question offering a change) and missed "I've scaled Saturday down" | fixed `da023da`, then corrected by F2 `7624008`. The first fix excused every claim in a reply that asked anything: "Got it — no more celery in your week! Anything else?" and "I've excluded shellfish across your whole week" were shown with nothing bound. Now judged per sentence; over all 1,045 stored replies only two stored claims change verdict |
| LC-21 | "I'm allergic to peanuts, and undo that swap" sent by the model as two steps, [remember] then [undo]: the undo reverted the run's own allergy and left the peanut dish the swap had placed | fixed, F2 `7624008`: an undo never takes back what the same run remembered; a run that only remembered undoes the previous turn |
| LC-22 | an imported plant-based dish taken out of a vegan week as "isn't vegan (it has coconut milk)" (the import diet judged with the library's substring lint) | fixed, F3 `ef71993`: imports get a matcher of their own (diet, not allergy: I2 was never at stake). It agrees with the library's own tags exactly |
| LC-23 | the covered rule called "tortillas" covered by a stored "gluten", whose exceptions let corn tortillas through, so 11 dishes stayed plannable under "already covered" | found by F4's review in F4's first version, fixed before it landed: `exclusionCovers` judges every exception phrase too |
| LC-24 | "I have a glass noodle allergy" stored "noodle", whose exceptions serve glass noodles | found by F4's review in F4's first version, fixed before it landed: splitting a phrase keeps the narrow food test, and keeps the phrase when its words do not block it |
| LC-25 | an imported dish's ingredient names, joined with spaces, formed an exception phrase ("cocoa" then "butter", "rice" then "flour"): butter passed a dairy allergy, flour a wheat one | pre-existing since C; fixed, F4 `afa7f89`: `mealHaystack` keeps the parts apart, for every matcher call on a dish (0 of 198,396 library verdicts change) |
| LC-26 | an allergy to tortilla, noodle or cracker inherited the gluten category's exceptions: "I have a tortilla allergy" served corn tortillas | pre-existing; fixed, F4 `afa7f89` for those three. A bare "flour" allergy still lets chickpea and oat flour through (5 dishes): decision 9's new row |
| LC-27 | "I'm allergic to peanuts. Also make Wednesday's lunch and dinner vegetarian.": the model's turn [remember, a constrain whose scope the schema refuses] was refused whole, so the allergy was never stored and the peanut dish stayed (F5's mapping, MF-2) | fixed, F5a-1 `950d243`: an unreadable turn's remember and symptom ops are kept, read leniently, on every unreadable turn; a cut-off answer's ops are found in its text. Open on the Claude path, whose SDK keeps no text (F5a-2) |
| LC-28 | F5a-1's first version: its override break cut a remember the model's NEXT step would have sent after an urgent reply, and its salvage dropped a remember labelled "Allergy" or null | found by its review before it landed, fixed in it: only a crisis ends the run, and the salvage reads labels leniently |
| LC-29 | an allergy stated in an earlier message that the turn never stored (a failed request, a pre-scan answer, a "noted" with no op; the models lane's memory-allergy, 1 of 4 at reasoning off) | fixed, F7: the history allergy. A message whose turn got no answer is read for statements; an answered one binds what its reply promised to keep out, or what the speaker stated as their own. Bind with a note or ask first: decision 15 |
| LC-30 | "fyi i have a lactose intolerance" stored "lactose, fyi lactose", and the note announced both: "lactose", "gluten", "casein" and "cmpa" never block their own name, so a lead-in word before one was kept as a phrase of its own | pre-existing in the live gate; fixed, F7. The comparison: 390 rows change only their stored text or note, 0 block less |
| LC-31 | "can we do more fish this week? not shellfish tho i'm allergic" read as a denial: the denial reading broke on "though" but not on "tho" | pre-existing; fixed, F7 ("tho", "altho"). 12 rows now block more, each a "tho" statement; every "tho" denial still binds nothing |
| LC-32 | the history scan, a keyword test, over-binds messages that state no allergy: a joke ("severely allergic to beetroot. Not medically"), a past one ("cleared up years ago"), someone not fed ("my friend tom is allergic to shrimp but he can't make the barbecue") | measured on four blind phrasing sets, not fixable by keywords alone: on the fourth, 9 of 45 in a failed turn, 4 of 45 in an answered one. Kept small by trusting it only where nothing else read the message; decision 15 |

LC-17 to LC-26 came after the 36. LC-17 is from the models lane's audit of its evals. LC-18 to LC-20 are from the
adversarial review of B2 and of the C–F batch (2026-10-20: four reviewers, a skeptic per serious finding). LC-21 and
LC-22 are from the second review, of `da023da` (2026-10-21). LC-23 to LC-26 are from F4's own review (2026-10-22).
LC-27 to LC-29 are from F5's mapping and the F5a review (2026-10-22). LC-30 to LC-32 were found while building the
history allergy (F7, 2026-10-23): LC-30 by an over-bind sweep of its own, LC-31 and LC-32 by blind phrasing sets
written by other agents.

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
  F4 uses the matcher's own allergen words as that vocabulary, for whole tokens only. On 64 over-block probes the
  only new foods blocked come from allowance clauses (OVER-3's class) or a sentence the model labelled an allergy.
- **The wide food test inside a phrase** (F4's first version). Splitting "glass noodle" stored "noodle" (LC-24),
  "sesame seed" stored "seed", which blocks every seed dish, and the matcher's kept compounds split into "corn"
  and "rice". The wide test is for whole tokens; a phrase is split with the curated words only.
- **Keeping the matcher's two-word foods whole in `knownPhrase`** (F4's first version). "allergic to tikka masala"
  then stored neither "tikka" nor "masala", and blocked 13 dishes fewer than main.
- **A model-invoked `remove_allergy` op** (LC-03). It would be the one path that puts an allergen back
  on a plate on the model's word ("my daughter isn't allergic to eggs any more" could remove YOUR egg
  allergy). Removal belongs to a deterministic control: decision 12.
- **Reaction phrases as cues** ("sensitive to", "reacts badly", "can't have"; U2). They over-block, and a
  labelled fact already binds.
- **Reading every earlier message with the statement filters** (F7's first version). Tuned on one phrasing set, the
  filters bound something for 15 of 60, then 14 of 50, then 8 of 50 messages from the next blind set that stated no
  allergy: each set found new phrasings (a dog, a documentary, a cousin abroad, "a myth"). So an ANSWERED message
  binds only what its reply promised or what the speaker stated as their own; the filters read only a message
  nothing else read.
- **Feeding the history scan whole messages.** The gate reads every food in its fact once a cue is present: "i'm
  allergic to peanuts, can you add more chicken and rice?" bound chicken and rice, and "what if i was allergic to
  eggs?" bound eggs. The scan cuts one clause per cue.

## Where the evidence lives

- The review's must-bind and must-not-bind rows are tests in `scripts/test-engine.mts`: MUST_BIND,
  OTHER_BIND, MUST_NOT_BIND, the carriers, and B1's under-block rows plus its linear-time bound.
- The models lane's model-free probe, `scripts/models/probe-allergy-labels.mts` (28 rows), passes on
  B1, and B1's parent fails exactly the new rows.
- The "Now" column is `npm run probe:allergens` (`scripts/probe-allergen-review.mts`): each finding's
  fact through one `remember`, unlabelled and labelled, with the number of recipes the stored allergies
  block. Re-run it before trusting a row older than the last allergen commit.
