import { DEFAULT_PACK_ID, RULES_VERSION } from "../config";
import { categoryLabel, pickCategoryOptions } from "../content/categories";
import { assignmentsForDepth, rolesForRound, type PlayerSeat } from "./rotation";
import { finalScoreFromPoints, isValidLetter, normalizeGuess, pointsForDepth, roundsForPlayerCount } from "./rules";
import type {
  ClueCellInput,
  ClueEntry,
  CommandResult,
  Game,
  GamePhase,
  GamePlayer,
  RoomHandle,
  RoomState,
  Round,
  Row,
  GameEvent,
} from "./types";

export const HOST_RECOVERY_OFFLINE_MS = 45000;

export function normalizeHandle(handle: string): string {
  return handle.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function cleanHandle(handle: string): string {
  return handle.normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 32);
}

export function roomSlugFrom(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export function emptyRoom(roomSlug: string): RoomState {
  return {
    roomSlug,
    handles: [],
    games: [],
    appliedActionIds: new Set(),
  };
}

export function activeGame(state: RoomState): Game | undefined {
  return state.games.find((game) => game.id === state.activeGameId);
}

export function currentRound(game: Game): Round | undefined {
  return game.rounds.find((round) => round.id === game.currentRoundId);
}

export function playerForHandle(game: Game, handle: string): GamePlayer | undefined {
  const normalizedHandle = normalizeHandle(handle);
  return game.players.find((player) => player.normalizedHandle === normalizedHandle);
}

export function roleForHandle(game: Game, handle: string): "guesser" | "answerWriter" | "clueGiver" | "none" {
  const round = currentRound(game);
  const normalizedHandle = normalizeHandle(handle);
  if (!round) return "none";
  if (normalizeHandle(round.guesserHandle) === normalizedHandle) return "guesser";
  if (normalizeHandle(round.answerWriterHandle) === normalizedHandle) return "answerWriter";
  if (playerForHandle(game, handle)) return "clueGiver";
  return "none";
}

export function displayHandleForGame(game: Game, handle: string): string {
  return playerForHandle(game, handle)?.handle ?? cleanHandle(handle);
}

export function rowIsComplete(round: Round, rowIndex: number): boolean {
  void round;
  void rowIndex;
  return false;
}

export function rowEntriesThroughDepth(round: Round, rowIndex: number, depth = round.depth): ClueEntry[] {
  return round.entries
    .filter((entry) => entry.rowIndex === rowIndex && entry.depth <= depth)
    .sort((a, b) => a.depth - b.depth);
}

export function trailingBlankEntriesForRow(round: Round, rowIndex: number, beforeDepth = round.depth): ClueEntry[] {
  const entries = rowEntriesThroughDepth(round, rowIndex, beforeDepth - 1);
  const trailing: ClueEntry[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (!entry.skipped) break;
    trailing.unshift(entry);
  }
  return trailing;
}

export function activeRowsForDepth(round: Round): Row[] {
  return round.rows;
}

export function rowsHeldByClueGiver(round: Round, handle: string): Row[] {
  const normalizedHandle = normalizeHandle(handle);
  return activeRowsForDepth(round).filter(
    (row) =>
      normalizeHandle(row.currentHolderHandle) === normalizedHandle &&
      !round.entries.some((entry) => entry.rowIndex === row.rowIndex && entry.depth === round.depth),
  );
}

export function reduceEvents(roomSlug: string, events: GameEvent[]): RoomState {
  const state = emptyRoom(roomSlug);
  const ordered = [...events]
    .filter((event) => event.roomSlug === roomSlug)
    .sort((a, b) => a.createdAt - b.createdAt || eventRank(a.type) - eventRank(b.type) || a.actionId.localeCompare(b.actionId));

  for (const event of ordered) {
    applyEvent(state, event);
  }
  return state;
}

function applyEvent(state: RoomState, event: GameEvent): void {
  if (state.appliedActionIds.has(event.actionId)) return;
  state.appliedActionIds.add(event.actionId);

  if (event.type === "handle.claimed") {
    const handle = stringPayload(event, "handle");
    const normalizedHandle = normalizeHandle(handle);
    const existing = state.handles.find((item) => item.normalizedHandle === normalizedHandle);
    const nextHandle: RoomHandle = {
      handle,
      normalizedHandle,
      displayName: handle,
      lastSeenAt: event.createdAt,
      createdAt: existing?.createdAt ?? event.createdAt,
    };
    if (existing) Object.assign(existing, nextHandle);
    else state.handles.push(nextHandle);
    return;
  }

  if (event.type === "game.created") {
    const gameId = stringPayload(event, "gameId");
    if (state.games.some((game) => game.id === gameId)) return;
    const hostHandle = stringPayload(event, "hostHandle");
    const game: Game = {
      id: gameId,
      roomSlug: state.roomSlug,
      status: "lobby",
      phase: "lobby",
      hostHandle,
      players: [],
      rounds: [],
      currentRoundNumber: 0,
      totalRounds: 0,
      phaseVersion: 0,
      playerCount: 0,
      categoryPackId: stringPayload(event, "categoryPackId") || DEFAULT_PACK_ID,
      rulesVersion: stringPayload(event, "rulesVersion") || RULES_VERSION,
      roundPoints: [],
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
    };
    state.games.push(game);
    state.activeGameId = game.id;
    return;
  }

  const game = event.gameId ? state.games.find((item) => item.id === event.gameId) : activeGame(state);
  if (!game) return;

  if (typeof event.expectedPhaseVersion === "number" && event.expectedPhaseVersion !== game.phaseVersion) {
    return;
  }

  switch (event.type) {
    case "player.joined": {
      const handle = stringPayload(event, "handle");
      const normalizedHandle = normalizeHandle(handle);
      if (game.players.some((player) => player.normalizedHandle === normalizedHandle)) return;
      const seatNumber = game.players.length;
      game.players.push({
        handle,
        normalizedHandle,
        displayName: handle,
        seatNumber,
        ready: Boolean(event.payload.ready),
        isHost: game.players.length === 0 || normalizeHandle(game.hostHandle) === normalizedHandle,
        joinedAt: event.createdAt,
        updatedAt: event.createdAt,
      });
      game.playerCount = game.players.length;
      game.updatedAt = event.createdAt;
      return;
    }
    case "player.ready-set": {
      const player = playerForHandle(game, stringPayload(event, "handle"));
      if (!player) return;
      player.ready = Boolean(event.payload.ready);
      player.updatedAt = event.createdAt;
      game.updatedAt = event.createdAt;
      return;
    }
    case "seats.reordered": {
      if (game.status !== "lobby") return;
      const orderedHandles = arrayPayload<string>(event, "handles");
      const playersByHandle = new Map(game.players.map((player) => [player.normalizedHandle, player]));
      const normalizedOrder = orderedHandles.map(normalizeHandle);
      if (normalizedOrder.length !== game.players.length) return;
      if (new Set(normalizedOrder).size !== game.players.length) return;
      if (normalizedOrder.some((handle) => !playersByHandle.has(handle))) return;
      game.players = normalizedOrder.map((normalizedHandle, seatNumber) => {
        const player = playersByHandle.get(normalizedHandle)!;
        return { ...player, seatNumber, updatedAt: event.createdAt };
      });
      game.phaseVersion += 1;
      game.updatedAt = event.createdAt;
      return;
    }
    case "game.started": {
      if (game.status !== "lobby") return;
      const players = orderedPlayers(game).filter((player) => player.ready);
      if (players.length < 3 || players.length > 8) return;
      game.players = players.map((player, seatNumber) => ({ ...player, seatNumber, ready: true }));
      game.status = "active";
      game.phase = "category-choice";
      game.currentRoundNumber = 1;
      game.totalRounds = roundsForPlayerCount(players.length);
      game.phaseVersion += 1;
      const round = makeRound(game, 1, event.createdAt);
      game.rounds.push(round);
      game.currentRoundId = round.id;
      game.playerCount = players.length;
      game.updatedAt = event.createdAt;
      return;
    }
    case "category.chosen": {
      const round = roundForEvent(game, event);
      if (!round || round.phase !== "category-choice") return;
      const categoryId = stringPayload(event, "categoryId");
      if (!round.categoryOptions.includes(categoryId)) return;
      round.categoryId = categoryId;
      round.categoryLabel = categoryLabel(categoryId);
      round.phase = "answer-entry";
      round.phaseVersion += 1;
      round.updatedAt = event.createdAt;
      bumpGame(game, "answer-entry", event.createdAt);
      return;
    }
    case "answer.submitted": {
      const round = roundForEvent(game, event);
      if (!round || round.phase !== "answer-entry") return;
      round.answerRaw = stringPayload(event, "answerRaw");
      round.answerNorm = normalizeGuess(round.answerRaw);
      round.depth = 1;
      round.rows = rowsFor(game, round.roundNumber, 1);
      round.phase = "letter-entry";
      round.phaseVersion += 1;
      round.updatedAt = event.createdAt;
      bumpGame(game, "letter-entry", event.createdAt);
      return;
    }
    case "letters.submitted": {
      const round = roundForEvent(game, event);
      if (!round || round.phase !== "letter-entry") return;
      const entries = arrayPayload<ClueEntry>(event, "entries");
      for (const entry of entries) {
        const existing = round.entries.find((item) => entryKey(item) === entryKey(entry));
        const nextEntry: ClueEntry = {
          ...entry,
          letter: entry.letter ?? "",
          skipped: Boolean(entry.skipped),
          endsWord: Boolean(entry.endsWord) && !entry.skipped,
          revealed: false,
          filledAtDepth: typeof entry.filledAtDepth === "number" ? entry.filledAtDepth : entry.depth,
          createdAt: event.createdAt,
        };
        if (existing) {
          if (!existing.skipped || nextEntry.skipped || !nextEntry.letter) continue;
          Object.assign(existing, nextEntry);
          continue;
        }
        round.entries.push(nextEntry);
      }
      round.updatedAt = event.createdAt;
      return;
    }
    case "letters.revealed": {
      const round = roundForEvent(game, event);
      if (!round || round.phase !== "letter-entry") return;
      for (const entry of round.entries) {
        if (entry.depth <= round.depth) entry.revealed = true;
      }
      round.phase = "guesser-call";
      round.phaseVersion += 1;
      round.updatedAt = event.createdAt;
      bumpGame(game, "guesser-call", event.createdAt);
      return;
    }
    case "more-letters.requested": {
      const round = roundForEvent(game, event);
      if (!round || round.phase !== "guesser-call" || round.depth >= 5) return;
      round.depth += 1;
      round.rows = rowsFor(game, round.roundNumber, round.depth);
      round.phase = "letter-entry";
      round.phaseVersion += 1;
      round.updatedAt = event.createdAt;
      bumpGame(game, "letter-entry", event.createdAt);
      return;
    }
    case "guess.submitted": {
      const round = roundForEvent(game, event);
      if (!round || round.phase !== "guesser-call") return;
      round.guessRaw = stringPayload(event, "guessRaw");
      round.guessNorm = normalizeGuess(round.guessRaw);
      const exact = round.answerNorm === round.guessNorm;
      if (exact) {
        resolveRound(game, round, true, event.createdAt);
      } else {
        round.phase = "guess-judging";
        round.phaseVersion += 1;
        round.updatedAt = event.createdAt;
        bumpGame(game, "guess-judging", event.createdAt);
      }
      return;
    }
    case "guess.judged": {
      const round = roundForEvent(game, event);
      if (!round || round.phase !== "guess-judging") return;
      resolveRound(game, round, Boolean(event.payload.accepted), event.createdAt);
      return;
    }
    case "round.passed": {
      const round = roundForEvent(game, event);
      if (!round || round.phase !== "guesser-call") return;
      resolveRound(game, round, false, event.createdAt);
      return;
    }
    case "next-round.started": {
      const current = currentRound(game);
      if (!current || (current.status !== "resolved" && current.status !== "void") || game.status !== "active") return;
      const nextNumber = current.roundNumber + 1;
      if (nextNumber > game.totalRounds) return;
      game.phase = "category-choice";
      game.currentRoundNumber = nextNumber;
      game.phaseVersion += 1;
      const round = makeRound(game, nextNumber, event.createdAt);
      game.rounds.push(round);
      game.currentRoundId = round.id;
      game.updatedAt = event.createdAt;
      return;
    }
    case "game.completed": {
      if (game.status !== "active") return;
      game.status = "complete";
      game.phase = "final";
      game.phaseVersion += 1;
      game.completedAt = event.createdAt;
      game.updatedAt = event.createdAt;
      return;
    }
    case "round.voided": {
      const round = roundForEvent(game, event);
      if (!round || game.status !== "active" || round.status !== "active") return;
      round.status = "void";
      round.phase = "round-recap";
      round.points = 0;
      round.resolvedAt = event.createdAt;
      game.roundPoints.push(0);
      bumpGame(game, "round-recap", event.createdAt);
      return;
    }
    case "game.paused": {
      if (game.status !== "active" || game.pausedAt) return;
      game.pausedAt = event.createdAt;
      game.phaseVersion += 1;
      game.updatedAt = event.createdAt;
      return;
    }
    case "game.resumed": {
      if (!game.pausedAt) return;
      delete game.pausedAt;
      game.phaseVersion += 1;
      game.updatedAt = event.createdAt;
      return;
    }
    case "host.transferred": {
      const nextHost = stringPayload(event, "handle");
      const player = playerForHandle(game, nextHost);
      if (!player) return;
      game.hostHandle = player.handle;
      for (const seat of game.players) {
        seat.isHost = normalizeHandle(seat.handle) === normalizeHandle(player.handle);
      }
      game.phaseVersion += 1;
      game.updatedAt = event.createdAt;
      return;
    }
    default:
      return;
  }
}

function eventRank(type: GameEvent["type"]): number {
  return [
    "handle.claimed",
    "game.created",
    "player.joined",
    "player.ready-set",
    "seats.reordered",
    "game.started",
    "category.chosen",
    "answer.submitted",
    "letters.submitted",
    "letters.revealed",
    "more-letters.requested",
    "guess.submitted",
    "guess.judged",
    "round.passed",
    "next-round.started",
    "game.completed",
    "round.voided",
    "game.paused",
    "game.resumed",
    "host.transferred",
  ].indexOf(type);
}

function makeRound(game: Game, roundNumber: number, now: number): Round {
  const roles = rolesForRound(seatsFromPlayers(game.players), roundNumber);
  const id = `${game.id}:round:${roundNumber}`;
  return {
    id,
    roundNumber,
    phase: "category-choice",
    status: "active",
    guesserHandle: roles.guesser.nickname,
    answerWriterHandle: roles.answerWriter.nickname,
    categoryOptions: pickCategoryOptions(game.id, roundNumber),
    depth: 0,
    phaseVersion: 0,
    rows: [],
    entries: [],
    createdAt: now,
    updatedAt: now,
  };
}

function rowsFor(game: Game, roundNumber: number, depth: number): Row[] {
  const assignments = assignmentsForDepth(seatsFromPlayers(game.players), roundNumber, depth);
  return assignments.map((assignment) => {
    const starter = assignmentsForDepth(seatsFromPlayers(game.players), roundNumber, 1).find(
      (item) => item.rowIndex === assignment.rowIndex,
    );
    return {
      rowIndex: assignment.rowIndex,
      starterHandle: starter?.holderUserId ?? assignment.holderUserId,
      currentHolderHandle: assignment.holderUserId,
      slot: assignment.slot,
    };
  });
}

function seatsFromPlayers(players: GamePlayer[]): PlayerSeat[] {
  return orderedPlayers({ players } as Game).map((player) => ({
    userId: player.handle,
    seatNumber: player.seatNumber,
    nickname: player.handle,
  }));
}

function orderedPlayers(game: Game): GamePlayer[] {
  return [...game.players].sort((a, b) => a.seatNumber - b.seatNumber);
}

function bumpGame(game: Game, phase: GamePhase, now: number): void {
  game.phase = phase;
  game.phaseVersion += 1;
  game.updatedAt = now;
}

function resolveRound(game: Game, round: Round, accepted: boolean, now: number): void {
  round.accepted = accepted;
  round.points = pointsForDepth(accepted, round.depth);
  round.status = "resolved";
  round.phase = "round-recap";
  round.phaseVersion += 1;
  round.resolvedAt = now;
  round.updatedAt = now;
  game.roundPoints = [...game.roundPoints, round.points];
  bumpGame(game, "round-recap", now);
}

function roundForEvent(game: Game, event: GameEvent): Round | undefined {
  return event.roundId ? game.rounds.find((round) => round.id === event.roundId) : currentRound(game);
}

function stringPayload(event: GameEvent, key: string): string {
  const value = event.payload[key];
  return typeof value === "string" ? value : "";
}

function arrayPayload<T>(event: GameEvent, key: string): T[] {
  const value = event.payload[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

function entryKey(entry: Pick<ClueEntry, "rowIndex" | "depth">): string {
  return `${entry.rowIndex}:${entry.depth}`;
}

export function makeActionId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

let lastEventAt = 0;

function nextEventAt(): number {
  const now = Date.now();
  lastEventAt = Math.max(now, lastEventAt + 1);
  return lastEventAt;
}

export function eventOf(
  state: RoomState,
  type: GameEvent["type"],
  actorHandle: string,
  payload: Record<string, unknown>,
  options: { gameId?: string; roundId?: string; expectedPhaseVersion?: number; actionId?: string } = {},
): GameEvent {
  const event: GameEvent = {
    actionId: options.actionId ?? makeActionId(type),
    type,
    roomSlug: state.roomSlug,
    actorHandle,
    createdAt: nextEventAt(),
    payload,
  };
  if (options.gameId) event.gameId = options.gameId;
  if (options.roundId) event.roundId = options.roundId;
  if (typeof options.expectedPhaseVersion === "number") event.expectedPhaseVersion = options.expectedPhaseVersion;
  return event;
}

export function commandClaimHandle(state: RoomState, handleInput: string): CommandResult {
  const handle = cleanHandle(handleInput);
  if (!handle) return { ok: false, error: "Enter a handle." };
  return {
    ok: true,
    events: [
      eventOf(state, "handle.claimed", handle, {
        handle,
        normalizedHandle: normalizeHandle(handle),
      }),
    ],
  };
}

export function commandCreateGame(state: RoomState, handle: string): CommandResult {
  if (!state.handles.some((item) => item.normalizedHandle === normalizeHandle(handle))) {
    return { ok: false, error: "Enter a handle before starting a game." };
  }
  const active = activeGame(state);
  if (active && active.status !== "complete" && active.status !== "void") {
    return { ok: false, error: "This room already has an active game." };
  }
  const gameId = `${state.roomSlug}:game:${Date.now().toString(36)}`;
  const base = eventOf(
    state,
    "game.created",
    handle,
    { gameId, hostHandle: handle, rulesVersion: RULES_VERSION, categoryPackId: DEFAULT_PACK_ID },
    { gameId },
  );
  const join = eventOf(
    state,
    "player.joined",
    handle,
    { handle, normalizedHandle: normalizeHandle(handle), ready: true },
    { gameId },
  );
  return { ok: true, events: [base, join] };
}

export function commandJoinGame(state: RoomState, handle: string): CommandResult {
  const game = activeGame(state);
  if (!game || game.status !== "lobby") return { ok: false, error: "There is no lobby to join." };
  if (playerForHandle(game, handle)) return { ok: true, events: [] };
  if (game.players.length >= 8) return { ok: false, error: "This game already has eight players." };
  return {
    ok: true,
	    events: [
	      eventOf(
	        state,
	        "player.joined",
	        handle,
	        { handle, normalizedHandle: normalizeHandle(handle), ready: true },
	        { gameId: game.id },
	      ),
	    ],
  };
}

export function commandSetReady(state: RoomState, handle: string, ready: boolean): CommandResult {
  const game = activeGame(state);
  if (!game || game.status !== "lobby") return { ok: false, error: "There is no lobby." };
  if (!playerForHandle(game, handle)) return { ok: false, error: "Join the game first." };
  return {
    ok: true,
    events: [eventOf(state, "player.ready-set", handle, { handle, ready }, { gameId: game.id })],
  };
}

export function commandReorderSeats(state: RoomState, handle: string, orderedHandles: string[]): CommandResult {
  const game = activeGame(state);
  if (!game || game.status !== "lobby") return { ok: false, error: "Seats can only be changed in the lobby." };
  if (normalizeHandle(game.hostHandle) !== normalizeHandle(handle)) return { ok: false, error: "Only the host can reorder seats." };
  const playersByHandle = new Map(game.players.map((player) => [player.normalizedHandle, player]));
  const normalizedOrder = orderedHandles.map(normalizeHandle);
  if (normalizedOrder.length !== game.players.length) return { ok: false, error: "Seat order must include every player." };
  if (new Set(normalizedOrder).size !== game.players.length) return { ok: false, error: "Seat order cannot include duplicates." };
  const orderedSeatPlayers = normalizedOrder.map((normalizedHandle) => playersByHandle.get(normalizedHandle));
  if (orderedSeatPlayers.some((player) => !player)) return { ok: false, error: "Seat order includes a player outside this game." };
  const handles = orderedSeatPlayers.map((player) => player!.handle);
  const current = orderedPlayers(game).map((player) => player.handle);
  if (handles.every((playerHandle, index) => normalizeHandle(playerHandle) === normalizeHandle(current[index] ?? ""))) {
    return { ok: true, events: [] };
  }
  return {
    ok: true,
    events: [
      eventOf(
        state,
        "seats.reordered",
        handle,
        { handles },
        { gameId: game.id, expectedPhaseVersion: game.phaseVersion },
      ),
    ],
  };
}

export function commandMoveSeat(state: RoomState, handle: string, playerHandle: string, direction: "up" | "down"): CommandResult {
  const game = activeGame(state);
  if (!game || game.status !== "lobby") return { ok: false, error: "Seats can only be changed in the lobby." };
  const handles = orderedPlayers(game).map((player) => player.handle);
  const from = handles.findIndex((item) => normalizeHandle(item) === normalizeHandle(playerHandle));
  if (from < 0) return { ok: false, error: "Choose a player in this game." };
  const to = direction === "up" ? Math.max(0, from - 1) : Math.min(handles.length - 1, from + 1);
  if (to === from) return { ok: true, events: [] };
  const next = [...handles];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return commandReorderSeats(state, handle, next);
}

export function commandRandomizeSeats(state: RoomState, handle: string): CommandResult {
  const game = activeGame(state);
  if (!game || game.status !== "lobby") return { ok: false, error: "Seats can only be changed in the lobby." };
  const current = orderedPlayers(game).map((player) => player.handle);
  const shuffled = [...current];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  if (shuffled.length > 1 && shuffled.every((playerHandle, index) => playerHandle === current[index])) {
    shuffled.push(shuffled.shift()!);
  }
  return commandReorderSeats(state, handle, shuffled);
}

export function commandStartGame(state: RoomState, handle: string): CommandResult {
  const game = activeGame(state);
  if (!game || game.status !== "lobby") return { ok: false, error: "There is no lobby to start." };
  if (game.pausedAt) return { ok: false, error: "The game is paused." };
  if (normalizeHandle(game.hostHandle) !== normalizeHandle(handle)) return { ok: false, error: "Only the host can start." };
  const readyPlayers = game.players.filter((player) => player.ready);
  if (readyPlayers.length < 3 || readyPlayers.length > 8) {
    return { ok: false, error: "Start needs 3-8 ready players." };
  }
  return {
    ok: true,
    events: [
      eventOf(state, "game.started", handle, {}, { gameId: game.id, expectedPhaseVersion: game.phaseVersion }),
    ],
  };
}

export function commandChooseCategory(state: RoomState, handle: string, categoryId: string): CommandResult {
  const game = activeGame(state);
  const round = game ? currentRound(game) : undefined;
  if (!game || !round || round.phase !== "category-choice") return { ok: false, error: "No category is being chosen." };
  if (game.pausedAt) return { ok: false, error: "The game is paused." };
  if (normalizeHandle(round.guesserHandle) !== normalizeHandle(handle)) return { ok: false, error: "Only the guesser chooses." };
  if (!round.categoryOptions.includes(categoryId)) return { ok: false, error: "Choose one of the offered categories." };
  return {
    ok: true,
    events: [
      eventOf(
        state,
        "category.chosen",
        handle,
        { categoryId },
        { gameId: game.id, roundId: round.id, expectedPhaseVersion: game.phaseVersion },
      ),
    ],
  };
}

export function commandSubmitAnswer(state: RoomState, handle: string, answerRaw: string): CommandResult {
  const game = activeGame(state);
  const round = game ? currentRound(game) : undefined;
  if (!game || !round || round.phase !== "answer-entry") return { ok: false, error: "No answer is being chosen." };
  if (game.pausedAt) return { ok: false, error: "The game is paused." };
  if (normalizeHandle(round.answerWriterHandle) !== normalizeHandle(handle)) return { ok: false, error: "Only the answer writer chooses the answer." };
  const answer = answerRaw.trim();
  if (!answer) return { ok: false, error: "Enter an answer." };
  return {
    ok: true,
    events: [
      eventOf(
        state,
        "answer.submitted",
        handle,
        { answerRaw: answer, answerNorm: normalizeGuess(answer) },
        { gameId: game.id, roundId: round.id, expectedPhaseVersion: game.phaseVersion },
      ),
    ],
  };
}

export function commandSubmitLetters(state: RoomState, handle: string, lettersByRow: Map<number, string | ClueCellInput>): CommandResult {
  const game = activeGame(state);
  const round = game ? currentRound(game) : undefined;
  if (!game || !round || round.phase !== "letter-entry") return { ok: false, error: "Letters are not being submitted now." };
  if (game.pausedAt) return { ok: false, error: "The game is paused." };
  const heldRows = rowsHeldByClueGiver(round, handle);
  if (!heldRows.length) return { ok: false, error: "You do not have a row right now." };
  const entries: ClueEntry[] = [];
  const canonicalHandle = displayHandleForGame(game, handle);
  for (const row of heldRows) {
    const input = lettersByRow.get(row.rowIndex);
    const skipped = typeof input === "string" ? false : Boolean(input?.skipped);
    const endsWord = typeof input === "string" ? false : Boolean(input?.endsWord);
    const cells = normalizedInputCells(input, round.depth);
    const priorEntries = rowEntriesThroughDepth(round, row.rowIndex, round.depth - 1);
    const firstBlankIndex = priorEntries.findIndex((entry) => entry.skipped);
    if (firstBlankIndex >= 0 && priorEntries.slice(firstBlankIndex).some((entry) => !entry.skipped)) {
      return { ok: false, error: "Blank cells must stay at the end of a row." };
    }
    const trailingBlanks = trailingBlankEntriesForRow(round, row.rowIndex);

    if (skipped) {
      if (cells.length) return { ok: false, error: "Choose either letters or one blank cell." };
      if (endsWord) return { ok: false, error: "A blank cell cannot end a word." };
      entries.push({
        rowIndex: row.rowIndex,
        depth: round.depth,
        handle: canonicalHandle,
        letter: "",
        skipped: true,
        endsWord: false,
        revealed: false,
        filledAtDepth: round.depth,
        createdAt: Date.now(),
      });
      continue;
    }

    const expectedDepths = [...trailingBlanks.map((entry) => entry.depth), round.depth];
    if (cells.length !== expectedDepths.length) {
      return { ok: false, error: "Fill every trailing blank and add one letter, or add one blank cell." };
    }
    const cellsByDepth = new Map(cells.map((cell) => [cell.depth, cell.letter.toLocaleUpperCase("en-US")]));
    if (cellsByDepth.size !== cells.length || expectedDepths.some((depth) => !cellsByDepth.has(depth))) {
      return { ok: false, error: "Only trailing blanks and the next cell can be filled." };
    }
    for (const depth of expectedDepths) {
      const normalizedLetter = cellsByDepth.get(depth) ?? "";
      if (!isValidLetter(normalizedLetter)) return { ok: false, error: "Add one letter in each required cell." };
      entries.push({
        rowIndex: row.rowIndex,
        depth,
        handle: canonicalHandle,
        letter: normalizedLetter,
        skipped: false,
        endsWord: depth === round.depth && endsWord,
        revealed: false,
        filledAtDepth: round.depth,
        createdAt: Date.now(),
      });
    }
  }
  const baseEvent = eventOf(
    state,
    "letters.submitted",
    handle,
    { entries },
    { gameId: game.id, roundId: round.id, expectedPhaseVersion: game.phaseVersion },
  );
  const existingKeys = new Set(round.entries.map(entryKey));
  const combinedKeys = new Set([...existingKeys, ...entries.map(entryKey)]);
  const expectedRows = activeRowsForDepth(round);
  const shouldReveal = expectedRows.every((row) => combinedKeys.has(`${row.rowIndex}:${round.depth}`));
  const events = [baseEvent];
  if (shouldReveal) {
    events.push(
      eventOf(
        state,
        "letters.revealed",
        handle,
        { depth: round.depth },
        { gameId: game.id, roundId: round.id, expectedPhaseVersion: game.phaseVersion },
      ),
    );
  }
  return { ok: true, events };
}

function normalizedInputCells(input: string | ClueCellInput | undefined, currentDepth: number): Array<{ depth: number; letter: string }> {
  if (!input) return [];
  if (typeof input === "string") return input ? [{ depth: currentDepth, letter: input }] : [];
  if (input.cells) return input.cells.map((cell) => ({ depth: cell.depth, letter: cell.letter }));
  return input.letter ? [{ depth: currentDepth, letter: input.letter }] : [];
}

export function commandTryRevealLetters(state: RoomState, handle: string): CommandResult {
  const game = activeGame(state);
  const round = game ? currentRound(game) : undefined;
  if (!game || !round || round.phase !== "letter-entry") return { ok: true, events: [] };
  if (game.pausedAt) return { ok: true, events: [] };
  const entriesAtDepth = round.entries.filter((entry) => entry.depth === round.depth);
  if (entriesAtDepth.every((entry) => entry.revealed)) return { ok: true, events: [] };
  const submittedRows = new Set(entriesAtDepth.map((entry) => entry.rowIndex));
  if (!activeRowsForDepth(round).every((row) => submittedRows.has(row.rowIndex))) return { ok: true, events: [] };
  return {
    ok: true,
    events: [
      eventOf(
        state,
        "letters.revealed",
        handle,
        { depth: round.depth },
        { gameId: game.id, roundId: round.id, expectedPhaseVersion: game.phaseVersion },
      ),
    ],
  };
}

export function commandRequestMoreLetters(state: RoomState, handle: string): CommandResult {
  const game = activeGame(state);
  const round = game ? currentRound(game) : undefined;
  if (!game || !round || round.phase !== "guesser-call") return { ok: false, error: "The guesser is not choosing now." };
  if (game.pausedAt) return { ok: false, error: "The game is paused." };
  if (normalizeHandle(round.guesserHandle) !== normalizeHandle(handle)) return { ok: false, error: "Only the guesser can request more letters." };
  if (round.depth >= 5) return { ok: false, error: "At five cells, the guesser must guess or pass." };
  return {
    ok: true,
    events: [
      eventOf(state, "more-letters.requested", handle, {}, { gameId: game.id, roundId: round.id, expectedPhaseVersion: game.phaseVersion }),
    ],
  };
}

export function commandGuess(state: RoomState, handle: string, guessRaw: string): CommandResult {
  const game = activeGame(state);
  const round = game ? currentRound(game) : undefined;
  if (!game || !round || round.phase !== "guesser-call") return { ok: false, error: "The guesser is not guessing now." };
  if (game.pausedAt) return { ok: false, error: "The game is paused." };
  if (normalizeHandle(round.guesserHandle) !== normalizeHandle(handle)) return { ok: false, error: "Only the guesser can guess." };
  const guess = guessRaw.trim();
  if (!guess) return { ok: false, error: "Enter a Guess." };
  return {
    ok: true,
    events: [
      eventOf(
        state,
        "guess.submitted",
        handle,
        { guessRaw: guess, guessNorm: normalizeGuess(guess) },
        { gameId: game.id, roundId: round.id, expectedPhaseVersion: game.phaseVersion },
      ),
    ],
  };
}

export function commandJudgeGuess(state: RoomState, handle: string, accepted: boolean): CommandResult {
  const game = activeGame(state);
  const round = game ? currentRound(game) : undefined;
  if (!game || !round || round.phase !== "guess-judging") return { ok: false, error: "No Guess is awaiting judgment." };
  if (game.pausedAt) return { ok: false, error: "The game is paused." };
  if (normalizeHandle(round.answerWriterHandle) !== normalizeHandle(handle)) return { ok: false, error: "Only the answer writer can judge the guess." };
  return {
    ok: true,
    events: [
      eventOf(
        state,
        "guess.judged",
        handle,
        { accepted },
        { gameId: game.id, roundId: round.id, expectedPhaseVersion: game.phaseVersion },
      ),
    ],
  };
}

export function commandPassRound(state: RoomState, handle: string): CommandResult {
  const game = activeGame(state);
  const round = game ? currentRound(game) : undefined;
  if (!game || !round || round.phase !== "guesser-call") return { ok: false, error: "Nothing can be passed now." };
  if (game.pausedAt) return { ok: false, error: "The game is paused." };
  if (normalizeHandle(round.guesserHandle) !== normalizeHandle(handle)) return { ok: false, error: "Only the guesser can pass." };
  return {
    ok: true,
    events: [
      eventOf(
        state,
        "round.passed",
        handle,
        {},
        { gameId: game.id, roundId: round.id, expectedPhaseVersion: game.phaseVersion },
      ),
    ],
  };
}

export function commandAdvanceRound(state: RoomState, handle: string): CommandResult {
  const game = activeGame(state);
  const round = game ? currentRound(game) : undefined;
  if (!game || !round || round.phase !== "round-recap") return { ok: false, error: "No round recap is ready." };
  if (game.pausedAt) return { ok: false, error: "The game is paused." };
  if (normalizeHandle(game.hostHandle) !== normalizeHandle(handle)) return { ok: false, error: "Only the host advances the game." };
  if (round.roundNumber >= game.totalRounds) {
    return {
      ok: true,
      events: [
        eventOf(state, "game.completed", handle, {}, { gameId: game.id, expectedPhaseVersion: game.phaseVersion }),
      ],
    };
  }
  return {
    ok: true,
    events: [
      eventOf(
        state,
        "next-round.started",
        handle,
        {},
        { gameId: game.id, roundId: round.id, expectedPhaseVersion: game.phaseVersion },
      ),
    ],
  };
}

export function finalScore(game: Game): number {
  return finalScoreFromPoints(game.roundPoints);
}

export function commandPauseGame(state: RoomState, handle: string): CommandResult {
  const game = activeGame(state);
  if (!game || game.status !== "active") return { ok: false, error: "There is no active game to pause." };
  if (normalizeHandle(game.hostHandle) !== normalizeHandle(handle)) return { ok: false, error: "Only the host can pause." };
  if (game.pausedAt) return { ok: true, events: [] };
  return {
    ok: true,
    events: [eventOf(state, "game.paused", handle, {}, { gameId: game.id, expectedPhaseVersion: game.phaseVersion })],
  };
}

export function commandResumeGame(state: RoomState, handle: string): CommandResult {
  const game = activeGame(state);
  if (!game || game.status !== "active") return { ok: false, error: "There is no active game to resume." };
  if (normalizeHandle(game.hostHandle) !== normalizeHandle(handle)) return { ok: false, error: "Only the host can resume." };
  if (!game.pausedAt) return { ok: true, events: [] };
  return {
    ok: true,
    events: [eventOf(state, "game.resumed", handle, {}, { gameId: game.id, expectedPhaseVersion: game.phaseVersion })],
  };
}

export function commandTransferHost(state: RoomState, handle: string, nextHost: string): CommandResult {
  const game = activeGame(state);
  if (!game) return { ok: false, error: "There is no game." };
  if (normalizeHandle(game.hostHandle) !== normalizeHandle(handle)) return { ok: false, error: "Only the host can transfer host." };
  const player = playerForHandle(game, nextHost);
  if (!player) return { ok: false, error: "Choose a player in this game." };
  if (normalizeHandle(player.handle) === normalizeHandle(game.hostHandle)) return { ok: true, events: [] };
  return {
    ok: true,
    events: [
      eventOf(
        state,
        "host.transferred",
        handle,
        { handle: player.handle },
        { gameId: game.id, expectedPhaseVersion: game.phaseVersion },
      ),
    ],
  };
}

export function commandClaimHost(state: RoomState, handle: string, now = Date.now()): CommandResult {
  const game = activeGame(state);
  if (!game || (game.status !== "active" && game.status !== "lobby")) return { ok: false, error: "There is no game." };
  const player = playerForHandle(game, handle);
  if (!player) return { ok: false, error: "Join the game first." };
  if (normalizeHandle(player.handle) === normalizeHandle(game.hostHandle)) return { ok: true, events: [] };
  const hostHandle = state.handles.find((item) => item.normalizedHandle === normalizeHandle(game.hostHandle));
  if (hostHandle && now - hostHandle.lastSeenAt <= HOST_RECOVERY_OFFLINE_MS) {
    return { ok: false, error: "The host is still online." };
  }
  return {
    ok: true,
    events: [
      eventOf(
        state,
        "host.transferred",
        handle,
        { handle: player.handle },
        { gameId: game.id, expectedPhaseVersion: game.phaseVersion },
      ),
    ],
  };
}

export function commandVoidRound(state: RoomState, handle: string): CommandResult {
  const game = activeGame(state);
  const round = game ? currentRound(game) : undefined;
  if (!game || !round || game.status !== "active") return { ok: false, error: "There is no active round to void." };
  if (normalizeHandle(game.hostHandle) !== normalizeHandle(handle)) return { ok: false, error: "Only the host can void a round." };
  if (round.status !== "active") return { ok: false, error: "This round is already resolved." };
  return {
    ok: true,
    events: [
      eventOf(
        state,
        "round.voided",
        handle,
        {},
        { gameId: game.id, roundId: round.id, expectedPhaseVersion: game.phaseVersion },
      ),
    ],
  };
}
