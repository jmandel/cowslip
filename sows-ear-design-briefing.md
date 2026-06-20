# Sow's Ear — Game Design Briefing

**Version 0.3 · Full standalone game, room-scoped web app**
*A cooperative word game where every letter counts.*

This briefing supersedes the earlier "online reproduction / local companion" spec. The project is now a **full standalone game** — a clean-room cooperative word game playable by people who have never seen the physical inspiration and own nothing. All content (categories, art, rules text, vocabulary) is original. There is no dependency on a physical box and no reproduction of any publisher's deck.

---

## 1. What changed since v0.1

| v0.1 (companion) | v0.3 (full game) |
|---|---|
| Phone companion for one household that owns the physical game | Standalone web game for remote groups who own nothing |
| Stored zero content; categories typed in manually from a physical card | Ships its own original **Field** packs |
| Target-setter picked a word; mechanics borrowed | Same free-form invention, but now the whole product is original |
| Three rulebook details flagged "confirm before calling it exact" | We are **not** claiming fidelity — those three are now our own design knobs, decided below |
| Archery theme (archer / arrow / bullseye / target) | Farm theme (**Sow's Ear**), archery dropped entirely |
| Account-based online app | Casual room-based web app: `?room=whatever`, no email, no password, no registration |
| Authenticated identity and server-only secrets | Room-local handles. Secrecy is enforced by normal UI flow and social trust unless a later server/private-channel layer is added |

The single most useful consequence: because we are an **original game inspired by a mechanic**, not a reproduction, every previously "unconfirmed" rule becomes a free design choice. We tune for fun, not fidelity.

---

## 2. Design pillars

1. **The comedy is the product.** The fun is a clue getting garbled as it's handed down the line — "ST…" was meant to be STABLE, the next Hand thought STRAW, and the Farmer has to make sense of the wreckage. The whole experience should celebrate that, especially in the recap.
2. **Earlier is braver.** Guessing on one letter is a gamble worth more than guessing on five. That tension — *name it now, or wait for one more letter* — is the entire game. Every scoring decision must preserve it.
3. **Theme in the art, clarity in the controls.** Buttons and labels stay plainly functional. The farm lives in the illustration, the flavor copy, and the celebration moments. Never make a player decode a cute label to take a basic action.
4. **No one finishes their own thought.** Hands never complete a clue; they plant one letter and pass the Row along. This is sacred — it's what separates the game from ordinary word-guessing.
5. **Humans adjudicate, software doesn't judge meaning.** With free-form Seeds there is no answer key. People decide what counts. The app's job is to make that fast and fair, not to pretend to understand language.
6. **No account friction.** A link and a handle should be enough to play. The game is for friends on a call or people in the same room, not for a public ladder where identity must be hardened.

---

## 3. The naming canon

Two columns. **Player-facing** is what appears in art, copy, tutorial, and recap. **Engine-internal** is what the code, schema, and logs use — kept neutral on purpose so a future reskin never forces a data migration. Build to the right column; theme with the left.

| Concept | Player-facing (Sow's Ear) | Engine-internal (stable) |
|---|---|---|
| The whole game | **Season** | `game` |
| One round | **Harvest** | `round` |
| The guesser | **Farmer** | `archer` |
| The secret-setter | **Sower** | `targetSetter` |
| The other clue-givers | **Hand** / Farmhand | `clueGiver` |
| The category | **Field** | `category` |
| The secret answer | **Seed** | `target` |
| A clue track | **Row** | `arrow` |
| Add one letter | **plant a letter** | `submitLetter` |
| Reveal letters | letters **sprout** | `reveal` |
| Rotate / pass | **the handoff** ("down the row") | `rotate` |
| Score for a guess | **Ribbon** | `shotScore` |
| End-of-game total | **County Fair** | `finalScore` |
| A miss | **spoiled** / a dud | `miss` |
| A persistent gathering place | **Room** | `room` |
| A player's room-local name | **Handle** | `handle` |

**Plain UI labels that do NOT get themed:** Category, Guess, One More Letter, Pass, Submit, Correct, Miss. (These match the asset frame already produced.)

### Flavor copy (microcopy)

- Correct on letter 1: *"A silk purse out of a sow's ear!"*
- Correct on letters 2–3: *"Now that's a fine harvest."*
- Correct on letters 4–5: *"Brought it in just in time."*
- Spoiled / wrong: *"Still just a sow's ear — there's always next season."*
- Farmer waiting: *"The Hands are tending the rows…"*
- Sower choosing: *"The Sower is planting the seed…"*
- Empty Season recap: *"Quiet season. Plant something next time."*

The silk-purse idiom is the built-in win/lose pair. Lean on it — that one line does more thematic work than any amount of UI chrome.

---

## 4. Players, roles, objective

**Players:** 3–8, all cooperative. Everyone wins or loses together; there is no individual winner.

**Identity:** Players join a Room by URL and type a handle. There is no email login, password, magic code, or account creation. In a given Room, the handle is the player identity; using the same handle on another device means resuming as that person. This is intentionally casual and social, not adversarial identity proof.

**Objective:** Across the Season, the group names as many Seeds as possible, as early as possible, to collect the best Ribbons. At the end, your best harvests go to the **County Fair** for one shared final score.

### Roles each Harvest

- **Farmer** (one player) — chooses the Field, never sees the Seed, reads the sprouting Rows, and makes the single decisive guess.
- **Sower** (the next seat in pass order) — receives the chosen Field, invents any Seed that fits it, shows it to all the Hands, hides it from the Farmer, and also tends a Row as a Hand.
- **Hands** (everyone else, including the Sower) — each privately thinks of a clue word about the Seed and plants its letters one at a time, but never on a Row they started.

Roles rotate by seat each Harvest, so everyone takes turns being Farmer.

---

## 5. Core rules (original text)

### Setup

1. Seat all players in a fixed order with a single pass direction (down the row, to the left).
2. Choose a starting Farmer.
3. Load a Field pack (or let the group pick one).
4. Each Hand will tend exactly one Row; the Farmer tends none.

### A Harvest, step by step

**1 — The Farmer picks the Field.**
The Farmer is privately shown **two** Field cards and chooses one. The chosen Field becomes **public to everyone, including the Farmer.** This is intentional and not a leak — the Field is the *search space*, not the secret. Knowing "Farm Animal" doesn't reveal GOAT; it just makes the sprouting letters interpretable. The Farmer needs the Field visible the whole Harvest. Because the Field is chosen *before* the Seed exists, the Farmer can't steer toward an easy answer — only toward which field they'd rather play in.

**2 — The Sower plants the Seed.**
The Sower invents **any** word or short phrase that fits the Field — not from a list. Example: Field *Farm Animal* → Seed **GOAT**. Every Hand sees the Seed; the Farmer does not. Once locked, the Seed cannot change.

**3 — The Hands think of clues.**
Each Hand privately settles on a clue word related to the Seed (for GOAT: HORN, MILK, BEARD, BLEAT…). They never write or say the whole word. Later Hands are *supposed* to infer what an earlier Hand was spelling — that inference, and its failures, are the heart of the game. Hands must not coordinate.

**4 — Plant the first letter.**
Every Hand plants the first letter of their clue on their Row. Plantings are simultaneous and hidden until everyone has planted, then they all **sprout** at once. (No Hand may choose a letter after seeing someone else's.)

**5 — The Farmer decides: guess or wait.**
After the Rows sprout, the Farmer either:
- **Guesses** — one formal answer. Correct earns the Ribbon for the current letter-depth; wrong ends the Harvest at zero. There is effectively one guess per Harvest.
- **Waits** ("One More Letter") — if fewer than five letters have sprouted. The Rows **hand off** one seat down the line (skipping the Farmer), so each Hand inherits a Row someone else started.

**6 — Continue an inherited Row.**
Each Hand plants the next letter of the Row they now hold, inferring what the existing prefix was meant to become. If a Hand truly can't continue, they may plant a blank (`_`), which still consumes that letter position.

**7 — Repeat** until the Farmer guesses or five letters have sprouted.

**8 — Resolve.**
Reveal the Seed to the Farmer, award the Ribbon, show the final Rows, optionally show who planted each letter, and pass the Farmer role to the next seat.

### The fifth-letter rule (decided)
At five letters there is no "One More Letter." The Farmer must **Guess** or call it **Spoiled** (give up). The app must not offer waiting at depth five.

### Scoring — Ribbons

| Letters sprouted when guessed | Ribbon |
|---|---|
| 1 | 20 |
| 2 | 10 |
| 3 | 7 |
| 4 | 5 |
| 5 | 3 |
| Wrong or spoiled | 0 |

These values are tunable, but the **shape must stay "earlier is worth more."** That descending curve is what makes waiting a real gamble.

### End of Season — the County Fair
Total the group's **five highest Ribbons** for a final score out of **100**. (Best-five rewards a few great calls over grinding every Harvest, and keeps the ceiling clean.)

### How many Harvests
Lower counts get two turns as Farmer each; higher counts get one:

```
Farmers per player = (3–4 players) ? 2 : 1
```

| Players | Harvests |
|---|---|
| 3 | 6 |
| 4 | 8 |
| 5 | 5 |
| 6 | 6 |
| 7 | 7 |
| 8 | 8 |

### Three-player variant
With three players there is one Farmer and two Hands, but **four Rows** — each Hand tends a left and a right Row. On the handoff: your left Row goes to the other Hand, your right Row slides into your left, and you receive a Row into your right. So each Hand plants **two letters per depth**, and every Row still gets exactly one new letter. (This keeps a three-player game as rich as larger ones.)

### Locked rules config

```ts
type SowsEarRules = {
  rulesVersion: "sows-ear-0.3";
  farmersAtThreeOrFour: 2;
  farmersAtFiveToEight: 1;
  maxLetters: 5;
  ribbonByDepth: [20, 10, 7, 5, 3];   // depth 1..5
  countyFairMode: "best-five";        // top 5 Ribbons, max 100
  fifthLetterBehavior: "guess-or-spoil";
};
```

```ts
const RIBBON_BY_DEPTH = [0, 20, 10, 7, 5, 3] as const;

export function ribbon(correct: boolean, depth: number): number {
  if (!correct || depth < 1 || depth > 5) return 0;
  return RIBBON_BY_DEPTH[depth];
}

export function countyFair(ribbons: number[]): number {
  return [...ribbons].sort((a, b) => b - a).slice(0, 5)
    .reduce((sum, r) => sum + r, 0);
}
```

---

## 6. Free-form Seeds and adjudication

Because the Sower invents the Seed and there is no answer key, **human adjudication is the primary correctness mechanism, not an edge case.** Design it as a first-class flow, not a buried modal.

**Solvability is never at risk** — the Hands always see the Seed, so they can always clue it. The only real failure mode is a Seed too obscure to clue well, or too trivial. Don't police this in software. A gentle nudge in the Sower's input ("long phrases and obscure proper nouns are hard to clue fairly") is enough. Clue legality stays social.

**The guess flow:**
1. The Farmer's guess is normalized (see §11) and compared to the normalized Seed.
2. Exact match → auto-accept, award the Ribbon.
3. Anything else → the **Sower** sees the original Seed, the Farmer's guess, and **Accept as equivalent / Reject.** This handles plurals, articles, punctuation, spelling variants, abbreviations, and reasonable alternate names without an unreliable language model.

Store both raw and normalized forms of Seed and guess for audit.

---

## 7. Content — Fields (the product)

As a standalone game, **content is the product.** Fields are cheap to author and carry near-zero IP risk as long as we write our own (short noun-class categories like "Planet" or "Condiment" are not ownable; do **not** clone any specific published deck).

**A Field names a *kind of thing*; the Sower invents a specific member each Harvest.** The Field is a noun class, not a property prompt: *Planet* → MARS, *Condiment* → KETCHUP, *Sci-Fi Movie* → ALIEN. Keep labels **short and concrete** — a tight class makes the sprouting letters interpretable for the Farmer (the Field is the *search space*, per §5). Avoid open property prompts ("Things That Are Round," "Things You Can Peel"): they describe a quality rather than a class, barely constrain the answer space, and flatten the comedy.

**A Field carries no answers.** The Seed is invented each Harvest. We only author prompts.

```ts
type Field = {
  id: string;          // stable slug
  label: string;       // "Sci-Fi Movie"
  locale: string;      // "en-US"
  packId: string;
  source: "original" | "custom";
  active: boolean;
  difficultyHint?: "easy" | "medium" | "spicy";
};
```

**Starter pack (100 Fields, shipped in `src/content/fields.ts`):** a single original pack split across the three difficulty tiers, mixing domains so the Sower's invention space varies:

- **easy (34)** — universal classes with dozens of obvious members: Fruit, Vegetable, Farm Animal, Color, Pizza Topping, Dessert, Condiment, Sport, Board Game, Musical Instrument, Planet, Holiday, Tool, Vehicle, etc.
- **medium (33)** — specific instances needing some culture/geography: Athlete, Superhero, Sci-Fi Movie, Disney Movie, Video Game, Arcade Game, Country, US State, River, Dinosaur, Gemstone, Chemical Element, Cocktail, Cheese, Art Supply, etc.
- **spicy (33)** — niche, abstract, or proper-noun-heavy classes that are harder to clue fairly: Comic Book Villain, Greek God, Chess Piece, Phobia, Emotion, Cloud Type, Font, Shakespeare Play, Famous Painting, Philosopher, Space Mission, Fairy Tale, Zodiac Sign, Cryptid, etc.

**Authoring guidelines:** prefer a short singular noun class; populated enough that many Seeds fit, but tight enough to constrain the search space (a class, not a vague quality); avoid prompts that invite unsafe or exclusionary answers; tag a rough difficulty. Keep packs versioned.

**Deferred:** public user-generated packs (needs content-safety review), licensed packs, localization beyond launch language.

---

## 8. Visual & UX direction

The established style — **torn-paper / cut-paper collage, warm and earthy, handmade, friendly** — is the identity. Keep it.

- **Mascot:** the patchwork sow.
- **Surface vocabulary themed; controls plain.** Cards read CATEGORY / SECRET ANSWER; buttons read GUESS / ONE MORE LETTER; icons are PASS / SUBMIT / CORRECT / MISS.
- **Rows** are the "Hint Lines" — five stable letter slots that fill left to right, with a gentle *sprout* animation on reveal.
- **Score tokens / Ribbons** are collage chips. Note: the asset frame currently shows 5/10/25/50 (four ascending tokens). The mechanic needs **five** values that **descend** (20/10/7/5/3). Reconcile the art to the curve — earlier guesses must visibly be worth more.
- **A signature beat to build:** the recap should visualize the *garbling* — show each Row's final letters and, optionally, what each Hand actually meant versus what the next Hand thought. The funniest misfires are the keepsake.
- **Reduced-motion** variant for the sprout/confetti effects.

---

## 9. Screen flow

**Room entry** — any URL may include `?room=whatever`. If no Room is present, offer create/copy Room link and join existing Room. Room slugs are human-readable and shareable.

**Handle claim** — ask for a display handle and enter the Room immediately in-place after submit; the same loaded page updates into Room Home or Lobby. Never ask the player to refresh, reload, reopen a copied link, sign in, register, or take any other browser action to finish joining. Store the last handle locally for convenience, but allow switching. If the handle already exists in the Room, the player resumes that seat.

**Room home** — show active Season if one exists, recent Seasons in this Room, and replay/review links for finished Seasons. Starting a new Season does not erase history.

**Lobby** — room link, ordered seats, host indicator, ready states, online/offline, chosen Field pack, rules summary. Host can reorder/randomize seats. Start enabled only at 3–8 ready players.

**Field choice** — only the Farmer sees the two Field cards; everyone else sees *"The Farmer is choosing a Field."*

**Plant the Seed** — chosen Field goes public; only the Sower sees the Seed input; on lock, every Hand receives the Seed and the Farmer gets a waiting screen.

**Tend the Rows** — each Hand sees the Field, the Seed, all sprouted Rows so far, and the Row(s) they currently hold with one input each. They see *who has planted* but never others' draft letters. The app never asks for the full intended clue word.

**Farmer's call** — Field, current Ribbon value, all sprouted Rows, **Guess** and (below depth five) **One More Letter**, or (at depth five) **Spoiled**.

**Guess** — type, confirm ("submitting ends the Harvest if it isn't accepted").

**Adjudication** — exact match auto-resolves; otherwise the Sower accepts/rejects.

**Harvest recap** — Field, Seed, guess, final Rows, Ribbon, optional per-letter contributions, running County Fair total.

**County Fair (final)** — every Ribbon, the five that counted, final score out of 100, rematch, copyable summary.

**Room history** — finished Seasons remain available by Room. A review view can replay Harvests from the public event log: Field, Seed after reveal, guess, Rows, per-letter contributions where available, Ribbons, and final County Fair.

Voice/video stays external for the MVP.

---

## 10. Visibility & secrecy model

Sow's Ear is designed for cooperative casual play. The normal UI must preserve role secrecy, but v0.3 intentionally removes account auth and server-only command execution so a static GitHub Pages deployment can work. That means unresolved Seeds are **not treated as adversarial secrets** in the MVP. A determined participant who edits local state, impersonates a handle, or inspects shared client data may be able to spoil the game. This is acceptable for the first casual web version.

| Information | Farmer | Sower | Other Hands |
|---|---|---|---|
| The two offered Fields | Yes | No | No |
| Chosen Field | Yes | Yes | Yes |
| Seed before resolution | **No** | Yes | Yes |
| Another player's draft letter | No | No | No |
| Sprouted Rows | Yes | Yes | Yes |
| Farmer's unsubmitted guess | Yes | No | No |
| Non-exact guess awaiting judgment | Yes | Yes | (optional waiting) |
| Seed after resolution | Yes | Yes | Yes |

**MVP enforcement:** The app does not display the unresolved Seed to the Farmer, and normal queries/views are scoped by Room + handle + role. The host has no special Seed visibility in the UI.

**Hard-secrecy upgrade path:** If we later need adversarial protection, add one of: authenticated Instant users with per-player permissions, a small server/worker holding the Instant admin token, or private WebRTC data channels for role-specific payloads. That would change the security model but not the core rules.

---

## 11. Guess normalization

Conservative — never collapse genuinely different answers into a match:

1. Unicode NFKC. 2. Trim ends. 3. Collapse internal whitespace. 4. Locale-aware case-fold. 5. Normalize curly/straight apostrophes. 6. Normalize dash variants. 7. Keep meaningful punctuation and digits. 8. Compare exact. 9. Anything else → Sower adjudicates.

```
" The Beatles "  → "the beatles"
"SPIDER–MAN"     → "spider-man"
"Beatle"         ≠ "the beatles"   (needs adjudication)
```

---

## 12. Technical architecture (static standalone)

Static Bun-built TypeScript app deployed to **GitHub Pages**, using **InstantDB** for realtime shared state. The deploy target is a static `dist/` generated from `bun build index.html`; there is no always-on app server in the MVP and no admin token in the browser bundle.

Room and handle model:

1. **Room** — all game data is scoped by a room slug from `?room=...`.
2. **Handle** — a room-local identity string. The same handle in the same Room resumes the same seat/history. No email, password, or auth account exists.
3. **Season history** — completed games remain queryable by Room for review/replay.
4. **Local convenience** — browser local storage remembers the last Room and handle, but the URL + handle are the portable identity.

Data visibility layers:

1. **Room-public canonical state** — lobby, seats, phases, Fields, sprouted Rows, decisions, finished Season history.
2. **Room-handle views** — role-specific view records keyed by Room + Season + Harvest + handle. These support normal UI secrecy but are not hardened against handle impersonation.
3. **Post-resolution audit log** — after a Harvest resolves, Seed, guess, Rows, Ribbons, and optional per-letter contributions are retained for history/replay.

**Entity inventory (engine-internal names; player-facing in parentheses):**

`rooms`, `roomHandles`, `games (Season)`, `gamePlayers`, `categories (Fields)`, `rounds (Harvests)`, `roundHandleViews` *(role-specific, handle-scoped)*, `arrows (Rows)`, `clueEntries` *(planted letters)*, `phaseLocks`, `roundDecisions`, `gameEvents` *(idempotency/history/replay)*.

Build to the engine-internal column so the farm theme never touches the data model.

**Permissions:** Because there is no login, Instant cannot use authenticated identity to protect one handle from another. MVP permissions should allow Room participants to read/write Room-scoped data and prevent accidental global writes where possible. Do not claim database-enforced Seed secrecy in v0.3.

**Client commands (MVP):** `enterRoom`, `claimHandle`, `createSeason`, `joinSeason`, `startSeason`, `chooseField`, `plantSeed`, `plantLetters`, `trySprout`, `wait`, `guess`, `adjudicateGuess`, `spoil`, `nextHarvest`, `countyFair`, `voidHarvest`, `rematch`, `reviewSeason`.

**Concurrency & idempotency:** every state-changing command carries a client-generated `actionId` (unique-constrained → safe retries) and an `expectedPhaseVersion` (stale versions rejected). Mutually exclusive transitions use **unique lock records** (`roomSlug:gameId:roundId:phaseVersion:purpose`); only one racer can create the lock, so simultaneous Guess/Wait or duplicate Sprout attempts resolve to exactly one outcome. A disconnected Hand pauses progression rather than auto-planting.

**Optional LAN/WebRTC mode:** Keep the core engine transport-agnostic. A later experimental mode may use WebRTC data channels for direct LAN or friend-group synchronization, with Instant used only for signaling or not used at all when manual/local signaling is available. Browser LAN discovery is not assumed for MVP.

---

## 13. IP approach (full standalone)

Game mechanics and methods of play aren't protected by copyright; rulebook *text* and *art* are, and names/logos can be trademarks. Our position:

- Original title (**Sow's Ear**), original vocabulary, original collage art, original rules text (this document) — all clean-room.
- **Author our own Fields.** Never reproduce any published deck.
- Don't copy anyone's logo, board art, card design, box imagery, or typography.
- Don't present the game as an edition of, or affiliated with, any existing product.
- Run a formal trademark check on "Sow's Ear" before any public/commercial release. (No conflicting party/word game surfaced in a quick search; the name reads clear, but verify properly before a box or a store listing.)

This is general product guidance, not legal advice.

---

## 14. MVP scope

**In:** 3–8 synchronous players; no login or email; `?room=...` Room links; handle-based identity/resume; ordered lobby + ready; original starter Field pack; standard and three-player rotation; five letter-depths; Sower adjudication; Ribbons + best-five County Fair; reconnection by Room + handle; Room history and Season review/replay; host pause/transfer/void-Harvest; the collage UI; the garble-celebrating recap; accessibility (WCAG 2.2 AA target, keyboard, focus, reduced motion, no color-only signals); mobile-first responsive; static GitHub Pages deployment via Bun build.

**Deferred:** account auth; database-enforced per-player secrecy; server-authoritative command layer; integrated voice/video; WebRTC/LAN sync mode; public matchmaking; spectators; async play; user-generated/public packs; automated semantic judging; achievements/cosmetics/monetization; localization.

**Build order:**
1. Pure-TypeScript rules engine — scheduling, rotation (standard + three-player), Ribbons, County Fair, valid transitions.
2. Exhaustive unit + property tests on the engine.
3. Static Bun app shell, GitHub Pages build output, Room URL parsing, handle claim/resume.
4. InstantDB Room, lobby, seats, ready state, presence-style online indicators where available.
5. Persistent Harvest state + handle-scoped role views.
6. Client command layer + unique transition locks + stale phase rejection.
7. Three-player variant.
8. Room history, Season review/replay, reconnect + emergency host flows.
9. Collage UI, recap, accessibility, mobile polish.
10. Private friends-and-family beta with the starter pack.

---

## 15. Acceptance criteria & test matrix

**Must pass before it's considered working:**

1. A player can join `?room=whatever`, enter a handle, and appear in the Room immediately in the same loaded page. The UI must never require or suggest email/login, copied-link reopen, manual refresh, reload, or any other extra browser action to complete first-time joining.
2. No letter sprouts until every expected planting for that depth exists; all sprout atomically.
3. Standard rotation always assigns every Row to exactly one Hand; the Farmer holds zero.
4. Three-player rotation leaves both Hands holding exactly two Rows, every Row with one holder, four plantings per depth.
5. A Hand can't plant on a Row they don't hold.
6. A duplicate submission (same `actionId`) can't append a second letter.
7. Simultaneous Guess and Wait → exactly one succeeds.
8. A wrong guess atomically records 0 and resolves.
9. Correct at depths 1–5 → 20/10/7/5/3.
10. At depth five, Wait is rejected.
11. If a player later returns to the link in any phase, the app restores Room, handle, seat, role, and view. This is optional reconnect/resume behavior, never part of first-time joining.
12. A stale phase version is rejected without side effects.
13. County Fair always equals the sum of the five highest Ribbons.
14. The host gains no extra Seed visibility in normal UI flow.
15. Unicode composed/decomposed text normalizes identically.
16. Keyboard-only users can complete every role and phase.
17. Finished Seasons remain in Room history and can be reviewed/replayed.
18. A second device using the same Room + handle resumes that handle's seat.
19. The GitHub Pages build is static and contains no Instant admin token.

**Test across:** 3/4/5/8 players; every depth; correct/wrong/adjudicated/spoiled/void; both rotations; duplicate presses; two devices using the same handle; simultaneous final plantings; simultaneous Guess/Wait; reconnection in every phase; Farmer/Sower/Hand disconnects; host disconnect + transfer; Room history review; Field-pack exhaustion + reshuffle; Seeds with punctuation, digits, accents, and multiple words; best-five with ties and with fewer than five valid Harvests; rules-version migration and rematch.

Property test for the rotation engine: *for every player count and depth — Row count constant, every Row exactly one holder, Farmer holds zero, every Row gets one letter per depth, assignments repeat predictably after enough handoffs.*
