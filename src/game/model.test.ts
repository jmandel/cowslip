import { describe, expect, test } from "bun:test";
import { DEFAULT_PACK_ID, RULES_VERSION } from "../config";
import {
  activeGame,
  commandAdjudicate,
  commandAdvanceAfterRecap,
  commandClaimHost,
  commandChooseField,
  commandClaimHandle,
  commandCreateSeason,
  commandGuess,
  commandJoinSeason,
  commandMarkHandleSeen,
  commandMoveSeat,
  commandPauseSeason,
  commandPlantLetters,
  commandPlantSeed,
  commandRandomizeSeats,
  commandResumeSeason,
  commandSetReady,
  commandSpoil,
  commandStartSeason,
  commandTransferHost,
  commandTrySprout,
  commandVoidHarvest,
  commandWait,
  currentRound,
  finalScore,
  HOST_RECOVERY_OFFLINE_MS,
  reduceEvents,
  rowsHeldForClue,
} from "./model";
import { clampLetter } from "./rules";
import type { ClueCellInput, CommandResult, RoomState, SowsEarEvent } from "./types";

function apply(state: RoomState, result: CommandResult): RoomState {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return reduceEvents(state.roomSlug, [...eventsFrom(state), ...result.events]);
}

function eventsFrom(state: RoomState): SowsEarEvent[] {
  return [...state.appliedActionIds].map((actionId) => (globalThis as any).__events[actionId]).filter(Boolean);
}

function remember(events: SowsEarEvent[]): void {
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
  state = applyRemembered(state, commandCreateSeason(state, "Alice"));
  state = applyRemembered(state, commandJoinSeason(state, "Bob"));
  state = applyRemembered(state, commandJoinSeason(state, "Cora"));
  state = applyRemembered(state, commandSetReady(state, "Bob", true));
  state = applyRemembered(state, commandSetReady(state, "Cora", true));
  state = applyRemembered(state, commandStartSeason(state, "Alice"));
  return state;
}

function startGameWithHandles(handles: string[]): RoomState {
  let state = reduceEvents(`test-room-${handles.length}`, []);
  for (const handle of handles) {
    state = applyRemembered(state, commandClaimHandle(state, handle));
  }
  state = applyRemembered(state, commandCreateSeason(state, handles[0]!));
  for (const handle of handles.slice(1)) {
    state = applyRemembered(state, commandJoinSeason(state, handle));
    state = applyRemembered(state, commandSetReady(state, handle, true));
  }
  return applyRemembered(state, commandStartSeason(state, handles[0]!));
}

function plantFirstDepth(state: RoomState): RoomState {
  const game = activeGame(state)!;
  const round = currentRound(game)!;
  state = applyRemembered(state, commandChooseField(state, "Alice", round.fieldOptions[0]!));
  state = applyRemembered(state, commandPlantSeed(state, "Bob", "Bale"));
  state = applyRemembered(state, commandPlantLetters(state, "Bob", new Map([[0, clampLetter("h")], [1, clampLetter("s")]])));
  state = applyRemembered(state, commandPlantLetters(state, "Cora", new Map([[2, clampLetter("c")], [3, clampLetter("w")]])));
  return state;
}

function chooseCurrentFieldAndSeed(state: RoomState, seed: string): RoomState {
  const game = activeGame(state)!;
  const round = currentRound(game)!;
  state = applyRemembered(state, commandChooseField(state, round.farmerHandle, round.fieldOptions[0]!));
  return applyRemembered(state, commandPlantSeed(state, round.sowerHandle, seed));
}

function plantCurrentDepth(state: RoomState, letter = "A"): RoomState {
  const game = activeGame(state)!;
  const round = currentRound(game)!;
  const byHolder = new Map<string, Map<number, string>>();
  for (const row of round.rows) {
    const map = byHolder.get(row.currentHolderHandle) ?? new Map<number, string>();
    map.set(row.rowIndex, letter);
    byHolder.set(row.currentHolderHandle, map);
  }
  for (const [handle, letters] of byHolder) {
    state = applyRemembered(state, commandPlantLetters(state, handle, letters));
  }
  return state;
}

