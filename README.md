# Cowslip

**Cowslip** is a cooperative real-time word game for 3-8 players. One player guesses, one player secretly writes the answer, and the rest of the table builds sparse clue rows one letter at a time. The earlier the guess lands, the more it is worth.

Play it at:

```text
https://joshuamandel.com/cowslip/
```

## What Makes It Work

- **No accounts.** A room link plus a handle is the whole identity model.
- **Room-scoped play.** Add `?room=anything` to join or resume a room.
- **Fast lobby flow.** Entering a room with a handle creates or joins the lobby automatically.
- **Shared history.** Completed games stay reviewable inside the room.
- **Synchronous teamwork.** Players coordinate on a call or around a table while the app handles roles, rows, scoring, presence, and replay.
- **Static deployment.** The app builds to static files and deploys on GitHub Pages.

## How To Play

1. Share a room link.
2. Each player enters a handle. Reusing the same handle in the same room resumes that player.
3. The lobby host starts once 3-8 players are ready.
4. The guesser chooses a category.
5. The answer writer enters the secret answer.
6. Each clue giver adds one letter to each row they hold, or skips to add a blank.
7. A clue giver can mark a letter with a period to show a word break; the next player continues in the same row.
8. The guesser either guesses now or asks for one more letter.
9. Correct guesses score by depth: `20`, `10`, `7`, `5`, then `3`.
10. The final score is the best five rounds.

## Identity And Secrecy

Cowslip is intentionally casual. There is no email, password, or hardened account identity. A handle is a room-local identity, so a player can switch devices by returning to the room and typing the same handle.

Normal UI flow hides the secret answer from the guesser, but this static MVP is not adversarially secure. A determined participant who edits local state or impersonates a handle can spoil a room. That tradeoff keeps the game link-based and frictionless.

## Tech Stack

- Bun
- React
- Zustand
- TypeScript
- InstantDB for shared realtime room state
- Browser local storage and `BroadcastChannel` for `?local=1` testing
- GitHub Pages for hosting

## Project Layout

```text
src/app.tsx                 React app and Zustand store
src/game/                   Pure TypeScript rules, rotation, command model, tests
src/content/categories.ts   Starter category pack
src/store/                  InstantDB and local event stores
src/assets/                 Prepared Cowslip and letter assets
instant.schema.ts           InstantDB schema
instant.perms.ts            InstantDB permissions
tests/cdp.test.ts           Chromium end-to-end flow tests
scripts/build.ts            Static build script
scripts/dev.ts              Local static dev server
```

## Development

Install dependencies:

```sh
bun install
```

Start the local server:

```sh
bun run dev
```

The dev server builds `dist/` and serves the static app. By default it uses port `4173`; set `PORT` to override it:

```sh
PORT=52731 bun run dev
```

Force local browser storage instead of InstantDB with:

```text
http://localhost:4173/?local=1
```

## Configuration

Create `.env` from `.env.example` for local InstantDB-backed play:

```sh
cp .env.example .env
```

`BUN_PUBLIC_INSTANT_APP_ID` is public client configuration. It is safe to expose in the browser bundle and is supplied to GitHub Pages as a repository variable.

No Instant admin token is required for the static build, and no admin token should be present in `dist/`.

## Checks

Run the same checks used by CI:

```sh
bun test
bun run typecheck
bun run build
```

The GitHub Pages workflow also scans the static bundle for accidental `INSTANT_APP_ADMIN_TOKEN` references.

## Deployment

Pushes to `main` run `.github/workflows/pages.yml`.

The workflow:

1. Installs dependencies with `bun install --frozen-lockfile`.
2. Runs the Chromium end-to-end and model tests.
3. Runs TypeScript typechecking.
4. Builds the static site.
5. Checks that no Instant admin token references are bundled.
6. Deploys `dist/` to GitHub Pages.

Production URL:

```text
https://joshuamandel.com/cowslip/
```

## Design Notes

Cowslip is deliberately sparse during gameplay: clear black-and-white game surfaces, visible focus states, and no decorative art inside active game screens. The landing page and title bar use restrained Cowslip flower art; the actual game favors readability, keyboard flow, and predictable layout over theme.
