# Complete De-skinning + UX Cleanup Plan  
_excluding the already-covered letter-entry/grid simplification_

## Progress log

- Started implementation of the de-skinning plan.
- Renamed the core model vocabulary and event vocabulary to generic game/round/category/answer/points/reveal terms.
- Renamed `src/content/fields.ts` and its test file to `src/content/categories.ts` / `src/content/categories.test.ts`.
- Updated rule/config constants to generic category and final-score naming, with no migration compatibility layer.
- Kept app state centralized in the Zustand store; follow-up UI changes should continue selecting actions/state from `useGameStore` rather than adding standalone local persistence.
- TypeScript currently passes after the first model/config/content cleanup pass.
- Renamed the React store/component surface to `useGameStore` / `GameState` / `GameRuntime` / `CowslipApp`.
- Replaced visible gameplay copy with generic terms: guesser, answer writer, clue giver, game, round, category, answer, points, reveal, submit.
- Added store-backed confirmation states for pass round and void round, with focus moving to the confirmation buttons.
- Changed focus styling to an outline/offset treatment so focused controls do not grow or look uneven.
- Collapsed host controls behind a `Host Options` disclosure while retaining recover/transfer/pause/resume/void behavior.
- Added lobby role preview, clearer per-role instruction lines, point-stake copy, generic help text, and generic room/history/review language.
- Renamed local persistence/channel prefixes to `cowslip:*`.
- Added browser smoke coverage that fails if active gameplay UI shows old themed terms.
- Verified with `bun run typecheck && bun test && bun run build` on this pass: 68 tests passed, 0 failed.

## Goal

Do a clean sweep from themed/farm-specific language to a generic cooperative word-game model.

This should apply to:

- UI copy
- React component names
- store action names
- model fields
- event names
- tests
- CSS/test IDs where reasonable
- rules/help text
- content naming

Since backward compatibility is not required, we can rename persisted event types, model fields, and phase names directly.

---

# 1. Canonical generic vocabulary

## Roles

Use these everywhere:

| Concept | UI label | Code name |
|---|---|---|
| Player who guesses | Guesser | `guesser` |
| Player who writes the answer | Answer writer | `answerWriter` |
| Players who submit letters | Clue giver | `clueGiver` |

Avoid:

- Farmer
- Sower
- Hand
- Picker
- Cluer

“Picker” and “cluer” are understandable to developers but less clear to players. “Answer writer” and “clue giver” describe the actual job.

---

## Game concepts

| Current / themed | Generic | Code name |
|---|---|---|
| Season | Game | `game` |
| Harvest | Round | `round` |
| Field | Category | `category` |
| Seed | Answer | `answer` |
| Row | Row | `row` |
| Ribbon | Points | `points` |
| County Fair | Final score | `finalScore` |
| Sprout | Reveal | `reveal` |
| Plant | Submit | `submit` |

---

## Main actions

| Current | Generic UI | Code name |
|---|---|---|
| Choose field | Choose category | `chooseCategory` |
| Plant seed | Submit answer | `submitAnswer` |
| Plant letters | Submit letters | `submitLetters` |
| Rows sprouted | Letters revealed | `revealLetters` |
| Farmer waited | Reveal one more letter | `requestMoreLetters` |
| Guess adjudicated | Judge guess | `judgeGuess` |
| Harvest spoiled | Pass round | `passRound` |
| Void harvest | Void round | `voidRound` |
| Next harvest | Next round | `startNextRound` |

---

# 2. Rename model types and fields

## `GamePhase`

Replace themed/mixed phase names.

Current:

```ts
export type GamePhase =
  | "lobby"
  | "field-choice"
  | "seed"
  | "planting"
  | "farmer-call"
  | "adjudication"
  | "harvest-recap"
  | "final";
```

New:

```ts
export type GamePhase =
  | "lobby"
  | "category-choice"
  | "answer-entry"
  | "letter-entry"
  | "guesser-call"
  | "guess-judging"
  | "round-recap"
  | "final";
```

Rationale:

