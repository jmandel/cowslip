import { STARTER_FIELDS, fieldLabel } from "./content/fields";
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
  commandPauseSeason,
  commandPlantLetters,
  commandPlantSeed,
  commandMoveSeat,
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
  normalizeHandle,
  reduceEvents,
  roleForHandle,
  roomSlugFrom,
} from "./game/model";
import { clampLetter, ribbon } from "./game/rules";
import type { CommandResult, Game, RoomState, Round } from "./game/types";
import { createEventStore, type EventStore } from "./store/event-store";
import { byId, escapeHtml, formValue } from "./lib/html";

type AppContext = {
  roomSlug: string;
  handle: string;
  reviewGameId?: string;
};

const LAST_ROOM_KEY = "sowsear:last-room";
const LAST_HANDLE_KEY = "sowsear:last-handle";
const PRESENCE_HEARTBEAT_MS = 15000;
const PRESENCE_ONLINE_MS = 45000;
const ROOM_ADJECTIVES = ["sunny", "muddy", "clover", "golden", "apple", "patchwork", "market", "harvest"];
const ROOM_NOUNS = ["field", "barn", "orchard", "pasture", "porch", "garden", "wagon", "meadow"];

export class SowsEarApp {
  private readonly root: HTMLElement;
  private readonly store: EventStore;
  private unsubscribe: (() => void) | undefined;
  private state?: RoomState;
  private context: AppContext;
  private error = "";
  private pendingGuess = "";
  private pendingClaims = new Set<string>();
  private pendingLobbyJoins = new Set<string>();
  private pendingSprouts = new Set<string>();
  private pendingSeen = new Set<string>();
  private pendingCommands = new Set<string>();
  private lastSeenSentAt = new Map<string, number>();
  private skipFocusRestoreOnce = false;
  private seenInterval: number | undefined;

  constructor(root: HTMLElement, store: EventStore = createEventStore()) {
    this.root = root;
    this.store = store;
    this.context = this.readContext();
    this.root.addEventListener("submit", (event) => void this.onSubmit(event));
    this.root.addEventListener("click", (event) => void this.onClick(event));
    this.root.addEventListener("keydown", (event) => void this.onKeyDown(event));
    window.addEventListener("popstate", () => this.navigate(this.readContext()));
  }

  start(): void {
    this.navigate(this.context);
  }

  private readContext(): AppContext {
    const url = new URL(window.location.href);
    const roomFromUrl = roomSlugFrom(url.searchParams.get("room") ?? "");
    const handleFromUrl = url.searchParams.get("handle")?.trim() ?? "";
    const roomSlug = roomFromUrl || localStorage.getItem(LAST_ROOM_KEY) || "";
    const handle = handleFromUrl || localStorage.getItem(this.handleKey(roomSlug)) || localStorage.getItem(LAST_HANDLE_KEY) || "";
    const context: AppContext = {
      roomSlug,
      handle,
    };
    const reviewGameId = url.searchParams.get("review");
    if (reviewGameId) context.reviewGameId = reviewGameId;
    return context;
  }

