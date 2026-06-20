# Targeted InstantDB + State Management Recommendations

## Summary

## Progress log

- Chose the event-sourced model as the canonical game architecture: commands append immutable game events, clients reduce events into current UI state, and support tables are indexes/current-state only.
- Simplified `instant.schema.ts` to the active data model: `gameEvents`, `roomSummaries`, and `roomPresence`.
- Removed stale normalized InstantDB gameplay entities that duplicated derived state and still carried old themed terminology.
- Tightened `instant.perms.ts` so `gameEvents` are append-only while `roomSummaries` and `roomPresence` remain mutable public room state for this no-auth casual app.
- Kept categories static in bundled code rather than retaining an unused InstantDB `categories` table.
- Moved presence heartbeats out of the permanent event log by adding `subscribePresence` and `markSeen` to the event-store abstraction.
- Removed `handle.seen` from the event type, reducer, command layer, and tests; `handle.claimed` remains replayable room history.
- Updated the app store/runtime to track `presence` separately from reduced game state and to derive online/offline UI from `roomPresence`.
- Updated local transport to store and broadcast room presence separately from `cowslip:events:*`.
- Updated Instant transport to upsert `roomPresence` and maintain `roomSummaries` after event appends; summary/presence writes are best-effort so deployed apps with an older schema can still append canonical game events.
- Verified with `bun run typecheck && bun test && bun run build`: 68 tests passed, 0 failed, and the production build completed.

The app currently has two competing persistence designs:

1. **Actual current implementation:** event-sourced via `gameEvents`.
2. **Unused / planned normalized schema:** `rooms`, `games`, `rounds`, `arrows`, `clueEntries`, `roundHandleViews`, etc.

Right now, the UI effectively uses only:

```ts
gameEvents
```

through `InstantEventStore`.

Most of `instant.schema.ts` is not used by the current app path. That makes the architecture harder to reason about and can mislead future work.

My recommendation: **choose one primary persistence model.**

For this app, I would keep the event-sourced model, but clean it up and add a small amount of normalized “index/current state” data where it solves real problems.

---

# 1. Keep event sourcing as the canonical game model

The pure reducer/command model is a good fit for this game.

Keep this architecture:

```text
command -> event(s) -> append to InstantDB -> all clients reduce events -> UI state
```

Benefits:

- easy to test,
- easy to replay games,
- good for room history,
- robust against duplicate events via `actionId`,
- keeps game logic centralized in TypeScript reducer/commands.

Do **not** split active game state across many mutable InstantDB tables unless there is a strong reason. That would duplicate logic and increase consistency risk.

---

# 2. Clean up unused InstantDB schema

## Current unused or mostly unused entities

Based on the current app code path, these are defined but not used by `InstantEventStore` or the UI as canonical reads/writes:

```ts
rooms
roomHandles
games
gamePlayers
rounds
roundHandleViews
arrows
clueEntries
phaseLocks
roundDecisions
```

The app currently subscribes only to:

```ts
gameEvents
```

and categories are local code content, not actively queried from InstantDB.

So the schema is misleading. It suggests a normalized DB-backed model that the app does not actually use.

---

## Recommendation

Remove unused normalized gameplay entities unless you are about to implement them.

Keep the Instant schema minimal:

```ts
entities: {
  gameEvents,
  roomSummaries,
  roomPresence,
}
```

Potentially:

```ts
categories
```

only if categories are truly managed in InstantDB. If categories ship statically in the bundle, remove `categories` from Instant too.

---

# 3. Proposed simplified Instant schema

## A. `gameEvents`

This remains the canonical event log.

After de-skinning, rename fields/types generically.

```ts
gameEvents: i.entity({
  roomSlug: i.string().indexed(),
  gameId: i.string().indexed(),
  roundId: i.string().indexed().optional(),
  actionId: i.string().unique().indexed(),
  actorHandle: i.string().indexed(),
  type: i.string().indexed(),
  payload: i.json().optional(),
  createdAt: i.date(),
})
```

Keep.

---

## B. `roomSummaries`

Add a lightweight current-room index.

Purpose:

- know active game without replaying the entire room,
- support room home,
- support active-game-only event queries later,
- avoid loading all room history for normal active play.

