import { describe, expect, test } from "bun:test";
import { DEFAULT_PACK_ID, RULES_VERSION } from "../config";
import {
  activeGame,
  commandJudgeGuess,
  commandAdvanceRound,
  commandClaimHost,
  commandChooseCategory,
  commandClaimHandle,
  commandCreateGame,
  commandGuess,
  commandJoinGame,
  commandMoveSeat,
  commandPauseGame,
  commandSubmitLetters,
  commandSubmitAnswer,
  commandRandomizeSeats,
  commandResumeGame,
  commandSetReady,
  commandPassRound,
  commandStartGame,
  commandTransferHost,
  commandTryRevealLetters,
  commandVoidRound,
  commandRequestMoreLetters,
  currentRound,
  finalScore,
  HOST_RECOVERY_OFFLINE_MS,
  reduceEvents,
  rowsHeldByClueGiver,
} from "./model";
import { clampLetter } from "./rules";
import type { ClueCellInput, CommandResult, RoomState, GameEvent } from "./types";

function apply(state: RoomState, result: CommandResult): RoomState {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return reduceEvents(state.roomSlug, [...eventsFrom(state), ...result.events]);
}

function eventsFrom(state: RoomState): GameEvent[] {
  return [...state.appliedActionIds].map((actionId) => (globalThis as any).__events[actionId]).filter(Boolean);
}

function remember(events: GameEvent[]): void {
  (globalThis as any).__events ??= {};
  for (const event of events) (globalThis as any).__events[event.actionId] = event;
}

function applyRemembered(state: RoomState, result: CommandResult): RoomState {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  remember(result.events);
  return reduceEvents(state.roomSlug, [...eventsFrom(state), ...result.events]);
}

function startThreePlayerGame(): RoomState {
  let state = reduceEvents("test-room", []);
  for (const handle of ["Alice", "Bob", "Cora"]) {
    const claimed = commandClaimHandle(state, handle);
    state = applyRemembered(state, claimed);
  }
  state = applyRemembered(state, commandCreateGame(state, "Alice"));
  state = applyRemembered(state, commandJoinGame(state, "Bob"));
  state = applyRemembered(state, commandJoinGame(state, "Cora"));
  state = applyRemembered(state, commandSetReady(state, "Bob", true));
  state = applyRemembered(state, commandSetReady(state, "Cora", true));
  state = applyRemembered(state, commandStartGame(state, "Alice"));
  return state;
}

function startGameWithHandles(handles: string[]): RoomState {
  let state = reduceEvents(`test-room-${handles.length}`, []);
  for (const handle of handles) {
    state = applyRemembered(state, commandClaimHandle(state, handle));
  }
  state = applyRemembered(state, commandCreateGame(state, handles[0]!));
  for (const handle of handles.slice(1)) {
    state = applyRemembered(state, commandJoinGame(state, handle));
    state = applyRemembered(state, commandSetReady(state, handle, true));
  }
  return applyRemembered(state, commandStartGame(state, handles[0]!));
}

function submitFirstDepth(state: RoomState): RoomState {
  const game = activeGame(state)!;
  const round = currentRound(game)!;
  state = applyRemembered(state, commandChooseCategory(state, "Alice", round.categoryOptions[0]!));
  state = applyRemembered(state, commandSubmitAnswer(state, "Bob", "Bale"));
  state = applyRemembered(state, commandSubmitLetters(state, "Bob", new Map([[0, clampLetter("h")], [1, clampLetter("s")]])));
  state = applyRemembered(state, commandSubmitLetters(state, "Cora", new Map([[2, clampLetter("c")], [3, clampLetter("w")]])));
  return state;
}

function chooseCurrentCategoryAndAnswer(state: RoomState, answer: string): RoomState {
  const game = activeGame(state)!;
  const round = currentRound(game)!;
  state = applyRemembered(state, commandChooseCategory(state, round.guesserHandle, round.categoryOptions[0]!));
  return applyRemembered(state, commandSubmitAnswer(state, round.answerWriterHandle, answer));
}