  private navigate(next: AppContext): void {
    this.context = next;
    this.error = "";
    this.pendingGuess = "";
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.seenInterval) window.clearInterval(this.seenInterval);
    this.seenInterval = undefined;
    if (next.roomSlug) {
      localStorage.setItem(LAST_ROOM_KEY, next.roomSlug);
      this.unsubscribe = this.store.subscribe(next.roomSlug, (events) => {
        this.state = reduceEvents(next.roomSlug, events);
        void this.ensureHandleClaimed();
        void this.ensureHandleSeen();
        void this.ensureLobbyJoined();
        void this.ensureRowsSprouted();
        this.render();
      });
      this.seenInterval = window.setInterval(() => {
        void this.ensureHandleSeen(true);
        this.render();
      }, PRESENCE_HEARTBEAT_MS);
    }
    this.render();
  }

  private setUrl(params: Record<string, string | undefined>): void {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    history.pushState({}, "", url);
    this.navigate(this.readContext());
  }

  private async dispatch(result: CommandResult): Promise<void> {
    if (!result.ok) {
      this.error = result.error;
      this.render();
      return;
    }
    this.error = "";
    await this.store.append(result.events);
  }

  private async dispatchOnce(key: string, makeResult: () => CommandResult): Promise<void> {
    if (this.pendingCommands.has(key)) return;
    this.pendingCommands.add(key);
    try {
      await this.dispatch(makeResult());
    } finally {
      this.pendingCommands.delete(key);
    }
  }

  private async ensureHandleClaimed(): Promise<void> {
    if (!this.state || !this.context.handle) return;
    const key = `${this.context.roomSlug}:${normalizeHandle(this.context.handle)}`;
    if (this.pendingClaims.has(key)) return;
    if (this.state.handles.some((handle) => handle.normalizedHandle === normalizeHandle(this.context.handle))) return;
    this.pendingClaims.add(key);
    await this.dispatch(commandClaimHandle(this.state, this.context.handle));
    this.pendingClaims.delete(key);
  }

  private async ensureLobbyJoined(): Promise<void> {
    if (!this.state || !this.context.handle) return;
    const game = activeGame(this.state);
    if (!game || game.status !== "lobby") return;
    if (playerForGame(game, this.context.handle)) return;
    const key = `${game.id}:${normalizeHandle(this.context.handle)}`;
    if (this.pendingLobbyJoins.has(key)) return;
    const result = commandJoinSeason(this.state, this.context.handle);
    if (!result.ok) {
      this.error = result.error;
      return;
    }
    if (!result.events.length) return;
    this.pendingLobbyJoins.add(key);
    try {
      await this.store.append(result.events);
    } finally {
      this.pendingLobbyJoins.delete(key);
    }
  }

  private async ensureHandleSeen(force = false): Promise<void> {
    if (!this.state || !this.context.handle) return;
    const normalizedHandle = normalizeHandle(this.context.handle);
    if (!this.state.handles.some((handle) => handle.normalizedHandle === normalizedHandle)) return;
    const key = `${this.context.roomSlug}:${normalizedHandle}`;
    if (this.pendingSeen.has(key)) return;
    const now = Date.now();
    const lastSent = this.lastSeenSentAt.get(key) ?? 0;
    if (!force && now - lastSent < PRESENCE_HEARTBEAT_MS) return;
    const result = commandMarkHandleSeen(this.state, this.context.handle);
    if (!result.ok || !result.events.length) return;
    this.pendingSeen.add(key);
    this.lastSeenSentAt.set(key, now);
    try {
      await this.store.append(result.events);
    } finally {
      this.pendingSeen.delete(key);
    }
  }

  private async ensureRowsSprouted(): Promise<void> {
    if (!this.state || !this.context.handle) return;
    const game = activeGame(this.state);
    const round = game ? currentRound(game) : undefined;
    if (!game || !round || round.phase !== "planting") return;
    const key = `${game.id}:${round.id}:${round.depth}:${game.phaseVersion}`;
    if (this.pendingSprouts.has(key)) return;
    const result = commandTrySprout(this.state, this.context.handle);
    if (!result.ok || !result.events.length) return;
    this.pendingSprouts.add(key);
    try {
      await this.store.append(result.events);
    } finally {
      this.pendingSprouts.delete(key);
    }
  }

  private render(): void {
    const activeTestId = this.skipFocusRestoreOnce ? "" : editableFocusTestId(document.activeElement);
    this.skipFocusRestoreOnce = false;
    const setHtml = (html: string): void => {
      this.root.innerHTML = html;
      if (activeTestId && this.focusByTestId(activeTestId)) return;
      this.focusPrimaryAction();
    };
    if (!this.context.roomSlug) {
      setHtml(shell(this.renderRoomEntry(), { hideHeaderPig: true }));
      return;
    }
    if (!this.context.handle) {
      setHtml(shell(this.renderHandleClaim(), { hideHeaderPig: true }));
      return;
    }
    if (!this.state) {
      setHtml(shell(`<section class="paper-panel"><p>Loading Room...</p></section>`));
      return;
    }
    if (!this.state.handles.some((handle) => handle.normalizedHandle === normalizeHandle(this.context.handle))) {
      void this.ensureHandleClaimed();
      setHtml(shell(`<section class="paper-panel"><p>Joining Room...</p></section>`, {
        roomSlug: this.context.roomSlug,
        handle: this.context.handle,
        mode: this.store.mode,
        error: this.error,
      }));
      return;
    }
    const review = this.context.reviewGameId
      ? this.state.games.find((game) => game.id === this.context.reviewGameId)
      : undefined;
    const game = activeGame(this.state);
    const body = review ? this.renderReview(review) : game ? this.renderGame(game) : this.renderRoomHome();
    setHtml(shell(body, {
      roomSlug: this.context.roomSlug,
      handle: this.context.handle,
      mode: this.store.mode,
      error: this.error,
    }));
  }

  private focusByTestId(testId: string): boolean {
    for (const element of this.root.querySelectorAll<HTMLElement>("[data-testid]")) {
      if (element.dataset.testid !== testId || !isFocusable(element)) continue;
      element.focus({ preventScroll: true });
      return true;
    }
    return false;
  }

  private focusPrimaryAction(): void {
    const selectors = [
      '[data-testid="room-input"]',
      '[data-testid="handle-input"]',
      '[data-testid="create-season"]',
      '[data-testid="start-season"]:not(:disabled)',
      '[data-testid="field-option"]',
      '[data-testid="seed-input"]',
      '[data-testid^="letter-input-"]',
      '[data-testid="confirm-guess"]',
      '[data-testid="guess-input"]',
      '[data-testid="accept-guess"]',
      '[data-testid="advance"]',
      '[data-testid="resume-season"]',
    ];
    for (const selector of selectors) {
      const element = this.root.querySelector<HTMLElement>(selector);
      if (!element || !isFocusable(element)) continue;
      element.focus({ preventScroll: true });
      return;
    }
  }

  private renderRoomEntry(): string {
    return `
      <section class="hero">
        <div class="brand-lockup">
          <img src="./assets/brand-pig.png" alt="" class="brand-pig" />
          <div>
            <img src="./assets/brand-title.png" alt="Sow's Ear" class="brand-title" />
            <p>A cooperative word game where every letter counts.</p>
          </div>
        </div>
        <form data-form="room" class="paper-panel compact-form">
          <label>
            Room
            <input name="room" autocomplete="off" placeholder="farm-night" required data-testid="room-input" />
          </label>
          <div class="action-row">
            <button type="submit" class="button primary" data-testid="enter-room">Enter Room</button>
            <button type="button" class="button secondary" data-action="create-room" data-testid="create-room">Create Room</button>
          </div>
        </form>
      </section>
    `;
  }

  private renderHandleClaim(): string {
    return `
      <section class="paper-panel handle-panel">
        <div class="handle-heading">
          <div class="room-tools">
            <p class="eyebrow">Room ${escapeHtml(this.context.roomSlug)}</p>
            <button class="button quiet handle-copy" data-action="copy-room" data-testid="copy-room">Copy Link</button>
          </div>
          <img src="./assets/brand-pig.png" alt="" class="handle-mascot" />
        </div>
        <form data-form="handle" class="compact-form">
          <label>
            Name
            <input name="handle" autocomplete="nickname" maxlength="32" placeholder="Alice" required data-testid="handle-input" />
          </label>
          <button type="submit" class="button primary" data-testid="claim-handle">Join Room</button>
        </form>
      </section>
    `;
  }

  private renderRoomHome(): string {
    const history = this.historyHtml();
    return `
      <section class="room-grid">
        <div class="paper-panel">
          <p class="eyebrow">Room ${escapeHtml(this.context.roomSlug)}</p>
          <h1>Room Home</h1>
          <p class="subtle">Start a Season, or review an earlier one.</p>
          <div class="action-row">
            <button class="button primary" data-action="create-season" data-testid="create-season">Create Season</button>
            <button class="button" data-action="copy-room" data-testid="copy-room">Copy Room Link</button>
            <button class="button quiet" data-action="switch-handle">Switch Handle</button>
          </div>
        </div>
        ${history}
      </section>
    `;
  }

  private renderGame(game: Game): string {
    if (game.status === "lobby") return this.renderLobby(game);
    if (game.phase === "final") return this.renderFinal(game);
    const round = currentRound(game);
    if (!round) return this.renderRoomHome();
    const role = roleForHandle(game, this.context.handle);
    if (game.pausedAt) {
      return `
        <section class="game-layout">
          ${this.statusRail(game, round, role)}
          <div class="play-surface">
            <section class="paper-panel wait-panel" data-testid="paused-panel">
              <p class="eyebrow">Paused</p>
              <h1>Season Paused</h1>
              <p class="subtle">The host paused this Season. Current Harvest state is preserved.</p>
              ${normalizeHandle(game.hostHandle) === normalizeHandle(this.context.handle) ? `<button class="button primary" data-action="resume-season" data-testid="resume-season">Resume</button>` : ""}
            </section>
          </div>
        </section>
      `;
    }
    return `
      <section class="game-layout">
        ${this.statusRail(game, round, role)}
        <div class="play-surface">
          ${this.phasePanel(game, round, role)}
        </div>
      </section>
    `;
  }

  private renderLobby(game: Game): string {
    const me = game.players.find((player) => player.normalizedHandle === normalizeHandle(this.context.handle));
    const isHost = normalizeHandle(game.hostHandle) === normalizeHandle(this.context.handle);
    const readyCount = game.players.filter((player) => player.ready).length;
    const canStart = readyCount >= 3 && readyCount <= 8;
    return `
      <section class="room-grid">
        <div class="paper-panel">
          <p class="eyebrow">Season Lobby</p>
          <h1>${escapeHtml(this.context.roomSlug)}</h1>
          <p class="subtle">${readyCount} ready. Start needs 3-8 ready players.</p>
          <div class="rules-summary" data-testid="rules-summary">
            <p><strong>Field pack:</strong> Starter Fields (${STARTER_FIELDS.length})</p>
            <p><strong>Rules:</strong> 3-8 players, five letters max, Ribbons 20/10/7/5/3, County Fair best five.</p>
          </div>
          <div class="action-row">
            ${
              me
                ? `<button class="button ${me.ready ? "secondary" : "primary"}" data-action="toggle-ready" data-testid="toggle-ready">${me.ready ? "Not Ready" : "Ready"}</button>`
                : `<button class="button primary" data-action="join-season" data-testid="join-season">Join Season</button>`
            }
            ${isHost ? `<button class="button primary" data-action="start-season" data-testid="start-season" ${canStart ? "" : "disabled aria-disabled=\"true\""}>Start Season</button>` : ""}
            <button class="button" data-action="copy-room" data-testid="copy-room">Copy Room Link</button>
            ${!isHost && me && !this.isHandleOnline(game.hostHandle) ? `<button class="button secondary" data-action="claim-host" data-testid="claim-host">Take Host</button>` : ""}
          </div>
        </div>
        <div class="paper-panel">
          <h2>Seats</h2>
          <ol class="seat-list">
            ${game.players
              .sort((a, b) => a.seatNumber - b.seatNumber)
              .map(
                (player) => {
                  const online = this.isHandleOnline(player.handle);
                  return `
                  <li data-testid="seat-${escapeHtml(player.handle)}" data-presence="${online ? "online" : "offline"}">
                    <span data-testid="seat-name">${escapeHtml(player.displayName)}</span>
                    <span>${player.isHost ? "Host" : ""} ${player.ready ? "Ready" : "Waiting"} <span class="presence ${online ? "online" : "offline"}" data-testid="presence-${escapeHtml(player.handle)}">${online ? "Online" : "Offline"}</span></span>
                    ${
                      isHost
                        ? `<span class="seat-actions">
                            <button class="button icon-button" aria-label="Move ${escapeHtml(player.displayName)} up" data-action="move-seat" data-direction="up" data-handle="${escapeHtml(player.handle)}" data-testid="seat-up-${escapeHtml(player.handle)}">^</button>
                            <button class="button icon-button" aria-label="Move ${escapeHtml(player.displayName)} down" data-action="move-seat" data-direction="down" data-handle="${escapeHtml(player.handle)}" data-testid="seat-down-${escapeHtml(player.handle)}">v</button>
                          </span>`
                        : ""
                    }
                    ${isHost && !player.isHost ? `<button class="button quiet" data-action="transfer-host" data-handle="${escapeHtml(player.handle)}" data-testid="transfer-host-${escapeHtml(player.handle)}">Make Host</button>` : ""}
                  </li>
                `;
                },
              )
              .join("")}
          </ol>
          ${isHost ? `<button class="button secondary lobby-randomize" data-action="randomize-seats" data-testid="randomize-seats">Randomize Seats</button>` : ""}
        </div>
        ${this.historyHtml()}
      </section>
    `;
  }

  private isHandleOnline(handle: string, now = Date.now()): boolean {
    if (normalizeHandle(handle) === normalizeHandle(this.context.handle)) return true;
    const roomHandle = this.state?.handles.find((item) => item.normalizedHandle === normalizeHandle(handle));
    return Boolean(roomHandle && now - roomHandle.lastSeenAt <= PRESENCE_ONLINE_MS);
  }

  private statusRail(game: Game, round: Round, role: string): string {
    const score = game.ribbons.reduce((sum, value) => sum + value, 0);
    const currentRibbon = ribbon(true, round.depth);
    return `
      <aside class="status-rail">
        <div class="paper-panel status-card">
          <div class="status-card-header">
            <p class="eyebrow">Harvest ${round.roundNumber} of ${game.totalHarvests}</p>
          </div>
          <div class="status-card-body">
            <div class="role-summary">
            <h2>${role === "none" ? "Observer" : titleCase(role)}</h2>
            <p>${escapeHtml(this.context.handle)}</p>
            </div>
            <div class="score-inline">
              <span>Ribbons</span>
              <strong>${score}</strong>
            </div>
          </div>
        </div>
        <div class="paper-panel ribbon-ladder" aria-label="Ribbon ladder">
          <div class="ribbon-ladder-heading">
            <span>Ribbon Ladder</span>
            <strong>Current ${currentRibbon}</strong>
          </div>
          <div class="token-stack">
            ${[20, 10, 7, 5, 3].map((value) => `<span class="token token-${value}">${value}</span>`).join("")}
          </div>
        </div>
        ${this.hostControls(game)}
        ${this.hostRecoveryControls(game)}
      </aside>
    `;
  }

  private hostControls(game: Game): string {
    if (normalizeHandle(game.hostHandle) !== normalizeHandle(this.context.handle)) return "";
    return `
      <div class="paper-panel host-controls">
        <h2>You're Host</h2>
        <div class="action-row">
          ${game.pausedAt ? `<button class="button primary" data-action="resume-season" data-testid="resume-season">Resume</button>` : `<button class="button secondary" data-action="pause-season" data-testid="pause-season">Pause</button>`}
          <button class="button danger" data-action="void-harvest" data-testid="void-harvest">Void Harvest</button>
        </div>
        <label>
          Transfer Host
          <select data-testid="host-transfer-select">
            ${game.players.map((player) => `<option value="${escapeHtml(player.handle)}" ${player.isHost ? "selected" : ""}>${escapeHtml(player.displayName)}</option>`).join("")}
          </select>
        </label>
        <button class="button" data-action="transfer-host-selected" data-testid="transfer-host-selected">Transfer</button>
      </div>
    `;
  }

  private hostRecoveryControls(game: Game): string {
    if (normalizeHandle(game.hostHandle) === normalizeHandle(this.context.handle)) return "";
    if (!playerForGame(game, this.context.handle)) return "";
    if (this.isHandleOnline(game.hostHandle)) return "";
    return `
      <div class="paper-panel host-controls" data-testid="host-offline-panel">
        <h2>Host Offline</h2>
        <p class="subtle">${escapeHtml(game.hostHandle)} is offline.</p>
        <button class="button secondary" data-action="claim-host" data-testid="claim-host">Take Host</button>
      </div>
    `;
  }

  private phasePanel(game: Game, round: Round, role: string): string {
    const fieldTitle = round.fieldLabel ? escapeHtml(round.fieldLabel) : "Field";
    if (round.phase === "field-choice") {
      if (role === "farmer") {
        return `
          <section class="paper-panel">
            <p class="eyebrow">Choose a Field</p>
            <h1>Pick the search space</h1>
            <div class="field-options">
              ${round.fieldOptions
                .map(
                  (fieldId) => `
                    <button class="field-card" data-action="choose-field" data-field-id="${escapeHtml(fieldId)}" data-testid="field-option">
                      <span>Category</span>
                      <strong>${escapeHtml(fieldLabel(fieldId))}</strong>
                    </button>
                  `,
                )
                .join("")}
            </div>
          </section>
        `;
      }
      return waitPanel("The Farmer is choosing a Field.");
    }

    if (round.phase === "seed") {
      if (role === "sower") {
        return `
          <section class="paper-panel">
            <p class="eyebrow">Category</p>
            <h1>${fieldTitle}</h1>
            <form data-form="seed" class="compact-form">
              <label>
                Secret Answer
                <input name="seed" autocomplete="off" maxlength="80" required data-testid="seed-input" />
              </label>
              <p class="hint">Long phrases and obscure proper nouns are hard to clue fairly.</p>
              <button type="submit" class="button primary" data-testid="plant-seed">Submit</button>
            </form>
          </section>
        `;
      }
      return `
        <section class="paper-panel wait-panel">
          <p class="eyebrow">Category</p>
          <div class="phase-title-row">
            <div class="spinner-sun" aria-hidden="true"></div>
            <div>
              <h1>${fieldTitle}</h1>
              <p class="subtle">The Sower is planting the seed.</p>
            </div>
          </div>
        </section>
      `;
    }

    if (round.phase === "planting") {
      const seedLine = role === "farmer" ? "" : `<p class="seed-line">Seed: <strong>${escapeHtml(round.seedRaw)}</strong></p>`;
      const heldRows = round.rows.filter(
        (row) =>
          normalizeHandle(row.currentHolderHandle) === normalizeHandle(this.context.handle) &&
          !round.entries.some((entry) => entry.rowIndex === row.rowIndex && entry.depth === round.depth),
      );
      return `
        <section class="paper-panel board-panel">
          <p class="eyebrow">Category</p>
          <h1>${fieldTitle}</h1>
          ${seedLine}
          ${this.rowsHtml(round, false)}
          ${this.plantingStatusHtml(round)}
          ${
            heldRows.length
              ? `
                <form data-form="letters" class="letter-form">
                  <div class="letter-fields">
                    ${heldRows
                      .map(
                        (row) => `
                          <label>
                            Row ${row.rowIndex + 1}
                            <input name="row-${row.rowIndex}" maxlength="2" autocomplete="off" required data-testid="letter-input-${row.rowIndex}" />
                          </label>
                        `,
                      )
                      .join("")}
                  </div>
                  <button class="button primary" type="submit" data-testid="submit-letters">Submit</button>
                </form>
              `
              : `<p class="subtle">${role === "farmer" ? "The Hands are tending the rows..." : "Waiting for the handoff."}</p>`
          }
        </section>
      `;
    }

    if (round.phase === "farmer-call") {
      return `
        <section class="paper-panel board-panel">
          <p class="eyebrow">Category</p>
          <h1>${fieldTitle}</h1>
          <p class="ribbon-callout" data-testid="current-ribbon">Current Ribbon: ${ribbon(true, round.depth)}</p>
          ${this.rowsHtml(round, false)}
          ${
            role === "farmer"
              ? `
                <form data-form="guess" class="compact-form guess-form">
                  <label>
                    Guess
                    <input name="guess" autocomplete="off" required data-testid="guess-input" value="${escapeHtml(this.pendingGuess)}" />
                  </label>
                  ${
                    this.pendingGuess
                      ? `<p class="hint" data-testid="guess-confirmation">Submitting ends the Harvest if it is not accepted.</p>
                         <input type="hidden" name="confirmed" value="true" />
                         <button class="button primary" type="submit" data-testid="confirm-guess">Confirm Guess</button>`
                      : `<button class="button primary" type="submit" data-testid="submit-guess">Guess</button>`
                  }
                </form>
                <div class="action-row">
                  ${round.depth < 5 ? `<button class="button secondary" data-action="wait" data-testid="one-more-letter">One More Letter</button>` : ""}
                  <button class="button danger" data-action="spoil" data-testid="spoil">Spoiled</button>
                </div>
              `
              : `<p class="seed-line">Seed: <strong>${escapeHtml(round.seedRaw)}</strong></p><p class="subtle">The Farmer is deciding.</p>`
          }
        </section>
      `;
    }

    if (round.phase === "adjudication") {
      if (role === "sower") {
        return `
          <section class="paper-panel">
            <p class="eyebrow">Adjudication</p>
            <h1>Does this count?</h1>
            <dl class="compare-list">
              <dt>Seed</dt><dd>${escapeHtml(round.seedRaw)}</dd>
              <dt>Guess</dt><dd>${escapeHtml(round.guessRaw)}</dd>
            </dl>
            <div class="action-row">
              <button class="button primary" data-action="adjudicate" data-accepted="true" data-testid="accept-guess">Correct</button>
              <button class="button danger" data-action="adjudicate" data-accepted="false" data-testid="reject-guess">Miss</button>
            </div>
          </section>
        `;
      }
      if (role === "farmer") {
        return `
          <section class="paper-panel board-panel">
            <p class="eyebrow">Category</p>
            <h1>${fieldTitle}</h1>
            ${this.rowsHtml(round, false)}
            <dl class="compare-list">
              <dt>Guess</dt><dd data-testid="adjudication-guess">${escapeHtml(round.guessRaw)}</dd>
            </dl>
            <p class="subtle">The Sower is judging the Guess.</p>
          </section>
        `;
      }
      return `
        <section class="paper-panel wait-panel">
          <div class="spinner-sun" aria-hidden="true"></div>
          <p class="seed-line">Seed: <strong>${escapeHtml(round.seedRaw)}</strong></p>
          <p class="subtle">The Sower is judging the Guess.</p>
        </section>
      `;
    }

    return this.renderHarvestRecap(game, round);
  }

  private plantingStatusHtml(round: Round): string {
    if (round.phase !== "planting") return "";
    return `
      <div class="planting-status" data-testid="planting-status" aria-label="Planting status">
        ${round.rows
          .map((row) => {
            const entry = round.entries.find((item) => item.rowIndex === row.rowIndex && item.depth === round.depth);
            const handle = entry?.handle ?? row.currentHolderHandle;
            const online = this.isHandleOnline(handle);
            return `
              <div
                class="planting-status-item ${entry ? "planted" : "waiting"}"
                data-testid="planting-status-${row.rowIndex}"
                data-state="${entry ? "planted" : "waiting"}"
                data-presence="${online ? "online" : "offline"}"
              >
                <span>Row ${row.rowIndex + 1}</span>
                <strong>${escapeHtml(handle)}</strong>
                <span>${entry ? "Planted" : online ? "Waiting" : "Waiting (offline)"}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  private renderHarvestRecap(game: Game, round: Round): string {
    const isHost = normalizeHandle(game.hostHandle) === normalizeHandle(this.context.handle);
    return `
      <section class="paper-panel board-panel">
        <p class="eyebrow">Harvest Recap</p>
        <h1>${round.accepted ? recapLine(round.depth) : "Still just a sow's ear."}</h1>
        <dl class="compare-list">
          <dt>Category</dt><dd>${escapeHtml(round.fieldLabel)}</dd>
          <dt>Seed</dt><dd data-testid="revealed-seed">${escapeHtml(round.seedRaw)}</dd>
          <dt>Guess</dt><dd>${escapeHtml(round.guessRaw || "Spoiled")}</dd>
          <dt>Ribbon</dt><dd>${round.ribbon ?? 0}</dd>
        </dl>
        <p class="score-note" data-testid="running-county-fair">County Fair so far: ${finalScore(game)} / 100</p>
        ${this.rowsHtml(round, true)}
        ${isHost ? `<button class="button primary" data-action="advance" data-testid="advance">${round.roundNumber >= game.totalHarvests ? "County Fair" : "Next Harvest"}</button>` : `<p class="subtle">Waiting for the host.</p>`}
      </section>
    `;
  }

  private renderFinal(game: Game): string {
    const summary = seasonSummary(game);
    return `
      <section class="room-grid">
        <div class="paper-panel final-panel">
          <p class="eyebrow">County Fair</p>
          <h1>${finalScore(game)} / 100</h1>
          <div class="score-ledger">
            <p data-testid="all-ribbons"><strong>Every Ribbon:</strong> ${game.ribbons.join(", ") || "none"}</p>
            <p data-testid="counted-ribbons"><strong>Counted Ribbons:</strong> ${topFive(game.ribbons).join(", ") || "none"}</p>
          </div>
          <label>
            Summary
            <textarea class="summary-box" readonly data-testid="summary-text">${escapeHtml(summary)}</textarea>
          </label>
          <button class="button secondary" data-action="copy-summary" data-testid="copy-summary">Copy Summary</button>
          <button class="button primary" data-action="create-season" data-testid="rematch">Rematch</button>
        </div>
        ${this.renderReview(game)}
      </section>
    `;
  }

  private renderReview(game: Game): string {
    return `
      <section class="paper-panel review-panel" data-testid="review-panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Room History</p>
            <h1>Season Review</h1>
          </div>
          ${this.context.reviewGameId ? `<button class="button quiet" data-action="leave-review">Back</button>` : ""}
        </div>
        <p class="subtle" data-testid="review-final-score">Final County Fair ${finalScore(game)} / 100</p>
        <div class="review-list">
          ${game.rounds
            .map(
              (round) => `
                <article class="review-item">
                  <h2>Harvest ${round.roundNumber}: ${escapeHtml(round.fieldLabel || "Field")}</h2>
                  <p>Seed: <strong>${escapeHtml(round.seedRaw || "")}</strong></p>
                  <p>Guess: ${escapeHtml(round.guessRaw || "Spoiled")} · Ribbon ${round.ribbon ?? 0}</p>
                  ${this.rowsHtml(round, true)}
                  ${this.replayHtml(round)}
                </article>
              `,
            )
            .join("")}
        </div>
      </section>
    `;
  }

  private replayHtml(round: Round): string {
    const maxDepth = Math.max(0, ...round.entries.map((entry) => entry.depth));
    if (!maxDepth) return "";
    return `
      <div class="harvest-replay" data-testid="harvest-replay-${round.roundNumber}">
        <h3>Replay</h3>
        ${Array.from({ length: maxDepth }, (_, index) => {
          const depth = index + 1;
          return `
            <section class="replay-step" data-testid="replay-step-${round.roundNumber}-${depth}">
              <h4>Sprout ${depth}</h4>
              ${this.rowsHtml(round, true, depth)}
            </section>
          `;
        }).join("")}
      </div>
    `;
  }

  private rowsHtml(round: Round, revealAll: boolean, maxVisibleDepth?: number): string {
    return `
      <div class="rows" data-testid="rows">
        ${round.rows
          .map((row) => {
            const entries = [1, 2, 3, 4, 5].map((depth) =>
              round.entries.find((entry) => entry.rowIndex === row.rowIndex && entry.depth === depth),
            );
            const contributionEntries = entries.filter(
              (entry) => entry && (maxVisibleDepth === undefined || entry.depth <= maxVisibleDepth),
            );
            return `
              <div class="hint-row">
                <span class="row-number">${row.rowIndex + 1}</span>
                <div class="row-main">
                  <div class="slots" aria-label="Row ${row.rowIndex + 1}">
                    ${entries
                      .map((entry) => {
                        const visible =
                          entry &&
                          (maxVisibleDepth === undefined ? entry.sprouted || revealAll : entry.depth <= maxVisibleDepth);
                        return `<span class="slot ${visible ? "filled" : ""}">${visible ? letterGlyph(entry.letter) : ""}</span>`;
                      })
                      .join("")}
                  </div>
                  ${
                    revealAll
                      ? `<p class="row-contributors" data-testid="row-contributors">${contributionEntries
                          .map((entry) => `${entry!.depth}: ${escapeHtml(entry!.letter)} by ${escapeHtml(entry!.handle)}`)
                          .join(" / ")}</p>`
                      : ""
                  }
                </div>
                <span class="holder">${escapeHtml(row.currentHolderHandle)}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  private historyHtml(): string {
    const completeGames = (this.state?.games ?? [])
      .filter((game) => game.status === "complete")
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    return `
      <div class="paper-panel">
        <h2>Room History</h2>
        ${
          completeGames.length
            ? `<ul class="history-list">
                ${completeGames
                  .map(
                    (game) => `
                      <li>
                        <span>Season ${new Date(game.createdAt).toLocaleDateString()}</span>
                        <button class="button quiet" data-action="review-game" data-game-id="${escapeHtml(game.id)}">Review ${finalScore(game)}</button>
                      </li>
                    `,
                  )
                  .join("")}
              </ul>`
            : `<p class="subtle">Quiet season. Plant something next time.</p>`
        }
      </div>
    `;
  }

  private async onSubmit(event: SubmitEvent): Promise<void> {
    const form = event.target instanceof HTMLFormElement ? event.target : undefined;
    if (!form?.dataset.form) return;
    event.preventDefault();
    if (form.dataset.form === "room") {
      const roomSlug = roomSlugFrom(formValue(form, "room"));
      if (roomSlug) this.setUrl({ room: roomSlug, review: undefined });
      return;
    }
    if (!this.state) return;
    if (form.dataset.form === "handle") {
      const handle = formValue(form, "handle");
      const cleaned = handle.trim();
      if (!cleaned) return;
      localStorage.setItem(LAST_HANDLE_KEY, cleaned);
      localStorage.setItem(this.handleKey(this.context.roomSlug), cleaned);
      this.context.handle = cleaned;
      await this.dispatch(commandClaimHandle(this.state, cleaned));
      this.setUrl({ room: this.context.roomSlug, review: undefined });
      return;
    }
    if (form.dataset.form === "seed") {
      await this.dispatchOnce(this.formCommandKey("seed"), () =>
        commandPlantSeed(this.state!, this.context.handle, formValue(form, "seed")),
      );
      return;
    }
    if (form.dataset.form === "letters") {
      const letters = new Map<number, string>();
      for (const [name, value] of new FormData(form)) {
        if (name.startsWith("row-") && typeof value === "string") {
          letters.set(Number(name.slice(4)), clampLetter(value));
        }
      }
      await this.dispatchOnce(this.formCommandKey("letters"), () => commandPlantLetters(this.state!, this.context.handle, letters));
      return;
    }
    if (form.dataset.form === "guess") {
      const confirmed = new FormData(form).get("confirmed") === "true";
      const guess = confirmed ? this.pendingGuess || formValue(form, "guess") : formValue(form, "guess");
      if (!confirmed) {
        this.pendingGuess = guess;
        this.skipFocusRestoreOnce = true;
        this.render();
        return;
      }
      this.pendingGuess = "";
      await this.dispatchOnce(this.formCommandKey("guess"), () => commandGuess(this.state!, this.context.handle, guess));
    }
  }

  private async onClick(event: MouseEvent): Promise<void> {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!button) return;
    await this.handleAction(button);
  }

  private async onKeyDown(event: KeyboardEvent): Promise<void> {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (event.key === "Enter" && target instanceof HTMLInputElement && target.form) {
      if (target.form.dataset.form === "letters") {
        const inputs = Array.from(target.form.querySelectorAll<HTMLInputElement>('input[name^="row-"]'));
        const nextEmpty = inputs.find((input) => input !== target && !input.value.trim());
        if (nextEmpty) {
          event.preventDefault();
          nextEmpty.focus();
          return;
        }
      }
      event.preventDefault();
      target.form.requestSubmit();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    if (target instanceof HTMLButtonElement && target.type === "submit" && target.form) {
      event.preventDefault();
      target.form.requestSubmit(target);
      return;
    }
    const button = target.closest<HTMLButtonElement>("button[data-action]");
    if (!button || button.disabled) return;
    event.preventDefault();
    await this.handleAction(button);
  }

  private async handleAction(button: HTMLElement): Promise<void> {
    const action = button.dataset.action;
    if (action === "switch-handle") {
      localStorage.removeItem(this.handleKey(this.context.roomSlug));
      localStorage.removeItem(LAST_HANDLE_KEY);
      this.context.handle = "";
      this.render();
      return;
    }
    if (action === "copy-room") {
      const roomLink = this.roomLink();
      try {
        await navigator.clipboard?.writeText(roomLink);
        this.error = "Room link copied.";
      } catch {
        this.error = roomLink;
      }
      this.render();
      return;
    }
    if (action === "create-room") {
      this.setUrl({ room: makeRoomSlug(), review: undefined });
      return;
    }
    if (action === "copy-summary") {
      const game = this.state ? activeGame(this.state) : undefined;
      if (game) {
        try {
          await navigator.clipboard?.writeText(seasonSummary(game));
          this.error = "Summary copied.";
        } catch {
          this.error = "Summary is ready to copy.";
        }
        this.render();
      }
      return;
    }
    if (action === "review-game") {
      this.setUrl({ room: this.context.roomSlug, review: button.dataset.gameId });
      return;
    }
    if (action === "leave-review") {
      this.setUrl({ room: this.context.roomSlug, review: undefined });
      return;
    }
    if (!this.state) return;
    if (action === "create-season") await this.dispatchOnce(this.actionCommandKey(button), () => commandCreateSeason(this.state!, this.context.handle));
    if (action === "join-season") await this.dispatchOnce(this.actionCommandKey(button), () => commandJoinSeason(this.state!, this.context.handle));
    if (action === "move-seat" && button.dataset.handle && (button.dataset.direction === "up" || button.dataset.direction === "down")) {
      await this.dispatchOnce(this.actionCommandKey(button), () =>
        commandMoveSeat(this.state!, this.context.handle, button.dataset.handle!, button.dataset.direction as "up" | "down"),
      );
    }
    if (action === "randomize-seats") await this.dispatchOnce(this.actionCommandKey(button), () => commandRandomizeSeats(this.state!, this.context.handle));
    if (action === "toggle-ready") {
      await this.dispatchOnce(this.actionCommandKey(button), () => {
        const game = activeGame(this.state!);
        const me = game?.players.find((player) => player.normalizedHandle === normalizeHandle(this.context.handle));
        return commandSetReady(this.state!, this.context.handle, !me?.ready);
      });
    }
    if (action === "start-season") await this.dispatchOnce(this.actionCommandKey(button), () => commandStartSeason(this.state!, this.context.handle));
    if (action === "pause-season") await this.dispatchOnce(this.actionCommandKey(button), () => commandPauseSeason(this.state!, this.context.handle));
    if (action === "resume-season") await this.dispatchOnce(this.actionCommandKey(button), () => commandResumeSeason(this.state!, this.context.handle));
    if (action === "void-harvest") await this.dispatchOnce(this.actionCommandKey(button), () => commandVoidHarvest(this.state!, this.context.handle));
    if (action === "transfer-host" && button.dataset.handle) {
      await this.dispatchOnce(this.actionCommandKey(button), () => commandTransferHost(this.state!, this.context.handle, button.dataset.handle!));
    }
    if (action === "transfer-host-selected") {
      const select = this.root.querySelector<HTMLSelectElement>('[data-testid="host-transfer-select"]');
      if (select) await this.dispatchOnce(`${this.actionCommandKey(button)}:${select.value}`, () => commandTransferHost(this.state!, this.context.handle, select.value));
    }
    if (action === "claim-host") await this.dispatchOnce(this.actionCommandKey(button), () => commandClaimHost(this.state!, this.context.handle));
    if (action === "choose-field" && button.dataset.fieldId) {
      await this.dispatchOnce(this.actionCommandKey(button), () => commandChooseField(this.state!, this.context.handle, button.dataset.fieldId!));
    }
    if (action === "wait") await this.dispatchOnce(this.actionCommandKey(button), () => commandWait(this.state!, this.context.handle));
    if (action === "spoil") await this.dispatchOnce(this.actionCommandKey(button), () => commandSpoil(this.state!, this.context.handle));
    if (action === "adjudicate") await this.dispatchOnce(this.actionCommandKey(button), () => commandAdjudicate(this.state!, this.context.handle, button.dataset.accepted === "true"));
    if (action === "advance") await this.dispatchOnce(this.actionCommandKey(button), () => commandAdvanceAfterRecap(this.state!, this.context.handle));
  }

  private handleKey(roomSlug: string): string {
    return `sowsear:last-handle:${roomSlug || "none"}`;
  }

  private formCommandKey(formName: string): string {
    const game = this.state ? activeGame(this.state) : undefined;
    const round = game ? currentRound(game) : undefined;
    return `form:${formName}:${this.context.handle}:${game?.id ?? "room"}:${round?.id ?? "none"}:${game?.phaseVersion ?? 0}:${round?.depth ?? 0}`;
  }

  private actionCommandKey(button: HTMLElement): string {
    const game = this.state ? activeGame(this.state) : undefined;
    const round = game ? currentRound(game) : undefined;
    return [
      "action",
      button.dataset.action ?? "",
      this.context.handle,
      game?.id ?? "room",
      round?.id ?? "none",
      game?.phaseVersion ?? 0,
      button.dataset.handle ?? "",
      button.dataset.fieldId ?? "",
      button.dataset.accepted ?? "",
      button.dataset.direction ?? "",
    ].join(":");
  }

  private roomLink(): string {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("room", this.context.roomSlug);
    return url.toString();
  }
}

function shell(
  body: string,
  options: { roomSlug?: string; handle?: string; mode?: string; error?: string; hideHeaderPig?: boolean } = {},
): string {
  return `
    <div class="app-shell">
      <header class="topbar">
        <div class="topbar-brand">
          <a class="wordmark" href="./" aria-label="Sow's Ear">
            <img src="./assets/brand-title.png" alt="" />
          </a>
          ${options.hideHeaderPig ? "" : `<img src="./assets/brand-pig.png" alt="" class="topbar-pig" />`}
        </div>
	        <div class="topbar-meta">
	          ${options.roomSlug ? `<span>Room ${escapeHtml(options.roomSlug)}</span>` : ""}
	          ${options.handle ? `<span>${escapeHtml(options.handle)}</span>` : ""}
	        </div>
      </header>
      ${options.error ? `<div class="toast" role="alert" data-testid="error">${escapeHtml(options.error)}</div>` : ""}
      ${body}
    </div>
  `;
}

function waitPanel(message: string): string {
  return `
    <section class="paper-panel wait-panel">
      <div class="spinner-sun" aria-hidden="true"></div>
      <h1>${escapeHtml(message)}</h1>
    </section>
  `;
}

function titleCase(value: string): string {
  return value.slice(0, 1).toLocaleUpperCase("en-US") + value.slice(1);
}

function recapLine(depth: number): string {
  if (depth === 1) return "A silk purse out of a sow's ear!";
  if (depth <= 3) return "Now that's a fine harvest.";
  return "Brought it in just in time.";
}

function topFive(ribbons: number[]): number[] {
  return [...ribbons].sort((a, b) => b - a).slice(0, 5);
}

function playerForGame(game: Game, handle: string): boolean {
  return game.players.some((player) => player.normalizedHandle === normalizeHandle(handle));
}

function editableFocusTestId(element: Element | null): string {
  if (!(element instanceof HTMLElement)) return "";
  if (!isEditableElement(element)) return "";
  return element.dataset.testid ?? "";
}

function isEditableElement(element: Element): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

function isFocusable(element: HTMLElement): boolean {
  if (element instanceof HTMLButtonElement && element.disabled) return false;
  if (element instanceof HTMLInputElement && element.disabled) return false;
  if (element instanceof HTMLSelectElement && element.disabled) return false;
  if (element instanceof HTMLTextAreaElement && element.disabled) return false;
  if (element.getAttribute("aria-disabled") === "true") return false;
  return element.getClientRects().length > 0;
}

function seasonSummary(game: Game): string {
  const ribbons = game.ribbons.map((ribbonValue, index) => `Harvest ${index + 1}: ${ribbonValue}`).join(", ");
  return `Sow's Ear County Fair ${finalScore(game)} / 100\nBest five Ribbons: ${topFive(game.ribbons).join(", ") || "none"}\n${ribbons || "No Harvests yet."}`;
}

function letterGlyph(letter: string): string {
  if (/^[A-Z]$/.test(letter)) {
    return `<img class="letter-sprite" src="./assets/letters/${letter}.png" alt="${letter}" />`;
  }
  return escapeHtml(letter);
}

function makeRoomSlug(): string {
  const adjective = randomItem(ROOM_ADJECTIVES);
  const noun = randomItem(ROOM_NOUNS);
  const suffix = Math.floor(100 + Math.random() * 900);
  return roomSlugFrom(`${adjective}-${noun}-${suffix}`);
}

function randomItem(values: string[]): string {
  return values[Math.floor(Math.random() * values.length)] ?? values[0] ?? "room";
}

export function startApp(): void {
  startFieldCountGuard();
  const root = byId<HTMLElement>("app");
  new SowsEarApp(root).start();
}

function startFieldCountGuard(): void {
  if (STARTER_FIELDS.length < 120) {
    console.warn(`Starter Field pack has ${STARTER_FIELDS.length} Fields; launch target is 120-200.`);
  }
}