```ts
roomSummaries: i.entity({
  roomSlug: i.string().unique().indexed(),
  activeGameId: i.string().indexed().optional(),
  lastEventAt: i.date(),
  createdAt: i.date(),
  updatedAt: i.date(),
})
```

This is not canonical game state. It is an index/cache.

Update it whenever appending events that create/start/complete games.

---

## C. `roomPresence`

Move heartbeats out of `gameEvents`.

Current `handle.seen` events create permanent log noise. Presence should be mutable current state, not historical game history.

```ts
roomPresence: i.entity({
  presenceKey: i.string().unique().indexed(), // `${roomSlug}:${normalizedHandle}`
  roomSlug: i.string().indexed(),
  handle: i.string().indexed(),
  normalizedHandle: i.string().indexed(),
  displayName: i.string(),
  lastSeenAt: i.date(),
  createdAt: i.date(),
  updatedAt: i.date(),
})
```

Replace repeated `handle.seen` events with upserts/updates to `roomPresence`.

Keep `handle.claimed` as an event only if you want handle claims to be part of replayable room history. Otherwise it can also be current-state only.

My recommendation:

- `handle.claimed`: current-state in `roomPresence` or `roomHandles`
- `handle.seen`: current-state only
- gameplay decisions: event log

---

# 4. Recommended cleanup of current schema

## Remove these if staying event-sourced

```ts
rooms
games
gamePlayers
rounds
roundHandleViews
arrows
clueEntries
phaseLocks
roundDecisions
```

Why:

- They are not currently used.
- They duplicate state derivable from events.
- They contain old themed names: `farmerHandle`, `sowerHandle`, `fieldId`, `seedRaw`, `ribbon`, `arrows`, `sprouted`.
- Keeping them makes de-skinning harder.
- Future developers may incorrectly start writing partial state there.

---

## Remove or rename `categories`

If categories are static in `src/content/fields.ts`, remove Instant `categories`.

If you want categories in the database, then rename and use it deliberately:

```ts
categories
```

with generic names:

```ts
slug
label
locale
packId
source
active
difficultyHint
```

But do not keep both static categories and unused DB categories unless there is a clear plan.

For now, I’d keep categories static and remove Instant `categories`.

---

# 5. Event query recommendations

## Current query

```ts
where: { roomSlug }
```

This loads all historical events for the room.

Fine for small rooms, but not ideal long-term.

---

## Recommended near-term query

Keep it for now if rooms are small, but remove presence events first. That alone will help a lot.

```ts
where: { roomSlug }
```

This preserves room history and keeps implementation simple.

---

## Recommended next step

Use `roomSummaries.activeGameId`.

Normal active play subscribes to:

```ts
gameEvents where roomSlug == X and gameId in ["room", activeGameId]
```

Instant query support may affect exact syntax, but conceptually:

- room-level events: `gameId: "room"`
- active game events: `gameId: activeGameId`

Historical review loads selected game events on demand:

```ts
gameEvents where roomSlug == X and gameId == selectedGameId
```

This changes the load model from:

```text
load all room history every time
```

to:

```text
load active room/game state now; load history only when reviewing
```

---

# 6. Split event types into room-level and game-level

To support narrower queries, classify events.

## Room-level events

Use `gameId: "room"`:

```ts
handle.claimed
player.presence-updated // or no event; use roomPresence
game.created
host.transferred? // if cross-game host concept exists
```

But ideally presence is not an event.

## Game-level events

Use real `gameId`:

```ts
player.joined
player.ready-set
seats.reordered
game.started
category.chosen
answer.submitted
letters.submitted
letters.revealed
more-letters.requested
guess.submitted
guess.judged
round.passed
next-round.started
game.completed
round.voided
game.paused
game.resumed
```

This lets the app query only the active game.

---

# 7. Permissions recommendations

Current permissions are very open:

```ts
view: "true"
create: "true"
update: "true"
delete: "false"
```

That matches casual no-auth play, but still tighten what you can.

## Recommended

### `gameEvents`

Append-only:

```ts
view: "true"
create: "true"
update: "false"
delete: "false"
```

Currently update is allowed. That is risky because event logs should be immutable.

Set:

```ts
update: "false"
```

### `roomPresence`

Mutable:

```ts
view: "true"
create: "true"
update: "true"
delete: "false"
```

Presence is allowed to update.