function submitCurrentDepth(state: RoomState, letter = "A"): RoomState {
  const game = activeGame(state)!;
  const round = currentRound(game)!;
  const byHolder = new Map<string, Map<number, string>>();
  for (const row of round.rows) {
    const map = byHolder.get(row.currentHolderHandle) ?? new Map<number, string>();
    map.set(row.rowIndex, letter);
    byHolder.set(row.currentHolderHandle, map);
  }
  for (const [handle, letters] of byHolder) {
    state = applyRemembered(state, commandSubmitLetters(state, handle, letters));
  }
  return state;
}

function resolveCurrentRoundExactly(state: RoomState): RoomState {
  const game = activeGame(state)!;
  const round = currentRound(game)!;
  state = chooseCurrentCategoryAndAnswer(state, `Answer ${round.roundNumber}`);
  state = submitCurrentDepth(state, "S");
  return applyRemembered(state, commandGuess(state, round.guesserHandle, `answer ${round.roundNumber}`));
}

describe("room command model", () => {
  test("joins a room by handle with no auth and starts a three-player game", () => {
    const state = startThreePlayerGame();
    const game = activeGame(state)!;
    const round = currentRound(game)!;
    expect(game.players.map((player) => player.handle)).toEqual(["Alice", "Bob", "Cora"]);
    expect(game.totalRounds).toBe(6);
    expect(game.phase).toBe("category-choice");
    expect(round.guesserHandle).toBe("Alice");
    expect(round.answerWriterHandle).toBe("Bob");
  });

  test("handle claims are replayable room events", () => {
    let state = reduceEvents("presence-room", []);
    state = applyRemembered(state, commandClaimHandle(state, "Alice"));
    const createdAt = state.handles[0]!.createdAt;

    expect(state.handles).toHaveLength(1);
    expect(state.handles[0]!.createdAt).toBe(createdAt);
    expect(state.handles[0]!.lastSeenAt).toBe(createdAt);
  });

  test("game creation persists current rules version and category pack", () => {
    let state = reduceEvents("version-room", []);
    state = applyRemembered(state, commandClaimHandle(state, "Alice"));
    const created = commandCreateGame(state, "Alice");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected created game");
    const gameEvent = created.events.find((event) => event.type === "game.created")!;
    expect(gameEvent.payload.rulesVersion).toBe(RULES_VERSION);
    expect(gameEvent.payload.categoryPackId).toBe(DEFAULT_PACK_ID);

    state = applyRemembered(state, created);
    const game = activeGame(state)!;
    expect(game.rulesVersion).toBe(RULES_VERSION);
    expect(game.categoryPackId).toBe(DEFAULT_PACK_ID);
  });

  test("starts valid 4, 5, and 8 player games with expected round counts", () => {
    for (const count of [4, 5, 8]) {
      const handles = Array.from({ length: count }, (_, index) => `P${index + 1}`);
      const state = startGameWithHandles(handles);
      const game = activeGame(state)!;
      expect(game.players).toHaveLength(count);
      expect(game.totalRounds).toBe(count <= 4 ? count * 2 : count);
      expect(currentRound(game)?.rows).toHaveLength(0);
    }
  });

  test("only the guesser can choose one of the offered categories", () => {
    let state = startThreePlayerGame();
    const round = currentRound(activeGame(state)!)!;

    expect(commandChooseCategory(state, "Bob", round.categoryOptions[0]!).ok).toBe(false);
    expect(commandChooseCategory(state, "Alice", "not-an-offered-category").ok).toBe(false);

    state = applyRemembered(state, commandChooseCategory(state, "Alice", round.categoryOptions[0]!));
    const chosen = currentRound(activeGame(state)!)!;
    expect(chosen.categoryId).toBe(round.categoryOptions[0]);
    expect(chosen.phase).toBe("answer-entry");
  });

  test("only the answer writer can enter a non-empty answer once", () => {
    let state = startThreePlayerGame();
    const round = currentRound(activeGame(state)!)!;
    state = applyRemembered(state, commandChooseCategory(state, "Alice", round.categoryOptions[0]!));

    expect(commandSubmitAnswer(state, "Alice", "Bale").ok).toBe(false);
    expect(commandSubmitAnswer(state, "Cora", "Bale").ok).toBe(false);
    expect(commandSubmitAnswer(state, "Bob", "   ").ok).toBe(false);

    state = applyRemembered(state, commandSubmitAnswer(state, "Bob", "  Bale  "));
    const submitted = currentRound(activeGame(state)!)!;
    expect(submitted.answerRaw).toBe("Bale");
    expect(submitted.phase).toBe("letter-entry");
    expect(commandSubmitAnswer(state, "Bob", "Barn").ok).toBe(false);
  });

  test("host can reorder lobby seats before start and roles follow the new order", () => {
    let state = reduceEvents("seat-room", []);
    for (const handle of ["Alice", "Bob", "Cora"]) {
      state = applyRemembered(state, commandClaimHandle(state, handle));
    }
    state = applyRemembered(state, commandCreateGame(state, "Alice"));
    state = applyRemembered(state, commandJoinGame(state, "Bob"));
    state = applyRemembered(state, commandJoinGame(state, "Cora"));
    state = applyRemembered(state, commandSetReady(state, "Bob", true));
    state = applyRemembered(state, commandSetReady(state, "Cora", true));

    expect(commandMoveSeat(state, "Bob", "Cora", "up").ok).toBe(false);
    state = applyRemembered(state, commandMoveSeat(state, "Alice", "Cora", "up"));
    state = applyRemembered(state, commandMoveSeat(state, "Alice", "Cora", "up"));

    let game = activeGame(state)!;
    expect(game.players.map((player) => player.handle)).toEqual(["Cora", "Alice", "Bob"]);
    expect(game.players.find((player) => player.handle === "Alice")?.isHost).toBe(true);

    state = applyRemembered(state, commandStartGame(state, "Alice"));
    game = activeGame(state)!;
    expect(currentRound(game)?.guesserHandle).toBe("Cora");
    expect(currentRound(game)?.answerWriterHandle).toBe("Alice");
  });

  test("host can randomize lobby seats without changing membership", () => {
    let state = reduceEvents("random-seat-room", []);
    for (const handle of ["Alice", "Bob", "Cora", "Drew"]) {
      state = applyRemembered(state, commandClaimHandle(state, handle));
    }
    state = applyRemembered(state, commandCreateGame(state, "Alice"));
    for (const handle of ["Bob", "Cora", "Drew"]) {
      state = applyRemembered(state, commandJoinGame(state, handle));
      state = applyRemembered(state, commandSetReady(state, handle, true));
    }

    expect(commandRandomizeSeats(state, "Bob").ok).toBe(false);
    state = applyRemembered(state, commandRandomizeSeats(state, "Alice"));
    const game = activeGame(state)!;
    expect(new Set(game.players.map((player) => player.handle))).toEqual(new Set(["Alice", "Bob", "Cora", "Drew"]));
    expect(game.players.find((player) => player.handle === "Alice")?.isHost).toBe(true);

    state = applyRemembered(state, commandStartGame(state, "Alice"));
    expect(commandRandomizeSeats(state, "Alice").ok).toBe(false);
  });

  test("prevents non-holder letter entry and reveals atomically after all rows are submitted", () => {
    let state = startThreePlayerGame();
    const game = activeGame(state)!;
    const round = currentRound(game)!;
    state = applyRemembered(state, commandChooseCategory(state, "Alice", round.categoryOptions[0]!));
    state = applyRemembered(state, commandSubmitAnswer(state, "Bob", "Bale"));
    const aliceSubmit = commandSubmitLetters(state, "Alice", new Map([[0, "A"]]));
    expect(aliceSubmit.ok).toBe(false);
    expect(commandSubmitLetters(state, "Bob", new Map([[0, "hay"], [1, "S"]])).ok).toBe(false);
    expect(commandSubmitLetters(state, "Bob", new Map([[0, "!"], [1, "S"]])).ok).toBe(false);

    state = applyRemembered(state, commandSubmitLetters(state, "Bob", new Map([[0, "H"], [1, "T"]])));
    expect(currentRound(activeGame(state)!)!.phase).toBe("letter-entry");
    state = applyRemembered(state, commandSubmitLetters(state, "Cora", new Map([[2, "C"], [3, "W"]])));
    const revealed = currentRound(activeGame(state)!)!;
    expect(revealed.phase).toBe("guesser-call");
    expect(revealed.entries.every((entry) => entry.revealed)).toBe(true);
  });

  test("clue entries preserve display handle casing even when a client submits lower-case handle", () => {
    let state = startGameWithHandles(["Alice", "V", "Carrie"]);
    state = chooseCurrentCategoryAndAnswer(state, "Bale");
    state = applyRemembered(
      state,
      commandSubmitLetters(
        state,
        "v",
        new Map([
          [0, "c"],
          [1, "b"],
        ]),
      ),
    );
    const round = currentRound(activeGame(state)!)!;
    expect(round.entries.map((entry) => entry.handle)).toEqual(["V", "V"]);
    expect(round.entries.map((entry) => entry.letter)).toEqual(["C", "B"]);
  });

  test("a period marks the current clue cell and the row can continue later", () => {
    let state = chooseCurrentCategoryAndAnswer(startThreePlayerGame(), "Bale");
    state = applyRemembered(
      state,
      commandSubmitLetters(
        state,
        "Bob",
        new Map<number, { letter: string; endsWord: boolean }>([
          [0, { letter: "c", endsWord: true }],
          [1, { letter: "b", endsWord: false }],
        ]),
      ),
    );
    state = applyRemembered(state, commandSubmitLetters(state, "Cora", new Map([[2, "H"], [3, "W"]])));

    let round = currentRound(activeGame(state)!)!;
    expect(round.phase).toBe("guesser-call");
    expect(round.entries.find((entry) => entry.rowIndex === 0)?.endsWord).toBe(true);
    expect(round.entries.find((entry) => entry.rowIndex === 1)?.endsWord).toBe(false);

    state = applyRemembered(state, commandRequestMoreLetters(state, "Alice"));
    round = currentRound(activeGame(state)!)!;
    const nextHolderForEndedRow = round.rows.find((row) => row.rowIndex === 0)!.currentHolderHandle;
    expect(rowsHeldByClueGiver(round, nextHolderForEndedRow).some((row) => row.rowIndex === 0)).toBe(true);

    state = submitCurrentDepth(state, "A");
    round = currentRound(activeGame(state)!)!;
    expect(round.phase).toBe("guesser-call");
    expect(round.entries.filter((entry) => entry.rowIndex === 0)).toHaveLength(2);
    expect(round.entries.filter((entry) => entry.depth === 2)).toHaveLength(4);
  });

  test("a skipped clue cell is a stored blank and stays editable on later depths", () => {
    let state = chooseCurrentCategoryAndAnswer(startThreePlayerGame(), "Bale");
    const badSkipAndLetter = commandSubmitLetters(state, "Bob", new Map<number, string | ClueCellInput>([[0, { letter: "C", skipped: true }], [1, "B"]]));
    expect(badSkipAndLetter.ok).toBe(false);
    const badSkipAndEnd = commandSubmitLetters(state, "Bob", new Map<number, string | ClueCellInput>([[0, { skipped: true, endsWord: true }], [1, "B"]]));
    expect(badSkipAndEnd.ok).toBe(false);

    state = applyRemembered(state, commandSubmitLetters(state, "Bob", new Map<number, string | ClueCellInput>([[0, { skipped: true }], [1, "B"]])));
    state = applyRemembered(state, commandSubmitLetters(state, "Cora", new Map([[2, "H"], [3, "W"]])));

    let round = currentRound(activeGame(state)!)!;
    expect(round.phase).toBe("guesser-call");
    const skipped = round.entries.find((entry) => entry.rowIndex === 0)!;
    expect(skipped.skipped).toBe(true);
    expect(skipped.letter).toBe("");
    expect(skipped.endsWord).toBe(false);

    state = applyRemembered(state, commandRequestMoreLetters(state, "Alice"));
    round = currentRound(activeGame(state)!)!;
    const rowZeroHolder = round.rows.find((row) => row.rowIndex === 0)!.currentHolderHandle;
    expect(rowsHeldByClueGiver(round, rowZeroHolder).some((row) => row.rowIndex === 0)).toBe(true);
    expect(round.entries.filter((entry) => entry.rowIndex === 0)).toHaveLength(1);

    const partialFill = commandSubmitLetters(state, rowZeroHolder, new Map<number, string | ClueCellInput>([[0, "T"]]));
    expect(partialFill.ok).toBe(false);

    const heldRows = rowsHeldByClueGiver(round, rowZeroHolder);
    const fillEveryBlankAndAddOne = new Map<number, string | ClueCellInput>();
    for (const row of heldRows) {
      fillEveryBlankAndAddOne.set(
        row.rowIndex,
        row.rowIndex === 0
          ? { cells: [{ depth: 1, letter: "A" }, { depth: 2, letter: "T" }] }
          : { letter: "Q" },
      );
    }
    state = applyRemembered(state, commandSubmitLetters(state, rowZeroHolder, fillEveryBlankAndAddOne));
    round = currentRound(activeGame(state)!)!;
    const rowZeroEntries = round.entries.filter((entry) => entry.rowIndex === 0).sort((a, b) => a.depth - b.depth);
    expect(rowZeroEntries.map((entry) => entry.letter)).toEqual(["A", "T"]);
    expect(rowZeroEntries.map((entry) => entry.skipped)).toEqual([false, false]);
    expect(rowZeroEntries.map((entry) => entry.handle)).toEqual([rowZeroHolder, rowZeroHolder]);
    expect(rowZeroEntries.map((entry) => entry.filledAtDepth)).toEqual([2, 2]);
  });

  test("tryReveal resolves complete letter entry after stale clients submit without seeing each other", () => {
    let state = startThreePlayerGame();
    const game = activeGame(state)!;
    const round = currentRound(game)!;
    state = applyRemembered(state, commandChooseCategory(state, "Alice", round.categoryOptions[0]!));
    state = applyRemembered(state, commandSubmitAnswer(state, "Bob", "Bale"));

    const bobSubmit = commandSubmitLetters(state, "Bob", new Map([[0, "H"], [1, "S"]]));
    const coraSubmit = commandSubmitLetters(state, "Cora", new Map([[2, "C"], [3, "W"]]));
    expect(bobSubmit.ok).toBe(true);
    expect(coraSubmit.ok).toBe(true);
    if (!bobSubmit.ok || !coraSubmit.ok) throw new Error("expected stale letter entry commands");
    expect(bobSubmit.events.map((event) => event.type)).toEqual(["letters.submitted"]);
    expect(coraSubmit.events.map((event) => event.type)).toEqual(["letters.submitted"]);

    remember([...bobSubmit.events, ...coraSubmit.events]);
    state = reduceEvents(state.roomSlug, [...eventsFrom(state), ...bobSubmit.events, ...coraSubmit.events]);
    expect(currentRound(activeGame(state)!)!.phase).toBe("letter-entry");
    expect(currentRound(activeGame(state)!)!.entries).toHaveLength(4);

    state = applyRemembered(state, commandTryRevealLetters(state, "Alice"));
    const revealed = currentRound(activeGame(state)!)!;
    expect(revealed.phase).toBe("guesser-call");
    expect(revealed.entries.every((entry) => entry.revealed)).toBe(true);
  });

  test("tryReveal resolves simultaneous final letter entries at depth five", () => {
    let state = chooseCurrentCategoryAndAnswer(startThreePlayerGame(), "Bale");
    for (let depth = 1; depth < 5; depth += 1) {
      state = submitCurrentDepth(state, "B");
      state = applyRemembered(state, commandRequestMoreLetters(state, "Alice"));
    }

    const finalRound = currentRound(activeGame(state)!)!;
    expect(finalRound.phase).toBe("letter-entry");
    expect(finalRound.depth).toBe(5);

    const lettersByHolder = new Map<string, Map<number, string>>();
    for (const row of finalRound.rows) {
      const letters = lettersByHolder.get(row.currentHolderHandle) ?? new Map<number, string>();
      letters.set(row.rowIndex, "E");
      lettersByHolder.set(row.currentHolderHandle, letters);
    }

    const staleLetterEntries = [...lettersByHolder].map(([handle, letters]) => commandSubmitLetters(state, handle, letters));
    expect(staleLetterEntries.every((result) => result.ok)).toBe(true);
    for (const result of staleLetterEntries) {
      if (!result.ok) throw new Error("expected final letter entry command");
      expect(result.events.map((event) => event.type)).toEqual(["letters.submitted"]);
    }

    const letterEntryEvents = staleLetterEntries.flatMap((result) => (result.ok ? result.events : []));
    remember(letterEntryEvents);
    state = reduceEvents(state.roomSlug, [...eventsFrom(state), ...letterEntryEvents]);
    expect(currentRound(activeGame(state)!)!.phase).toBe("letter-entry");

    state = applyRemembered(state, commandTryRevealLetters(state, "Alice"));
    const revealed = currentRound(activeGame(state)!)!;
    expect(revealed.phase).toBe("guesser-call");
    expect(revealed.depth).toBe(5);
    expect(revealed.entries).toHaveLength(20);
    expect(revealed.entries.filter((entry) => entry.depth === 5).every((entry) => entry.revealed)).toBe(true);
    expect(commandRequestMoreLetters(state, "Alice").ok).toBe(false);
  });

  test("rejects stale phase events without side effects", () => {
    let state = submitFirstDepth(startThreePlayerGame());
    const game = activeGame(state)!;
    const round = currentRound(game)!;
    const stale = commandRequestMoreLetters(state, "Alice");
    expect(stale.ok).toBe(true);
    if (!stale.ok) throw new Error("expected request-more-letters event");
    const staleEvent = { ...stale.events[0]!, expectedPhaseVersion: game.phaseVersion - 1 };
    remember([staleEvent]);
    state = reduceEvents(state.roomSlug, [...eventsFrom(state), staleEvent]);
    const unchanged = currentRound(activeGame(state)!)!;
    expect(unchanged.depth).toBe(round.depth);
    expect(unchanged.phase).toBe("guesser-call");
  });

  test("duplicate action ids do not append duplicate letters", () => {
    let state = startThreePlayerGame();
    const game = activeGame(state)!;
    const round = currentRound(game)!;
    state = applyRemembered(state, commandChooseCategory(state, "Alice", round.categoryOptions[0]!));
    state = applyRemembered(state, commandSubmitAnswer(state, "Bob", "Bale"));
    const result = commandSubmitLetters(state, "Bob", new Map([[0, "H"], [1, "S"]]));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected letters");
    remember(result.events);
    state = reduceEvents(state.roomSlug, [...eventsFrom(state), ...result.events, ...result.events]);
    expect(currentRound(activeGame(state)!)!.entries).toHaveLength(2);
  });

  test("exact guess resolves, records points, advances history, and computes final score", () => {
    let state = submitFirstDepth(startThreePlayerGame());
    state = applyRemembered(state, commandGuess(state, "Alice", "bale"));
    let game = activeGame(state)!;
    let round = currentRound(game)!;
    expect(round.phase).toBe("round-recap");
    expect(round.accepted).toBe(true);
    expect(round.points).toBe(20);
    expect(finalScore(game)).toBe(20);

    state = applyRemembered(state, commandAdvanceRound(state, "Alice"));
    game = activeGame(state)!;
    expect(game.currentRoundNumber).toBe(2);
  });

  test("exact guesses handle accents, punctuation, digits, and multiple words conservatively", () => {
    let state = chooseCurrentCategoryAndAnswer(startThreePlayerGame(), "Café 24/7 Menu");
    state = submitCurrentDepth(state, "C");
    state = applyRemembered(state, commandGuess(state, "Alice", "  cafe\u0301 24/7 menu  "));
    const round = currentRound(activeGame(state)!)!;
    expect(round.phase).toBe("round-recap");
    expect(round.accepted).toBe(true);
    expect(round.points).toBe(20);
  });

  test("near miss routes to answer writer judging", () => {
    let state = submitFirstDepth(startThreePlayerGame());
    state = applyRemembered(state, commandGuess(state, "Alice", "hay bale"));
    expect(currentRound(activeGame(state)!)!.phase).toBe("guess-judging");
    expect(commandJudgeGuess(state, "Alice", true).ok).toBe(false);
    expect(commandJudgeGuess(state, "Cora", true).ok).toBe(false);
    state = applyRemembered(state, commandJudgeGuess(state, "Bob", true));
    const round = currentRound(activeGame(state)!)!;
    expect(round.phase).toBe("round-recap");
    expect(round.accepted).toBe(true);
    expect(round.points).toBe(20);
  });

  test("rejected judging resolves the round with zero points", () => {
    let state = submitFirstDepth(startThreePlayerGame());
    state = applyRemembered(state, commandGuess(state, "Alice", "hay bale"));
    state = applyRemembered(state, commandJudgeGuess(state, "Bob", false));
    const round = currentRound(activeGame(state)!)!;
    expect(round.phase).toBe("round-recap");
    expect(round.accepted).toBe(false);
    expect(round.points).toBe(0);
    expect(commandGuess(state, "Alice", "Bale").ok).toBe(false);
  });

  test("only the guesser can request more letters, guess, or pass from the guesser decision phase", () => {
    const state = submitFirstDepth(startThreePlayerGame());

    for (const clueGiver of ["Bob", "Cora"]) {
      expect(commandRequestMoreLetters(state, clueGiver).ok).toBe(false);
      expect(commandGuess(state, clueGiver, "Bale").ok).toBe(false);
      expect(commandPassRound(state, clueGiver).ok).toBe(false);
    }

    expect(commandGuess(state, "Alice", "   ").ok).toBe(false);
    expect(commandRequestMoreLetters(state, "Alice").ok).toBe(true);
    expect(commandGuess(state, "Alice", "Bale").ok).toBe(true);
    expect(commandPassRound(state, "Alice").ok).toBe(true);
  });

  test("correct command-flow guesses award configured points at depths one through five", () => {
    const expectedByDepth = [20, 10, 7, 5, 3];
    for (let targetDepth = 1; targetDepth <= 5; targetDepth += 1) {
      let state = chooseCurrentCategoryAndAnswer(startThreePlayerGame(), "Bale");
      for (let depth = 1; depth <= targetDepth; depth += 1) {
        state = submitCurrentDepth(state, "B");
        if (depth < targetDepth) {
          state = applyRemembered(state, commandRequestMoreLetters(state, "Alice"));
        }
      }
      state = applyRemembered(state, commandGuess(state, "Alice", "bale"));
      const round = currentRound(activeGame(state)!)!;
      expect(round.depth).toBe(targetDepth);
      expect(round.points).toBe(expectedByDepth[targetDepth - 1]);
    }
  });

  test("requesting more letters is rejected at five letters", () => {
    let state = submitFirstDepth(startThreePlayerGame());
    for (let depth = 2; depth <= 5; depth += 1) {
      state = applyRemembered(state, commandRequestMoreLetters(state, "Alice"));
      state = submitCurrentDepth(state);
    }
    expect(currentRound(activeGame(state)!)!.depth).toBe(5);
    expect(commandRequestMoreLetters(state, "Alice").ok).toBe(false);
    state = applyRemembered(state, commandPassRound(state, "Alice"));
    expect(currentRound(activeGame(state)!)!.points).toBe(0);
  });

  test("simultaneous Guess and reveal more letters resolves exactly one transition", () => {
    let state = submitFirstDepth(startThreePlayerGame());
    const game = activeGame(state)!;
    const requestMoreLetters = commandRequestMoreLetters(state, "Alice");
    const guess = commandGuess(state, "Alice", "Bale");
    expect(requestMoreLetters.ok).toBe(true);
    expect(guess.ok).toBe(true);
    if (!requestMoreLetters.ok || !guess.ok) throw new Error("expected both commands");

    const sameMoment = Math.max(requestMoreLetters.events[0]!.createdAt, guess.events[0]!.createdAt);
    const raced = [
      { ...guess.events[0]!, createdAt: sameMoment },
      { ...requestMoreLetters.events[0]!, createdAt: sameMoment },
    ];
    remember(raced);
    state = reduceEvents(state.roomSlug, [...eventsFrom(state), ...raced]);
    const round = currentRound(activeGame(state)!)!;
    expect(["round-recap", "letter-entry"]).toContain(round.phase);
    expect(round.phase === "round-recap" ? round.points : round.depth).toBe(round.phase === "round-recap" ? 20 : 2);
  });

  test("host can pause, resume, transfer host, and void an active round", () => {
    let state = startThreePlayerGame();
    state = applyRemembered(state, commandPauseGame(state, "Alice"));
    expect(activeGame(state)!.pausedAt).toBeNumber();
    expect(commandChooseCategory(state, "Alice", currentRound(activeGame(state)!)!.categoryOptions[0]!).ok).toBe(false);

    state = applyRemembered(state, commandTransferHost(state, "Alice", "Bob"));
    expect(activeGame(state)!.hostHandle).toBe("Bob");
    expect(commandResumeGame(state, "Alice").ok).toBe(false);
    state = applyRemembered(state, commandResumeGame(state, "Bob"));
    expect(activeGame(state)!.pausedAt).toBeUndefined();

    state = applyRemembered(state, commandVoidRound(state, "Bob"));
    const game = activeGame(state)!;
    const round = currentRound(game)!;
    expect(round.status).toBe("void");
    expect(round.points).toBe(0);
    expect(game.roundPoints).toEqual([0]);

    state = applyRemembered(state, commandAdvanceRound(state, "Bob"));
    const advanced = activeGame(state)!;
    expect(advanced.roundPoints).toEqual([0]);
    expect(advanced.rounds[0]?.status).toBe("void");
    expect(currentRound(advanced)?.roundNumber).toBe(2);
    expect(currentRound(advanced)?.phase).toBe("category-choice");
  });

  test("a seated player can claim host only after the current host is offline", () => {
    let state = startThreePlayerGame();
    expect(commandClaimHost(state, "Bob").ok).toBe(false);
    expect(commandClaimHost(state, "Drew").ok).toBe(false);

    const host = state.handles.find((handle) => handle.normalizedHandle === "alice")!;
    host.lastSeenAt = Date.now() - HOST_RECOVERY_OFFLINE_MS - 1;

    state = applyRemembered(state, commandClaimHost(state, "Bob"));
    const game = activeGame(state)!;
    expect(game.hostHandle).toBe("Bob");
    expect(game.players.find((player) => player.handle === "Bob")?.isHost).toBe(true);
    expect(game.players.find((player) => player.handle === "Alice")?.isHost).toBe(false);
  });

  test("completes all rounds and preserves finished game in Room history", () => {
    let state = startThreePlayerGame();
    for (let i = 0; i < 6; i += 1) {
      state = resolveCurrentRoundExactly(state);
      const game = activeGame(state)!;
      state = applyRemembered(state, commandAdvanceRound(state, game.hostHandle));
    }
    expect(activeGame(state)?.status).toBe("complete");
    const complete = state.games.find((game) => game.status === "complete")!;
    expect(complete.rounds).toHaveLength(6);
    expect(complete.roundPoints).toEqual([20, 20, 20, 20, 20, 20]);
    expect(finalScore(complete)).toBe(100);
    expect(complete.completedAt).toBeNumber();

    state = applyRemembered(state, commandCreateGame(state, "Alice"));
    const rematch = activeGame(state)!;
    expect(rematch.status).toBe("lobby");
    expect(rematch.id).not.toBe(complete.id);
    expect(state.games.find((game) => game.id === complete.id)?.status).toBe("complete");
  });
});