- `category-choice` says exactly what happens.
- `answer-entry` is clearer than `seed`.
- `letter-entry` is clearer than `planting`.
- `guesser-call` is acceptable because it is the guesser’s decision point.
- `guess-judging` is clearer than `adjudication`.
- `round-recap` is generic.

---

## `Round`

Current fields to rename:

```ts
farmerHandle
sowerHandle
fieldOptions
fieldId
fieldLabel
seedRaw
seedNorm
ribbon
```

New:

```ts
guesserHandle
answerWriterHandle
categoryOptions
categoryId
categoryLabel
answerRaw
answerNorm
points
```

Recommended clean `Round` type:

```ts
export type Round = {
  id: string;
  roundNumber: number;
  phase: GamePhase;
  status: RoundStatus;

  guesserHandle: string;
  answerWriterHandle: string;

  categoryOptions: string[];
  categoryId?: string;
  categoryLabel?: string;

  depth: number;
  phaseVersion: number;

  answerRaw?: string;
  answerNorm?: string;

  guessRaw?: string;
  guessNorm?: string;
  accepted?: boolean;
  points?: number;

  rows: Row[];
  entries: ClueEntry[];

  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
};
```

---

## `Game`

Current:

```ts
totalHarvests
ribbons
```

New:

```ts
totalRounds
roundPoints
```

Recommended:

```ts
export type Game = {
  id: string;
  roomSlug: string;
  status: GameStatus;
  phase: GamePhase;

  hostHandle: string;
  players: GamePlayer[];

  rounds: Round[];
  currentRoundId?: string;
  currentRoundNumber: number;
  totalRounds: number;

  phaseVersion: number;
  playerCount: number;

  categoryPackId: string;
  rulesVersion: string;
  roundPoints: number[];

  pausedAt?: number;

  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};
```

---

## `ClueEntry`

Current:

```ts
sprouted: boolean;
```

New:

```ts
revealed: boolean;
```

Clean type:

```ts
export type ClueEntry = {
  rowIndex: number;
  depth: number;
  handle: string;
  letter: string;
  skipped: boolean;
  endsWord: boolean;
  revealed: boolean;
  filledAtDepth?: number;
  createdAt: number;
};
```

---

## `Field`

Rename this type entirely.

Current:

```ts
export type Field = { ... }
```

New:

```ts
export type Category = {
  id: string;
  label: string;
  locale: "en-US";
  packId: string;
  source: "original" | "custom";
  active: boolean;
  difficultyHint?: DifficultyHint;
};
```

---

# 3. Rename events

Since we do not need backward compatibility, rename event types directly.

Current:

```ts
"field.chosen"
"seed.planted"
"letters.planted"
"rows.sprouted"
"farmer.waited"
"guess.adjudicated"
"harvest.spoiled"
"next-harvest.started"
"harvest.voided"
```

New:

```ts
"category.chosen"
"answer.submitted"
"letters.submitted"
"letters.revealed"
"more-letters.requested"
"guess.judged"
"round.passed"
"next-round.started"
"round.voided"
```

Full suggested event union:

```ts
export type GameEventType =
  | "handle.claimed"
  | "handle.seen"
  | "game.created"
  | "player.joined"
  | "player.ready-set"
  | "seats.reordered"
  | "game.started"
  | "category.chosen"
  | "answer.submitted"
  | "letters.submitted"
  | "letters.revealed"
  | "more-letters.requested"
  | "guess.submitted"
  | "guess.judged"
  | "round.passed"
  | "next-round.started"
  | "game.completed"
  | "round.voided"
  | "game.paused"
  | "game.resumed"
  | "host.transferred";
```

Also rename:

```ts
SowsEarEvent
```

to something generic, e.g.

```ts
GameEvent
```

or

```ts
WordGameEvent
```

I would use `GameEvent` unless there is risk of confusion with DOM game events.

---

# 4. Rename commands

Clean sweep command names:

| Current | New |
|---|---|
| `commandChooseField` | `commandChooseCategory` |
| `commandPlantSeed` | `commandSubmitAnswer` |
| `commandPlantLetters` | `commandSubmitLetters` |
| `commandTrySprout` | `commandTryRevealLetters` |
| `commandWait` | `commandRequestMoreLetters` |
| `commandSpoil` | `commandPassRound` |
| `commandAdjudicate` | `commandJudgeGuess` |
| `commandAdvanceAfterRecap` | `commandAdvanceAfterRecap` or `commandAdvanceRound` |
| `commandVoidHarvest` | `commandVoidRound` |
| `commandStartSeason` | `commandStartGame` |
| `commandCreateSeason` | `commandCreateGame` |
| `commandPauseSeason` | `commandPauseGame` |
| `commandResumeSeason` | `commandResumeGame` |

I would choose:

```ts
commandCreateGame
commandStartGame
commandChooseCategory
commandSubmitAnswer
commandSubmitLetters
commandTryRevealLetters
commandRequestMoreLetters
commandSubmitGuess
commandJudgeGuess
commandPassRound
commandAdvanceRound
commandCompleteGame
commandVoidRound
commandPauseGame
commandResumeGame
```

---

# 5. Rename store actions

Current store actions:

```ts
createSeason()
startSeason()
chooseField()
plantSeed()
plantLetters()
wait()
spoil()
adjudicate()
advance()
voidHarvest()
pauseSeason()
resumeSeason()
```

New:

```ts
createGame()
startGame()
chooseCategory()
submitAnswer()
submitLetters()
requestMoreLetters()
passRound()
judgeGuess()
advanceRound()
voidRound()
pauseGame()
resumeGame()
```

Also rename runtime/state keys if they encode old concepts:

```ts
pendingSprouts
```

to:

```ts
pendingReveals
```

And:

```ts
ensureRowsSprouted()
```

to:

```ts
ensureLettersRevealed()
```

---

# 6. Rename functions in model layer

Current helper names to update:

| Current | New |
|---|---|
| `roleForHandle` | keep, but return generic roles |
| `rowEndedBeforeDepth` | keep |
| `rowIsComplete` | keep |
| `activeRowsForDepth` | keep |
| `rowsHeldForClue` | `rowsHeldForLetterEntry` or `rowsHeldByClueGiver` |
| `trailingBlankEntriesForRow` | keep |
| `fieldLabel` | `categoryLabel` |
| `pickFieldOptions` | `pickCategoryOptions` |
| `pointsForDepth` | keep |
| `finalScoreFromPoints` | keep |

`roleForHandle` should return:

```ts
"guesser" | "answerWriter" | "clueGiver" | "none"
```

instead of:

```ts
"guesser" | "picker" | "cluer" | "none"
```

---

# 7. Rename files

Suggested file renames:

```text
src/content/fields.ts        -> src/content/categories.ts
src/content/fields.test.ts   -> src/content/categories.test.ts
```

Maybe later:

```text
sows-ear-design-briefing.md  -> design-briefing.md
```

Asset files with old branding can either be removed or replaced as part of visual de-skinning.

If keeping the app name out of scope, at least avoid themed gameplay terms in code and UI.

---

# 8. Update visible UI copy

## Global terms

Replace visible text:

| Old | New |
|---|---|
| Season | Game |
| Harvest | Round |
| Field | Category |
| Seed | Answer |
| Plant | Submit |
| Sprout | Reveal |
| Ribbon | Points |
| County Fair | Final Score |
| Farmer | Guesser |
| Sower | Answer writer |
| Hand | Clue giver |

---

## Role card

Current role display should become:

```text
Role
Guesser
```

```text
Role
Answer writer
```

```text
Role
Clue giver
```

For observers:

```text
Observer
```

---

## Category choice

Use:

```text
Choose a category
```

Instruction:

```text
You are the guesser. Choose the category for this round.
```

Waiting copy:

```text
The guesser is choosing a category.
```

Avoid:

```text
Pick the search space
```

That is developer/product language, not player language.

---

## Answer entry

Use:

```text
Enter the answer
```

Instruction:

```text
You are the answer writer. Choose a word or short phrase that fits the category.
```