### `roomSummaries`

Mutable:

```ts
view: "true"
create: "true"
update: "true"
delete: "false"
```

This is a cache/index, so updates are okay.

### categories, if retained

```ts
view: "true"
create: "false"
update: "false"
delete: "false"
```

---

# 8. Idempotency and uniqueness

Keep `actionId` unique.

Current schema:

```ts
actionId: i.string().unique().indexed()
```

Good.

For room summaries and presence, use unique keys:

```ts
roomSlug: unique
presenceKey: unique
```

For game events, consider adding a sortable timestamp and maybe a sequence later, but `createdAt + actionId` is acceptable for now.

---

# 9. Rename InstantDB schema as part of de-skinning

If doing a clean sweep, the Instant schema should not preserve old terms.

Remove or rename:

| Old | New |
|---|---|
| `totalHarvests` | `totalRounds` |
| `fieldPackId` | `categoryPackId` |
| `ribbons` | `roundPoints` |
| `farmerHandle` | `guesserHandle` |
| `sowerHandle` | `answerWriterHandle` |
| `fieldId` | `categoryId` |
| `fieldLabel` | `categoryLabel` |
| `publicSeedRaw` | `publicAnswerRaw` or avoid |
| `ribbon` | `points` |
| `arrows` | `rows` |
| `sprouted` | `revealed` |

But if we remove unused normalized tables, most of these go away automatically.

That is another reason to clean the schema first.

---

# 10. Recommended new `instant.schema.ts`

A minimal event-sourced schema could look like this:

```ts
import { i } from "@instantdb/core";

const _schema = i.schema({
  entities: {
    roomSummaries: i.entity({
      roomSlug: i.string().unique().indexed(),
      activeGameId: i.string().indexed().optional(),
      lastEventAt: i.date(),
      createdAt: i.date(),
      updatedAt: i.date(),
    }),

    roomPresence: i.entity({
      presenceKey: i.string().unique().indexed(),
      roomSlug: i.string().indexed(),
      handle: i.string().indexed(),
      normalizedHandle: i.string().indexed(),
      displayName: i.string(),
      lastSeenAt: i.date(),
      createdAt: i.date(),
      updatedAt: i.date(),
    }),

    gameEvents: i.entity({
      roomSlug: i.string().indexed(),
      gameId: i.string().indexed(),
      roundId: i.string().indexed().optional(),
      actionId: i.string().unique().indexed(),
      actorHandle: i.string().indexed(),
      type: i.string().indexed(),
      payload: i.json().optional(),
      createdAt: i.date(),
    }),
  },
});

type _AppSchema = typeof _schema;
export interface AppSchema extends _AppSchema {}

const schema: AppSchema = _schema;
export default schema;
```

Optional, if categories move to DB:

```ts
categories: i.entity({
  slug: i.string().unique().indexed(),
  label: i.string(),
  locale: i.string().indexed(),
  packId: i.string().indexed(),
  source: i.string().indexed(),
  active: i.boolean().indexed(),
  difficultyHint: i.string().indexed().optional(),
})
```

---

# 11. Recommended new `instant.perms.ts`

```ts
const rules = {
  attrs: {
    allow: {
      create: "false",
    },
  },

  $default: {
    allow: {
      $default: "false",
    },
  },

  roomSummaries: {
    allow: {
      view: "true",
      create: "true",
      update: "true",
      delete: "false",
    },
  },

  roomPresence: {
    allow: {
      view: "true",
      create: "true",
      update: "true",
      delete: "false",
    },
  },

  gameEvents: {
    allow: {
      view: "true",
      create: "true",
      update: "false",
      delete: "false",
    },
  },

  // Only if categories are stored in InstantDB:
  categories: {
    allow: {
      view: "true",
      create: "false",
      update: "false",
      delete: "false",
    },
  },
};

export default rules;
```

---

# 12. Event store changes

## Current

`InstantEventStore` does two things:

- subscribe to all room events,
- append events.

It does not handle presence separately.

---

## Recommended interface split

Instead of one `EventStore`, use:

```ts
type GameEventStore = {
  subscribeRoomEvents(roomSlug: string, callback: (events: GameEvent[]) => void): () => void;
  subscribeGameEvents(roomSlug: string, gameId: string, callback: (events: GameEvent[]) => void): () => void;
  appendEvents(events: GameEvent[]): Promise<void>;
};

type PresenceStore = {
  subscribePresence(roomSlug: string, callback: (presence: RoomPresence[]) => void): () => void;
  markSeen(roomSlug: string, handle: string): Promise<void>;
};
```

For a first cleanup, you can keep a single class but separate methods.

---

# 13. Presence cleanup

## Current

Presence heartbeat creates events:

```ts
handle.seen
```

This pollutes permanent game history.

## Recommended

Replace:

```ts
commandMarkHandleSeen(...)
eventStore.append(handle.seen)
```

with:

```ts
presenceStore.markSeen(roomSlug, handle)
```

Instant writes/upserts:

```ts
roomPresence[presenceKey].update({
  roomSlug,
  handle,
  normalizedHandle,
  displayName,
  lastSeenAt,
  updatedAt,
})
```

The reducer should stop deriving presence from events.

Instead, UI gets presence directly from `roomPresence`.

---

# 14. Room history strategy

If you still want room history, do not rely on loading every room event by default.

Use `roomSummaries` plus either:

## Option A: event-based history on demand

Room home queries game lifecycle events:

```ts
game.created
game.completed
```

or all events grouped by game only when opening review.

## Option B: add `gameSummaries`

This may be better than full normalized game state.

```ts
gameSummaries: i.entity({
  gameId: i.string().unique().indexed(),
  roomSlug: i.string().indexed(),
  status: i.string().indexed(),
  startedAt: i.date(),
  completedAt: i.date().optional(),
  finalScore: i.number().optional(),
  roundCount: i.number(),
  updatedAt: i.date(),
})
```

This is a summary/index, not canonical state.

Then room history loads:

```ts
gameSummaries where roomSlug == X
```

Review loads:

```ts
gameEvents where gameId == selectedGameId
```

This is cleaner long-term.

If keeping the schema minimal, skip this until history performance becomes a problem.

---

# 15. Concrete next steps

## Step 1: Decide event-sourced canonical model

Document:

```text
InstantDB stores canonical game events.
Current UI state is derived client-side by reducing events.
InstantDB summaries/presence are indexes, not canonical game state.
```

This should go in README or architecture notes.

---

## Step 2: Delete unused schema entities

Remove from `instant.schema.ts`:

```ts
rooms
roomHandles
games
gamePlayers
rounds
roundHandleViews
arrows
clueEntries
phaseLocks
roundDecisions
```

Keep:

```ts
gameEvents
```

Add:

```ts
roomSummaries
roomPresence
```

Possibly:

```ts
gameSummaries
```

if you want efficient room history.

---

## Step 3: Tighten perms

Change `gameEvents.update` from:

```ts
"true"
```

to:

```ts
"false"
```

Keep updates only for mutable presence/summary entities.

---

## Step 4: Move presence out of event log

Replace `handle.seen` append behavior with `roomPresence` upsert/update.

Remove `handle.seen` from reducer/event model if possible.

---

## Step 5: De-skin event names and schema names

Since no backward compatibility is needed, rename cleanly:

```ts
SowsEarEvent -> GameEvent
letters.planted -> letters.submitted
rows.sprouted -> letters.revealed
field.chosen -> category.chosen
seed.planted -> answer.submitted
```

And so on.

---

## Step 6: Add active-game query path

Short term: still load all room `gameEvents`.

Medium term:

1. subscribe to `roomSummaries` for active game,
2. subscribe to active game events,
3. load historical game events only for review.

---

# 16. My strongest recommendations

If you only do a few things, do these:

1. **Remove unused normalized InstantDB schema.**
   It is stale, themed, and misleading.

2. **Make `gameEvents` immutable.**
   `create: true`, `update: false`, `delete: false`.

3. **Move presence out of `gameEvents`.**
   Heartbeats should not be permanent history.

4. **Add `roomSummaries` with `activeGameId`.**
   This enables future active-game-only subscriptions.

5. **Rename event/schema terminology generically.**
   Since you are de-skinning, do not preserve `seed`, `field`, `harvest`, `sprouted`, etc.

6. **Document the state model.**
   Make it clear that events are canonical; summaries/presence are support tables.

That will make the app simpler, more scalable, and much easier to evolve.