function resolveCurrentRoundExactly(state: RoomState): RoomState {
  const game = activeGame(state)!;
  const round = currentRound(game)!;
  state = chooseCurrentFieldAndSeed(state, `Seed ${round.roundNumber}`);
  state = plantCurrentDepth(state, "S");
  return applyRemembered(state, commandGuess(state, round.farmerHandle, `seed ${round.roundNumber}`));
}

describe("room command model", () => {
  test("joins a room by handle with no auth and starts a three-player game", () => {
    const state = startThreePlayerGame();
    const game = activeGame(state)!;
    const round = currentRound(game)!;
    expect(game.players.map((player) => player.handle)).toEqual(["Alice", "Bob", "Cora"]);
    expect(game.totalHarvests).toBe(6);
    expect(game.phase).toBe("field-choice");
    expect(round.farmerHandle).toBe("Alice");
    expect(round.sowerHandle).toBe("Bob");
  });

  test("handle seen events update room-local presence without changing the claim time", () => {
    let state = reduceEvents("presence-room", []);
    state = applyRemembered(state, commandClaimHandle(state, "Alice"));
    const createdAt = state.handles[0]!.createdAt;
    const firstSeenAt = state.handles[0]!.lastSeenAt;

    state = applyRemembered(state, commandMarkHandleSeen(state, "Alice"));
    expect(state.handles).toHaveLength(1);
    expect(state.handles[0]!.createdAt).toBe(createdAt);
    expect(state.handles[0]!.lastSeenAt).toBeGreaterThan(firstSeenAt);
  });

  test("season creation persists current rules version and field pack", () => {
    let state = reduceEvents("version-room", []);
    state = applyRemembered(state, commandClaimHandle(state, "Alice"));
    const created = commandCreateSeason(state, "Alice");
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected created game");
    const seasonEvent = created.events.find((event) => event.type === "season.created")!;
    expect(seasonEvent.payload.rulesVersion).toBe(RULES_VERSION);
    expect(seasonEvent.payload.fieldPackId).toBe(DEFAULT_PACK_ID);

    state = applyRemembered(state, created);
    const game = activeGame(state)!;
    expect(game.rulesVersion).toBe(RULES_VERSION);
    expect(game.fieldPackId).toBe(DEFAULT_PACK_ID);
  });

  test("legacy season-created events preserve their rules version for migration", () => {
    const legacy: SowsEarEvent = {
      actionId: "legacy-season",
      type: "season.created",
      roomSlug: "legacy-room",
      actorHandle: "Alice",
      gameId: "legacy-game",
      createdAt: 100,
      payload: {
        gameId: "legacy-game",
        hostHandle: "Alice",
        rulesVersion: "sows-ear-0.2",
        fieldPackId: "starter-fields-legacy",
      },
    };
    const state = reduceEvents("legacy-room", [legacy]);
    const game = activeGame(state)!;
    expect(game.rulesVersion).toBe("sows-ear-0.2");
    expect(game.fieldPackId).toBe("starter-fields-legacy");
  });

  test("starts valid 4, 5, and 8 player games with expected round counts", () => {
    for (const count of [4, 5, 8]) {
      const handles = Array.from({ length: count }, (_, index) => `P${index + 1}`);
      const state = startGameWithHandles(handles);
      const game = activeGame(state)!;
      expect(game.players).toHaveLength(count);
      expect(game.totalHarvests).toBe(count <= 4 ? count * 2 : count);
      expect(currentRound(game)?.rows).toHaveLength(0);
    }
  });

  test("only the guesser can choose one of the offered categories", () => {
    let state = startThreePlayerGame();
    const round = currentRound(activeGame(state)!)!;

    expect(commandChooseField(state, "Bob", round.fieldOptions[0]!).ok).toBe(false);
    expect(commandChooseField(state, "Alice", "not-an-offered-field").ok).toBe(false);

    state = applyRemembered(state, commandChooseField(state, "Alice", round.fieldOptions[0]!));
    const chosen = currentRound(activeGame(state)!)!;
    expect(chosen.fieldId).toBe(round.fieldOptions[0]);
    expect(chosen.phase).toBe("seed");
  });

  test("only the picker can enter a non-empty answer once", () => {
    let state = startThreePlayerGame();
    const round = currentRound(activeGame(state)!)!;
    state = applyRemembered(state, commandChooseField(state, "Alice", round.fieldOptions[0]!));

    expect(commandPlantSeed(state, "Alice", "Bale").ok).toBe(false);
    expect(commandPlantSeed(state, "Cora", "Bale").ok).toBe(false);
    expect(commandPlantSeed(state, "Bob", "   ").ok).toBe(false);

    state = applyRemembered(state, commandPlantSeed(state, "Bob", "  Bale  "));
    const planted = currentRound(activeGame(state)!)!;
    expect(planted.seedRaw).toBe("Bale");
    expect(planted.phase).toBe("planting");
    expect(commandPlantSeed(state, "Bob", "Barn").ok).toBe(false);
  });

  test("host can reorder lobby seats before start and roles follow the new order", () => {
    let state = reduceEvents("seat-room", []);
    for (const handle of ["Alice", "Bob", "Cora"]) {
      state = applyRemembered(state, commandClaimHandle(state, handle));
    }
    state = applyRemembered(state, commandCreateSeason(state, "Alice"));
    state = applyRemembered(state, commandJoinSeason(state, "Bob"));
    state = applyRemembered(state, commandJoinSeason(state, "Cora"));
    state = applyRemembered(state, commandSetReady(state, "Bob", true));
    state = applyRemembered(state, commandSetReady(state, "Cora", true));

    expect(commandMoveSeat(state, "Bob", "Cora", "up").ok).toBe(false);
    state = applyRemembered(state, commandMoveSeat(state, "Alice", "Cora", "up"));
    state = applyRemembered(state, commandMoveSeat(state, "Alice", "Cora", "up"));

    let game = activeGame(state)!;
    expect(game.players.map((player) => player.handle)).toEqual(["Cora", "Alice", "Bob"]);
    expect(game.players.find((player) => player.handle === "Alice")?.isHost).toBe(true);

    state = applyRemembered(state, commandStartSeason(state, "Alice"));
    game = activeGame(state)!;
    expect(currentRound(game)?.farmerHandle).toBe("Cora");
    expect(currentRound(game)?.sowerHandle).toBe("Alice");
  });

  test("host can randomize lobby seats without changing membership", () => {
    let state = reduceEvents("random-seat-room", []);
    for (const handle of ["Alice", "Bob", "Cora", "Drew"]) {
      state = applyRemembered(state, commandClaimHandle(state, handle));
    }
    state = applyRemembered(state, commandCreateSeason(state, "Alice"));
    for (const handle of ["Bob", "Cora", "Drew"]) {
      state = applyRemembered(state, commandJoinSeason(state, handle));
      state = applyRemembered(state, commandSetReady(state, handle, true));
    }

    expect(commandRandomizeSeats(state, "Bob").ok).toBe(false);
    state = applyRemembered(state, commandRandomizeSeats(state, "Alice"));
    const game = activeGame(state)!;
    expect(new Set(game.players.map((player) => player.handle))).toEqual(new Set(["Alice", "Bob", "Cora", "Drew"]));
    expect(game.players.find((player) => player.handle === "Alice")?.isHost).toBe(true);

    state = applyRemembered(state, commandStartSeason(state, "Alice"));
    expect(commandRandomizeSeats(state, "Alice").ok).toBe(false);
  });

  test("prevents non-holder planting and sprouts atomically after all rows are planted", () => {
    let state = startThreePlayerGame();
    const game = activeGame(state)!;
    const round = currentRound(game)!;
    state = applyRemembered(state, commandChooseField(state, "Alice", round.fieldOptions[0]!));
    state = applyRemembered(state, commandPlantSeed(state, "Bob", "Bale"));
    const alicePlant = commandPlantLetters(state, "Alice", new Map([[0, "A"]]));
    expect(alicePlant.ok).toBe(false);
    expect(commandPlantLetters(state, "Bob", new Map([[0, "hay"], [1, "S"]])).ok).toBe(false);
    expect(commandPlantLetters(state, "Bob", new Map([[0, "!"], [1, "S"]])).ok).toBe(false);

    state = applyRemembered(state, commandPlantLetters(state, "Bob", new Map([[0, "H"], [1, "T"]])));
    expect(currentRound(activeGame(state)!)!.phase).toBe("planting");
    state = applyRemembered(state, commandPlantLetters(state, "Cora", new Map([[2, "C"], [3, "W"]])));
    const sprouted = currentRound(activeGame(state)!)!;
    expect(sprouted.phase).toBe("farmer-call");
    expect(sprouted.entries.every((entry) => entry.sprouted)).toBe(true);
  });

  test("clue entries preserve display handle casing even when a client submits lower-case handle", () => {
    let state = startGameWithHandles(["Alice", "V", "Carrie"]);
    state = chooseCurrentFieldAndSeed(state, "Bale");
    state = applyRemembered(
      state,
      commandPlantLetters(
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

  test("a period marks the current clue cell as complete and prevents later appends to that row", () => {
    let state = chooseCurrentFieldAndSeed(startThreePlayerGame(), "Bale");
    state = applyRemembered(
      state,
      commandPlantLetters(
        state,
        "Bob",
        new Map<number, { letter: string; endsWord: boolean }>([
          [0, { letter: "c", endsWord: true }],
          [1, { letter: "b", endsWord: false }],
        ]),
      ),
    );
    state = applyRemembered(state, commandPlantLetters(state, "Cora", new Map([[2, "H"], [3, "W"]])));

    let round = currentRound(activeGame(state)!)!;
    expect(round.phase).toBe("farmer-call");
    expect(round.entries.find((entry) => entry.rowIndex === 0)?.endsWord).toBe(true);
    expect(round.entries.find((entry) => entry.rowIndex === 1)?.endsWord).toBe(false);

    state = applyRemembered(state, commandWait(state, "Alice"));
    round = currentRound(activeGame(state)!)!;
    const nextHolderForEndedRow = round.rows.find((row) => row.rowIndex === 0)!.currentHolderHandle;
    expect(rowsHeldForClue(round, nextHolderForEndedRow).some((row) => row.rowIndex === 0)).toBe(false);

    state = plantCurrentDepth(state, "A");
    round = currentRound(activeGame(state)!)!;
    expect(round.phase).toBe("farmer-call");
    expect(round.entries.filter((entry) => entry.rowIndex === 0)).toHaveLength(1);
    expect(round.entries.filter((entry) => entry.depth === 2)).toHaveLength(3);
  });

  test("a skipped clue cell is a stored blank and stays editable on later depths", () => {
    let state = chooseCurrentFieldAndSeed(startThreePlayerGame(), "Bale");
    const badSkipAndLetter = commandPlantLetters(state, "Bob", new Map<number, string | ClueCellInput>([[0, { letter: "C", skipped: true }], [1, "B"]]));
    expect(badSkipAndLetter.ok).toBe(false);
    const badSkipAndEnd = commandPlantLetters(state, "Bob", new Map<number, string | ClueCellInput>([[0, { skipped: true, endsWord: true }], [1, "B"]]));
    expect(badSkipAndEnd.ok).toBe(false);

    state = applyRemembered(state, commandPlantLetters(state, "Bob", new Map<number, string | ClueCellInput>([[0, { skipped: true }], [1, "B"]])));
    state = applyRemembered(state, commandPlantLetters(state, "Cora", new Map([[2, "H"], [3, "W"]])));

    let round = currentRound(activeGame(state)!)!;
    expect(round.phase).toBe("farmer-call");
    const skipped = round.entries.find((entry) => entry.rowIndex === 0)!;
    expect(skipped.skipped).toBe(true);
    expect(skipped.letter).toBe("");
    expect(skipped.endsWord).toBe(false);

    state = applyRemembered(state, commandWait(state, "Alice"));
    round = currentRound(activeGame(state)!)!;
    const rowZeroHolder = round.rows.find((row) => row.rowIndex === 0)!.currentHolderHandle;
    expect(rowsHeldForClue(round, rowZeroHolder).some((row) => row.rowIndex === 0)).toBe(true);
    expect(round.entries.filter((entry) => entry.rowIndex === 0)).toHaveLength(1);

    const partialFill = commandPlantLetters(state, rowZeroHolder, new Map<number, string | ClueCellInput>([[0, "T"]]));
    expect(partialFill.ok).toBe(false);

    const heldRows = rowsHeldForClue(round, rowZeroHolder);
    const fillEveryBlankAndAddOne = new Map<number, string | ClueCellInput>();
    for (const row of heldRows) {
      fillEveryBlankAndAddOne.set(
        row.rowIndex,
        row.rowIndex === 0
          ? { cells: [{ depth: 1, letter: "A" }, { depth: 2, letter: "T" }] }
          : { letter: "Q" },
      );
    }
    state = applyRemembered(state, commandPlantLetters(state, rowZeroHolder, fillEveryBlankAndAddOne));
    round = currentRound(activeGame(state)!)!;
    const rowZeroEntries = round.entries.filter((entry) => entry.rowIndex === 0).sort((a, b) => a.depth - b.depth);
    expect(rowZeroEntries.map((entry) => entry.letter)).toEqual(["A", "T"]);
    expect(rowZeroEntries.map((entry) => entry.skipped)).toEqual([false, false]);
    expect(rowZeroEntries.map((entry) => entry.handle)).toEqual([rowZeroHolder, rowZeroHolder]);
    expect(rowZeroEntries.map((entry) => entry.filledAtDepth)).toEqual([2, 2]);
  });

  test("trySprout resolves complete planting after stale clients submit without seeing each other", () => {
    let state = startThreePlayerGame();
    const game = activeGame(state)!;
    const round = currentRound(game)!;
    state = applyRemembered(state, commandChooseField(state, "Alice", round.fieldOptions[0]!));
    state = applyRemembered(state, commandPlantSeed(state, "Bob", "Bale"));

    const bobPlant = commandPlantLetters(state, "Bob", new Map([[0, "H"], [1, "S"]]));
    const coraPlant = commandPlantLetters(state, "Cora", new Map([[2, "C"], [3, "W"]]));
    expect(bobPlant.ok).toBe(true);
    expect(coraPlant.ok).toBe(true);
    if (!bobPlant.ok || !coraPlant.ok) throw new Error("expected stale planting commands");
    expect(bobPlant.events.map((event) => event.type)).toEqual(["letters.planted"]);
    expect(coraPlant.events.map((event) => event.type)).toEqual(["letters.planted"]);

    remember([...bobPlant.events, ...coraPlant.events]);
    state = reduceEvents(state.roomSlug, [...eventsFrom(state), ...bobPlant.events, ...coraPlant.events]);
    expect(currentRound(activeGame(state)!)!.phase).toBe("planting");
    expect(currentRound(activeGame(state)!)!.entries).toHaveLength(4);

    state = applyRemembered(state, commandTrySprout(state, "Alice"));
    const sprouted = currentRound(activeGame(state)!)!;
    expect(sprouted.phase).toBe("farmer-call");
    expect(sprouted.entries.every((entry) => entry.sprouted)).toBe(true);
  });

  test("trySprout resolves simultaneous final plantings at depth five", () => {
    let state = chooseCurrentFieldAndSeed(startThreePlayerGame(), "Bale");
    for (let depth = 1; depth < 5; depth += 1) {
      state = plantCurrentDepth(state, "B");
      state = applyRemembered(state, commandWait(state, "Alice"));
    }

    const finalRound = currentRound(activeGame(state)!)!;
    expect(finalRound.phase).toBe("planting");
    expect(finalRound.depth).toBe(5);

    const lettersByHolder = new Map<string, Map<number, string>>();
    for (const row of finalRound.rows) {
      const letters = lettersByHolder.get(row.currentHolderHandle) ?? new Map<number, string>();
      letters.set(row.rowIndex, "E");
      lettersByHolder.set(row.currentHolderHandle, letters);
    }

    const stalePlantings = [...lettersByHolder].map(([handle, letters]) => commandPlantLetters(state, handle, letters));
    expect(stalePlantings.every((result) => result.ok)).toBe(true);
    for (const result of stalePlantings) {
      if (!result.ok) throw new Error("expected final planting command");
      expect(result.events.map((event) => event.type)).toEqual(["letters.planted"]);
    }

    const plantingEvents = stalePlantings.flatMap((result) => (result.ok ? result.events : []));
    remember(plantingEvents);
    state = reduceEvents(state.roomSlug, [...eventsFrom(state), ...plantingEvents]);
    expect(currentRound(activeGame(state)!)!.phase).toBe("planting");

    state = applyRemembered(state, commandTrySprout(state, "Alice"));
    const sprouted = currentRound(activeGame(state)!)!;
    expect(sprouted.phase).toBe("farmer-call");
    expect(sprouted.depth).toBe(5);
    expect(sprouted.entries).toHaveLength(20);
    expect(sprouted.entries.filter((entry) => entry.depth === 5).every((entry) => entry.sprouted)).toBe(true);
    expect(commandWait(state, "Alice").ok).toBe(false);
  });

  test("rejects stale phase events without side effects", () => {
    let state = plantFirstDepth(startThreePlayerGame());
    const game = activeGame(state)!;
    const round = currentRound(game)!;
    const stale = commandWait(state, "Alice");
    expect(stale.ok).toBe(true);
    if (!stale.ok) throw new Error("expected wait event");
    const staleEvent = { ...stale.events[0]!, expectedPhaseVersion: game.phaseVersion - 1 };
    remember([staleEvent]);
    state = reduceEvents(state.roomSlug, [...eventsFrom(state), staleEvent]);
    const unchanged = currentRound(activeGame(state)!)!;
    expect(unchanged.depth).toBe(round.depth);
    expect(unchanged.phase).toBe("farmer-call");
  });

  test("duplicate action ids do not append duplicate letters", () => {
    let state = startThreePlayerGame();
    const game = activeGame(state)!;
    const round = currentRound(game)!;
    state = applyRemembered(state, commandChooseField(state, "Alice", round.fieldOptions[0]!));
    state = applyRemembered(state, commandPlantSeed(state, "Bob", "Bale"));
    const result = commandPlantLetters(state, "Bob", new Map([[0, "H"], [1, "S"]]));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected letters");
    remember(result.events);
    state = reduceEvents(state.roomSlug, [...eventsFrom(state), ...result.events, ...result.events]);
    expect(currentRound(activeGame(state)!)!.entries).toHaveLength(2);
  });

  test("exact guess resolves, records points, advances history, and computes final score", () => {
    let state = plantFirstDepth(startThreePlayerGame());
    state = applyRemembered(state, commandGuess(state, "Alice", "bale"));
    let game = activeGame(state)!;
    let round = currentRound(game)!;
    expect(round.phase).toBe("harvest-recap");
    expect(round.accepted).toBe(true);
    expect(round.ribbon).toBe(20);
    expect(finalScore(game)).toBe(20);

    state = applyRemembered(state, commandAdvanceAfterRecap(state, "Alice"));
    game = activeGame(state)!;
    expect(game.currentRoundNumber).toBe(2);
  });

  test("exact guesses handle accents, punctuation, digits, and multiple words conservatively", () => {
    let state = chooseCurrentFieldAndSeed(startThreePlayerGame(), "Café 24/7 Menu");
    state = plantCurrentDepth(state, "C");
    state = applyRemembered(state, commandGuess(state, "Alice", "  cafe\u0301 24/7 menu  "));
    const round = currentRound(activeGame(state)!)!;
    expect(round.phase).toBe("harvest-recap");
    expect(round.accepted).toBe(true);
    expect(round.ribbon).toBe(20);
  });

  test("near miss routes to picker adjudication", () => {
    let state = plantFirstDepth(startThreePlayerGame());
    state = applyRemembered(state, commandGuess(state, "Alice", "hay bale"));
    expect(currentRound(activeGame(state)!)!.phase).toBe("adjudication");
    expect(commandAdjudicate(state, "Alice", true).ok).toBe(false);
    expect(commandAdjudicate(state, "Cora", true).ok).toBe(false);
    state = applyRemembered(state, commandAdjudicate(state, "Bob", true));
    const round = currentRound(activeGame(state)!)!;
    expect(round.phase).toBe("harvest-recap");
    expect(round.accepted).toBe(true);
    expect(round.ribbon).toBe(20);
  });

  test("rejected adjudication resolves the round with zero points", () => {
    let state = plantFirstDepth(startThreePlayerGame());
    state = applyRemembered(state, commandGuess(state, "Alice", "hay bale"));
    state = applyRemembered(state, commandAdjudicate(state, "Bob", false));
    const round = currentRound(activeGame(state)!)!;
    expect(round.phase).toBe("harvest-recap");
    expect(round.accepted).toBe(false);
    expect(round.ribbon).toBe(0);
    expect(commandGuess(state, "Alice", "Bale").ok).toBe(false);
  });

  test("only the guesser can wait, guess, or pass from the guesser decision phase", () => {
    const state = plantFirstDepth(startThreePlayerGame());

    for (const hand of ["Bob", "Cora"]) {
      expect(commandWait(state, hand).ok).toBe(false);
      expect(commandGuess(state, hand, "Bale").ok).toBe(false);
      expect(commandSpoil(state, hand).ok).toBe(false);
    }

    expect(commandGuess(state, "Alice", "   ").ok).toBe(false);
    expect(commandWait(state, "Alice").ok).toBe(true);
    expect(commandGuess(state, "Alice", "Bale").ok).toBe(true);
    expect(commandSpoil(state, "Alice").ok).toBe(true);
  });

  test("correct command-flow guesses award configured points at depths one through five", () => {
    const expectedByDepth = [20, 10, 7, 5, 3];
    for (let targetDepth = 1; targetDepth <= 5; targetDepth += 1) {
      let state = chooseCurrentFieldAndSeed(startThreePlayerGame(), "Bale");
      for (let depth = 1; depth <= targetDepth; depth += 1) {
        state = plantCurrentDepth(state, "B");
        if (depth < targetDepth) {
          state = applyRemembered(state, commandWait(state, "Alice"));
        }
      }
      state = applyRemembered(state, commandGuess(state, "Alice", "bale"));
      const round = currentRound(activeGame(state)!)!;
      expect(round.depth).toBe(targetDepth);
      expect(round.ribbon).toBe(expectedByDepth[targetDepth - 1]);
    }
  });

  test("wait is rejected at five letters", () => {
    let state = plantFirstDepth(startThreePlayerGame());
    for (let depth = 2; depth <= 5; depth += 1) {
      state = applyRemembered(state, commandWait(state, "Alice"));
      state = plantCurrentDepth(state);
    }
    expect(currentRound(activeGame(state)!)!.depth).toBe(5);
    expect(commandWait(state, "Alice").ok).toBe(false);
    state = applyRemembered(state, commandSpoil(state, "Alice"));
    expect(currentRound(activeGame(state)!)!.ribbon).toBe(0);
  });

  test("simultaneous Guess and Wait resolves exactly one transition", () => {
    let state = plantFirstDepth(startThreePlayerGame());
    const game = activeGame(state)!;
    const wait = commandWait(state, "Alice");
    const guess = commandGuess(state, "Alice", "Bale");
    expect(wait.ok).toBe(true);
    expect(guess.ok).toBe(true);
    if (!wait.ok || !guess.ok) throw new Error("expected both commands");

    const sameMoment = Math.max(wait.events[0]!.createdAt, guess.events[0]!.createdAt);
    const raced = [
      { ...guess.events[0]!, createdAt: sameMoment },
      { ...wait.events[0]!, createdAt: sameMoment },
    ];
    remember(raced);
    state = reduceEvents(state.roomSlug, [...eventsFrom(state), ...raced]);
    const round = currentRound(activeGame(state)!)!;
    expect(["harvest-recap", "planting"]).toContain(round.phase);
    expect(round.phase === "harvest-recap" ? round.ribbon : round.depth).toBe(round.phase === "harvest-recap" ? 20 : 2);
  });

  test("host can pause, resume, transfer host, and void an active round", () => {
    let state = startThreePlayerGame();
    state = applyRemembered(state, commandPauseSeason(state, "Alice"));
    expect(activeGame(state)!.pausedAt).toBeNumber();
    expect(commandChooseField(state, "Alice", currentRound(activeGame(state)!)!.fieldOptions[0]!).ok).toBe(false);

    state = applyRemembered(state, commandTransferHost(state, "Alice", "Bob"));
    expect(activeGame(state)!.hostHandle).toBe("Bob");
    expect(commandResumeSeason(state, "Alice").ok).toBe(false);
    state = applyRemembered(state, commandResumeSeason(state, "Bob"));
    expect(activeGame(state)!.pausedAt).toBeUndefined();

    state = applyRemembered(state, commandVoidHarvest(state, "Bob"));
    const game = activeGame(state)!;
    const round = currentRound(game)!;
    expect(round.status).toBe("void");
    expect(round.ribbon).toBe(0);
    expect(game.ribbons).toEqual([0]);

    state = applyRemembered(state, commandAdvanceAfterRecap(state, "Bob"));
    const advanced = activeGame(state)!;
    expect(advanced.ribbons).toEqual([0]);
    expect(advanced.rounds[0]?.status).toBe("void");
    expect(currentRound(advanced)?.roundNumber).toBe(2);
    expect(currentRound(advanced)?.phase).toBe("field-choice");
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
      state = applyRemembered(state, commandAdvanceAfterRecap(state, game.hostHandle));
    }
    expect(activeGame(state)?.status).toBe("complete");
    const complete = state.games.find((game) => game.status === "complete")!;
    expect(complete.rounds).toHaveLength(6);
    expect(complete.ribbons).toEqual([20, 20, 20, 20, 20, 20]);
    expect(finalScore(complete)).toBe(100);
    expect(complete.completedAt).toBeNumber();

    state = applyRemembered(state, commandCreateSeason(state, "Alice"));
    const rematch = activeGame(state)!;
    expect(rematch.status).toBe("lobby");
    expect(rematch.id).not.toBe(complete.id);
    expect(state.games.find((game) => game.id === complete.id)?.status).toBe("complete");
  });
});