Button:

```text
Submit Answer
```

Waiting copy:

```text
The answer writer is choosing the answer.
```

For the guesser:

```text
The answer writer is choosing the answer. You will not see it.
```

---

## Guesser decision

Use:

```text
Make a guess or reveal one more letter.
```

Buttons:

```text
Guess
Reveal One More Letter
Pass
```

At depth five:

```text
Final letter reached. Guess or pass.
```

---

## Guess confirmation

Replace current confirmation copy with:

```text
Final guess. If it is wrong, this round scores 0.
```

Button:

```text
Submit Final Guess
```

---

## Guess judging

Use:

```text
Judge the guess
```

Fields:

```text
Answer
Guess
```

Buttons:

```text
Accept
Reject
```

Rationale: this is not always strictly “correct/miss”; the answer writer may accept variants, plurals, spelling differences, abbreviations, etc.

---

## Recap and final

Use:

```text
Round Recap
Answer
Guess
Points
Final Score
Game Review
New Game
```

Avoid all themed endgame language.

---

# 9. Add phase-specific instruction lines

Every active phase should have one direct “what now?” line.

## Category choice

For guesser:

```text
You are the guesser. Choose a category.
```

For others:

```text
Waiting for the guesser to choose a category.
```

---

## Answer entry

For answer writer:

```text
You are the answer writer. Enter the secret answer.
```

For guesser:

```text
Waiting for the answer writer. You will not see the answer.
```

For clue givers:

```text
Waiting for the answer writer to submit the answer.
```

---

## Letter entry

Generic instruction only; details already covered in separate report.

Key phrase:

```text
Letters reveal when all clue givers have submitted.
```

---

## Guesser call

For guesser:

```text
You are the guesser. Make a guess or reveal one more letter.
```

For others:

```text
Waiting for the guesser to decide.
```

---

## Guess judging

For answer writer:

```text
You are the answer writer. Decide whether the guess should count.
```

For guesser:

```text
Waiting for the answer writer to judge your guess.
```

For others:

```text
Waiting for the answer writer to judge the guess.
```

---

# 10. Clarify hidden information

The game has role-specific visibility. Make it explicit.

## For guesser

During answer entry:

```text
You will not see the answer.
```

During letter entry:

```text
You cannot see the answer or unrevealed letters.
```

## For clue givers

When answer is visible:

```text
The guesser cannot see the answer.
```

## During submitted/unrevealed state

Use generic explanation:

```text
Other players will see submitted letters when all letters reveal.
```

This helps players understand privacy and synchronization without thematic language.

---

# 11. Clarify that the answer writer also gives clues

This is a common point of confusion.

When the answer writer enters the letter-entry phase, show:

```text
You are also a clue giver this round.
```

Then:

```text
Add one letter to each row you hold.
```

This matters because after submitting the answer, the answer writer may assume their job is done.

---

# 12. Make scoring stakes obvious

The point ladder exists, but the core decision should be directly visible at the guesser decision point.

At depth 1:

```text
Guess now for 20 points.
Reveal one more letter and the value drops to 10.
```

Depth 2:

```text
Guess now for 10 points.
Reveal one more letter and the value drops to 7.
```

Depth 3:

```text
Guess now for 7 points.
Reveal one more letter and the value drops to 5.
```

Depth 4:

```text
Guess now for 5 points.
Reveal one more letter and the value drops to 3.
```

Depth 5:

```text
Final letter reached. Guess for 3 points or pass.
```

This reinforces the strategic tension without relying on a separate score rail.

---

# 13. Add confirmation for round-ending actions

## Final guess

Already uses a two-step flow. Improve the language:

```text
Final guess. If it is wrong, this round scores 0.
```

## Pass

Add confirmation:

First click:

```text
Pass
```

Confirmation state:

```text
Pass and score 0 for this round?
```

Button:

```text
Confirm Pass
```

## Void round

Host-only destructive action should require confirmation:

```text
Void this round? This cannot be undone.
```

Button:

```text
Void Round
```

---

# 14. Improve row handoff clarity

Do this outside the already-covered grid mechanics.

After the guesser requests more letters, players should understand that rows moved.

Add a simple message at top of letter entry:

```text
Rows have been passed. Continue the rows you received.
```

For a held row, show metadata where space allows:

```text
Started by Bob · now yours
```

For another player’s row:

```text
Cora has this row
```

This helps players understand the “telephone” mechanic.

---

# 15. Improve recap payoff

The recap should show how rows were built, not only final letters.

Add per-letter attribution:

```text
Row 1: H A Y
       Bob · Cora · Drew
```

or:

```text
Row 1
H by Bob · A by Cora · Y by Drew
```

This uses existing entry data and makes the collaborative/miscommunication mechanic visible.

If blanks are present:

```text
Row 2: _ A T
       Bob · Cora · Drew
```

If a row was completed:

```text
Row 3: C A T.
       Alice · Bob · Cora
```

This should appear in:

- round recap
- game review
- replay

---

# 16. Improve terminology around blanks and completed rows

Rename controls:

| Current | New |
|---|---|
| Add Blank | Leave Blank |
| Use Letters | Use Letter |
| End word | End Row |
| word end | row complete |

Add small helper text:

```text
Leave Blank skips this cell.
```

For ending a row:

```text
End Row marks this clue as complete.
```

Keyboard shortcut can stay, but make it discoverable:

```text
Tip: press . to end the row.
```

---

# 17. Improve offline waiting states

The model already tracks presence. Make the state actionable.

Use row or panel copy:

```text
Waiting on Cora, who appears offline.
```

For host:

```text
You can wait, pause the game, or void the round from Host options.
```

Do not auto-skip or auto-fill. The game should pause socially rather than silently changing gameplay.

---

# 18. De-emphasize host controls during active play

Host controls are useful but too prominent for normal players’ attention.

During active rounds, collapse them behind:

```text
Host options
```

Expanded:

```text
Pause Game
Void Round
Transfer Host
```

For dangerous actions:

- use secondary/danger styling,
- require confirmation,
- keep them out of the primary action path.

---

# 19. Lobby improvements

## Explain seat order

Seat order affects role rotation and row handoff. The lobby should say so.

Add:

```text
Seat order controls role rotation and row handoff.
```

## Preview first round roles

Show:

```text
First round
Guesser: Alice
Answer writer: Bob
Clue givers: Bob, Cora, Drew
```

For three players:

```text
With three players, each clue giver gets two rows.
```

This helps the host understand why they might reorder seats.

---

# 20. Simplify ready/join behavior

The current code appears to auto-ready players when joining. If keeping that behavior, avoid emphasizing readiness too much.

Use:

```text
Players in this game
```

instead of:

```text
Ready players
```

If explicit ready is desired later, make it a deliberate UX choice. For now, casual auto-ready is fine, but the language should match the behavior.

---

# 21. Reduce active-game history clutter

Room history is useful but should not compete with active play.

Recommendation:

- show history on room home,
- show review after final score,
- hide or minimize history during active rounds.

If accessible during active play, put it behind a small secondary link:

```text
Game history
```

not a full panel.

---

# 22. Mobile input polish

Letter entry is central, but these input improvements apply generally.

For one-letter inputs:

```tsx
autoComplete="off"
autoCorrect="off"
autoCapitalize="characters"
spellCheck={false}
inputMode="text"
maxLength={1}
```

Also ensure:

- large tap targets,
- clear focus state,
- submit button is reachable without excessive scrolling,
- keyboard focus moves predictably,
- layout does not jump after other players submit.

---

# 23. Error placement

Global errors are not enough for form/row-specific mistakes.

Show validation errors near the relevant form section.

Examples:

```text
Add one letter to each row you hold.
```

```text
Fill the blank before adding the next letter.
```

```text
A blank cannot end a row.
```

```text
This row is already complete.
```

Keep a global error area for room/game-level errors, but use local inline errors for player corrections.

---

# 24. Accessibility improvements

## Focus management

Current app has auto-focus helpers. Continue, but ensure focus moves to the next meaningful task:

- after category chosen, answer writer gets answer input,
- after answer submitted, clue giver gets first letter input,
- after letters reveal, guesser gets guess input or primary decision,
- after non-exact guess, answer writer gets Accept/Reject.

## Button names

Ensure icon-only buttons have descriptive labels:

```text
Copy room link
Switch handle
Room switcher
```

## Color independence

Submitted/waiting/complete/offline states should not rely on color alone. They need text labels.

## Reduced motion

Reveal animations should honor reduced-motion preferences.

---

# 25. Test plan

## Unit tests

Update all model tests to generic names and events.

Core test names should use generic terms:

- “only the guesser can choose a category”
- “only the answer writer can submit an answer”
- “letters reveal after every active row has a submission”
- “requesting more letters advances depth”
- “pass round scores zero”
- “judge guess accepts non-exact answer”
- “final score uses top five round scores”

---

## Browser tests

Add/adjust CDP tests for:

### Generic language smoke test

For a new game, assert the UI does not contain banned terms:

```text
Farmer
Sower
Hand
Harvest
Season
Field
Seed
Plant
Sprout
Ribbon
County Fair
```

Caveat: if app title/branding remains themed temporarily, scope this test to gameplay panels.

### Role instruction test

Each role sees a clear instruction line:

```text
You are the guesser
You are the answer writer
You are a clue giver
```

### Scoring stakes test

At guesser call:

```text
Guess now for 20 points
```

After more letters:

```text
Guess now for 10 points
```

### Judge guess test

Non-exact guess shows:

```text
Judge the guess
Accept
Reject
```

### Pass confirmation test

Clicking Pass asks for confirmation before resolving the round.

### Recap attribution test

Round recap shows letters and contributor handles.

---

# 26. Suggested implementation order

## Step 1: Global rename types/events/phases

Because no backward compatibility is needed, do the core model rename first.

- `GamePhase`
- `Round` fields
- `Game` fields
- `ClueEntry.revealed`
- event union
- reducer cases
- command names

Run typecheck and tests after each logical chunk.

---

## Step 2: Content/category rename

- `Field` → `Category`
- `fields.ts` → `categories.ts`
- `STARTER_FIELDS` → `STARTER_CATEGORIES`
- `fieldLabel` → `categoryLabel`
- `pickFieldOptions` → `pickCategoryOptions`
- config `fieldPackId` → `categoryPackId`

---

## Step 3: Store and component rename

- store action names
- component names
- test IDs where worthwhile
- CSS classes where they expose themed concepts

---

## Step 4: UI copy pass

Replace visible language with generic terms.

Update:

- phase headings
- buttons
- help/rules dialog
- lobby
- role card
- recap/final/review
- errors
- empty/waiting states

---

## Step 5: UX clarity additions

Add:

- phase instruction lines,
- hidden-information copy,
- answer-writer-is-also-clue-giver copy,
- scoring stakes copy,
- pass/void confirmation,
- handoff copy,
- offline copy,
- lobby role preview.

---

## Step 6: Recap/review improvements

Add:

- per-letter attribution,
- generic points language,
- clearer final score display.

---

## Step 7: Host/admin and history cleanup

- collapse host controls,
- hide/minimize active-game history,
- clean lobby ready/player language.

---

## Step 8: Tests

Update all unit and browser tests to generic language.

Add smoke tests to prevent themed terms from returning.

---

# 27. Definition of done

The cleanup is complete when:

1. New-game UI uses only generic terminology.
2. Code model uses generic names for roles, answer/category, reveal, points, and rounds.
3. Event names are generic.
4. Tests use generic language.
5. Help/rules text contains no farm-specific gameplay terminology.
6. The guesser always sees clear point stakes.
7. Every phase has a direct instruction line.
8. The answer writer’s dual role as clue giver is clear.
9. Round-ending actions have safe confirmation.
10. Recap shows how rows were built and who contributed each letter.
11. A test prevents reintroduction of banned themed terms in gameplay UI.
