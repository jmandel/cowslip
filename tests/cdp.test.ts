import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  commandChooseField,
  commandClaimHandle,
  commandCreateSeason,
  commandJoinSeason,
  commandPlantLetters,
  commandPlantSeed,
  commandSetReady,
  commandStartSeason,
  currentRound,
  activeGame,
  reduceEvents,
} from "../src/game/model";
import { clampLetter } from "../src/game/rules";
import type { CommandResult, RoomState, SowsEarEvent } from "../src/game/types";

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

class CdpPage {
  private id = 1;
  private pending = new Map<number, Pending>();
  private socket: WebSocket;
  private ready: Promise<void>;

  constructor(webSocketDebuggerUrl: string) {
    this.socket = new WebSocket(webSocketDebuggerUrl);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", () => reject(new Error("CDP websocket failed")));
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.ready;
    const id = this.id++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Pending["resolve"], reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const result = await this.send<any>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result.value as T;
  }

  async waitFor(expression: string, timeoutMs = 6000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.eval<boolean>(`Boolean(${expression})`)) return;
      await Bun.sleep(80);
    }
    const text = await this.eval<string>("document.body.innerText");
    throw new Error(`Timed out waiting for ${expression}\n${text}`);
  }

  async click(testId: string): Promise<void> {
    await this.waitFor(`document.querySelector('[data-testid="${testId}"]')`);
    await this.eval(`document.querySelector('[data-testid="${testId}"]').click()`);
  }

  async focus(testId: string, index = 0): Promise<void> {
    await this.waitFor(`document.querySelectorAll('[data-testid="${testId}"]').length > ${index}`);
    await this.eval(`document.querySelectorAll('[data-testid="${testId}"]')[${index}].focus()`);
  }

  async type(testId: string, value: string): Promise<void> {
    await this.waitFor(`document.querySelector('[data-testid="${testId}"]')`);
    await this.eval(`
      (() => {
        const el = document.querySelector('[data-testid="${testId}"]');
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);
  }

  async keyboardType(testId: string, value: string): Promise<void> {
    await this.focus(testId);
    await this.send("Input.insertText", { text: value });
  }

  async activate(testId: string, index = 0): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 2000) {
      await this.focus(testId, index);
      if ((await this.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)) === testId) {
        await this.pressEnter();
        return;
      }
      await Bun.sleep(50);
    }
    expect(await this.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe(testId);
    await this.pressEnter();
  }

  async pressEnter(): Promise<void> {
    await this.pressKey("Enter", "Enter");
  }

  async pressKey(key: string, code = key): Promise<void> {
    await this.eval(`
      (() => {
        const el = document.activeElement;
        if (!el) throw new Error('No active element for key press');
        el.dispatchEvent(new KeyboardEvent('keydown', {
          key: ${JSON.stringify(key)},
          code: ${JSON.stringify(code)},
          bubbles: true,
          cancelable: true
        }));
        el.dispatchEvent(new KeyboardEvent('keyup', {
          key: ${JSON.stringify(key)},
          code: ${JSON.stringify(code)},
          bubbles: true,
          cancelable: true
        }));
      })()
    `);
  }

  async count(testId: string): Promise<number> {
    return this.eval<number>(`document.querySelectorAll('[data-testid="${testId}"]').length`);
  }

  async has(testId: string): Promise<boolean> {
    return this.eval<boolean>(`Boolean(document.querySelector('[data-testid="${testId}"]'))`);
  }

  async text(): Promise<string> {
    return this.eval<string>("document.body.innerText");
  }

  async close(): Promise<void> {
    this.socket.close();
  }
}

let server: ReturnType<typeof Bun.serve>;
let chromium: ChildProcess;
let userDataDir = "";
let cdpPort = 0;
let appUrl = "";
const pages: CdpPage[] = [];

beforeAll(async () => {
  const build = spawnSync("bun", ["run", "build"], { cwd: process.cwd(), stdio: "inherit" });
  if (build.status !== 0) throw new Error("Build failed before CDP tests.");
  await assertNoAdminTokenInDist();

  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(`dist${path}`);
      if (await file.exists()) return new Response(file);
      return new Response(Bun.file("dist/index.html"));
    },
  });

  cdpPort = 49000 + Math.floor(Math.random() * 1000);
  appUrl = `http://127.0.0.1:${server.port}`;
  userDataDir = await mkdtemp(join(tmpdir(), "sowsear-cdp-"));
  chromium = spawn(chromiumPath(), [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ]);

  await waitForCdp();
}, 30000);

afterAll(async () => {
  for (const page of pages) await page.close();
  chromium?.kill();
  server?.stop(true);
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

async function waitForCdp(): Promise<void> {
  const endpoint = `http://127.0.0.1:${cdpPort}/json/version`;
  const start = Date.now();
  while (Date.now() - start < 8000) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error("Chromium CDP endpoint did not start.");
}

function chromiumPath(): string {
  const candidates = [
    process.env.CHROME_BIN,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter(Boolean) as string[];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`No Chromium/Chrome binary found. Tried: ${candidates.join(", ")}`);
  return found;
}

async function newPage(path: string): Promise<CdpPage> {
  const url = `${appUrl}${path}`;
  let response = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) {
    response = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`);
  }
  if (!response.ok) throw new Error(`Could not create CDP target: ${response.status}`);
  const target = await response.json();
  const page = new CdpPage(target.webSocketDebuggerUrl);
  pages.push(page);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.waitFor("document.readyState === 'complete'");
  return page;
}

async function assertNoAdminTokenInDist(): Promise<void> {
  const token = process.env.INSTANT_APP_ADMIN_TOKEN;
  if (!token || token.length < 8) return;
  const files = await allFiles("dist");
  for (const file of files) {
    const bytes = await readFile(file);
    expect(bytes.includes(Buffer.from(token))).toBe(false);
  }
}

async function allFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const entries = await readdir(path);
  const nested = await Promise.all(entries.map((entry) => allFiles(join(path, entry))));
  return nested.flat();
}

async function findPageWith(pages: CdpPage[], expression: string, timeoutMs = 8000): Promise<CdpPage> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const page of pages) {
      if (await page.eval<boolean>(`Boolean(${expression})`)) return page;
    }
    await Bun.sleep(80);
  }
  const texts = await Promise.all(pages.map((page) => page.text()));
  throw new Error(`No page matched ${expression}\n${texts.join("\n--- page ---\n")}`);
}

async function setupThreePlayers(room: string): Promise<{ alice: CdpPage; bob: CdpPage; cora: CdpPage; pages: CdpPage[] }> {
  const alice = await newPage(`/?room=${room}&handle=Alice&local=1`);
  await alice.waitFor(`document.querySelector('[data-testid="create-season"]')`);
  await alice.click("create-season");
  await alice.waitFor(`document.body.innerText.toLowerCase().includes('game lobby')`);

  const bob = await newPage(`/?room=${room}&handle=Bob&local=1`);
  await alice.waitFor(`document.body.innerText.includes('2 ready')`);

  const cora = await newPage(`/?room=${room}&handle=Cora&local=1`);
  await alice.waitFor(`document.body.innerText.includes('3 ready')`);
  await alice.click("start-season");
  return { alice, bob, cora, pages: [alice, bob, cora] };
}

async function setupPlayerCount(room: string, count: number): Promise<{ pages: CdpPage[]; handles: string[] }> {
  const handles = Array.from({ length: count }, (_, index) => `P${index + 1}`);
  const host = await newPage(`/?room=${room}&handle=${handles[0]}&local=1`);
  await host.waitFor(`document.querySelector('[data-testid="create-season"]')`);
  await host.click("create-season");
  await host.waitFor(`document.body.innerText.toLowerCase().includes('game lobby')`);

  const players = [host];
  for (const handle of handles.slice(1)) {
    const page = await newPage(`/?room=${room}&handle=${handle}&local=1`);
    players.push(page);
  }

  await host.waitFor(`document.querySelectorAll('[data-testid^="seat-P"]').length === ${count} && document.body.innerText.includes('${count} ready')`);
  await host.click("start-season");
  await host.waitFor(`document.body.innerText.includes('ROUND 1 OF ${count <= 4 ? count * 2 : count}')`);
  return { pages: players, handles };
}

async function fillCurrentLetters(pages: CdpPage[]): Promise<void> {
  await waitForTotalLetterInputs(pages, 4);
  const start = Date.now();
  while (Date.now() - start < 8000) {
    let submitted = false;
    for (const page of pages) {
      submitted = (await submitVisibleLetters(page)) || submitted;
    }
    if (await anyPageMatches(pages, `document.querySelector('[data-testid="guess-input"]') || document.querySelector('[data-testid="one-more-letter"]')`)) {
      return;
    }
    if (!submitted) await Bun.sleep(80);
  }
  throw new Error(`Timed out submitting current letters; ${await totalLetterInputs(pages)} inputs remain.`);
}

async function submitVisibleLetters(page: CdpPage): Promise<boolean> {
  return page.eval<boolean>(`
    (() => {
      const inputs = Array.from(document.querySelectorAll('[data-testid^="letter-input-"]'));
      if (!inputs.length) return false;
      for (const input of inputs) {
        input.value = 's';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const button = document.querySelector('[data-testid="submit-letters"]');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Missing submit-letters button');
      button.click();
      return true;
    })()
  `);
}

async function totalLetterInputs(pages: CdpPage[]): Promise<number> {
  let total = 0;
  for (const page of pages) {
    total += await page.eval<number>(`document.querySelectorAll('[data-testid^="letter-input-"]').length`);
  }
  return total;
}

async function anyPageMatches(pages: CdpPage[], expression: string): Promise<boolean> {
  for (const page of pages) {
    if (await page.eval<boolean>(`Boolean(${expression})`)) return true;
  }
  return false;
}

async function waitForTotalLetterInputs(pages: CdpPage[], expected: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    let total = 0;
    for (const page of pages) {
      total += await page.eval<number>(`document.querySelectorAll('[data-testid^="letter-input-"]').length`);
    }
    if (total === expected) return;
    await Bun.sleep(80);
  }
  throw new Error(`Timed out waiting for ${expected} letter inputs.`);
}

async function fillAndSubmitLetters(page: CdpPage, lettersByRow: Record<number, string>): Promise<void> {
  await page.eval(`
    (() => {
      const lettersByRow = ${JSON.stringify(lettersByRow)};
      for (const [rowIndex, letter] of Object.entries(lettersByRow)) {
        const input = document.querySelector(\`[data-testid="letter-input-\${rowIndex}"]\`);
        if (!(input instanceof HTMLInputElement)) throw new Error(\`Missing letter input \${rowIndex}\`);
        input.value = String(letter);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const button = document.querySelector('[data-testid="submit-letters"]');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Missing submit-letters button');
      button.click();
    })()
  `);
  await page.waitFor(`document.querySelectorAll('[data-testid^="letter-input-"]').length === 0`);
}

async function playExactRound(pages: CdpPage[], answer: string): Promise<void> {
  const guesser = await findPageWith(pages, `document.querySelectorAll('[data-testid="field-option"]').length === 2`);
  await guesser.click("field-option");

  const picker = await findPageWith(pages, `document.querySelector('[data-testid="seed-input"]')`);
  await picker.type("seed-input", answer);
  await picker.click("plant-seed");

  await fillCurrentLetters(pages);

  const guesserAfterClues = await findPageWith(pages, `document.querySelector('[data-testid="guess-input"]')`);
  await guesserAfterClues.type("guess-input", answer.toLocaleLowerCase("en-US"));
  await guesserAfterClues.click("submit-guess");
  await guesserAfterClues.waitFor(`document.querySelector('[data-testid="guess-confirmation"]')`);
  await guesserAfterClues.click("confirm-guess");
  await guesserAfterClues.waitFor(`document.querySelector('[data-testid="revealed-seed"]')?.innerText === ${JSON.stringify(answer)}`);
}

async function playSecondRevealRound(pages: CdpPage[], answer: string): Promise<void> {
  const guesser = await findPageWith(pages, `document.querySelectorAll('[data-testid="field-option"]').length === 2`);
  await guesser.click("field-option");

  const picker = await findPageWith(pages, `document.querySelector('[data-testid="seed-input"]')`);
  await picker.type("seed-input", answer);
  await picker.click("plant-seed");

  await fillCurrentLetters(pages);
  const waiter = await findPageWith(pages, `document.querySelector('[data-testid="one-more-letter"]')`);
  await waiter.click("one-more-letter");

  await fillCurrentLetters(pages);
  const guesserAfterClues = await findPageWith(pages, `document.querySelector('[data-testid="guess-input"]')`);
  await guesserAfterClues.type("guess-input", answer.toLocaleLowerCase("en-US"));
  await guesserAfterClues.click("submit-guess");
  await guesserAfterClues.waitFor(`document.querySelector('[data-testid="guess-confirmation"]')`);
  await guesserAfterClues.click("confirm-guess");
  await guesserAfterClues.waitFor(`document.querySelector('[data-testid="revealed-seed"]')?.innerText === ${JSON.stringify(answer)}`);
}

async function reopenSameHandle(room: string, handle: string, expression: string): Promise<CdpPage> {
  const page = await newPage(`/?room=${room}&handle=${encodeURIComponent(handle)}&local=1`);
  await page.waitFor(expression);
  return page;
}

function applyFixtureCommand(state: RoomState, events: SowsEarEvent[], result: CommandResult): RoomState {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  events.push(...result.events);
  return reduceEvents(state.roomSlug, events);
}

function plantingWithOfflineHandEvents(room: string): SowsEarEvent[] {
  const events: SowsEarEvent[] = [];
  let state = reduceEvents(room, events);
  for (const handle of ["Alice", "Bob", "Cora"]) {
    state = applyFixtureCommand(state, events, commandClaimHandle(state, handle));
  }

  const old = Date.now() - 60000;
  for (const event of events) {
    if (event.type === "handle.claimed" && event.actorHandle === "Cora") event.createdAt = old;
  }
  state = reduceEvents(room, events);

  state = applyFixtureCommand(state, events, commandCreateSeason(state, "Alice"));
  state = applyFixtureCommand(state, events, commandJoinSeason(state, "Bob"));
  state = applyFixtureCommand(state, events, commandJoinSeason(state, "Cora"));
  state = applyFixtureCommand(state, events, commandSetReady(state, "Bob", true));
  state = applyFixtureCommand(state, events, commandSetReady(state, "Cora", true));
  state = applyFixtureCommand(state, events, commandStartSeason(state, "Alice"));

  let round = currentRound(activeGame(state)!)!;
  state = applyFixtureCommand(state, events, commandChooseField(state, "Alice", round.fieldOptions[0]!));
  state = applyFixtureCommand(state, events, commandPlantSeed(state, "Bob", "Bale"));
  state = applyFixtureCommand(
    state,
    events,
    commandPlantLetters(state, "Bob", new Map([[0, clampLetter("h")], [1, clampLetter("s")]])),
  );
  round = currentRound(activeGame(state)!)!;
  expect(round.phase).toBe("planting");
  return events;
}

function answerPhaseWithOfflinePickerEvents(room: string): SowsEarEvent[] {
  const events: SowsEarEvent[] = [];
  let state = reduceEvents(room, events);
  for (const handle of ["Alice", "Bob", "Cora"]) {
    state = applyFixtureCommand(state, events, commandClaimHandle(state, handle));
  }

  const old = Date.now() - 60000;
  for (const event of events) {
    if (event.type === "handle.claimed" && event.actorHandle === "Bob") event.createdAt = old;
  }
  state = reduceEvents(room, events);

  state = applyFixtureCommand(state, events, commandCreateSeason(state, "Alice"));
  state = applyFixtureCommand(state, events, commandJoinSeason(state, "Bob"));
  state = applyFixtureCommand(state, events, commandJoinSeason(state, "Cora"));
  state = applyFixtureCommand(state, events, commandSetReady(state, "Bob", true));
  state = applyFixtureCommand(state, events, commandSetReady(state, "Cora", true));
  state = applyFixtureCommand(state, events, commandStartSeason(state, "Alice"));

  const round = currentRound(activeGame(state)!)!;
  expect(round.sowerHandle).toBe("Bob");
  state = applyFixtureCommand(state, events, commandChooseField(state, "Alice", round.fieldOptions[0]!));
  expect(currentRound(activeGame(state)!)!.phase).toBe("seed");
  return events;
}

function guesserCallWithOfflineGuesserEvents(room: string): SowsEarEvent[] {
  const events: SowsEarEvent[] = [];
  let state = reduceEvents(room, events);
  for (const handle of ["Alice", "Bob", "Cora"]) {
    state = applyFixtureCommand(state, events, commandClaimHandle(state, handle));
  }

  const old = Date.now() - 60000;
  for (const event of events) {
    if (event.type === "handle.claimed" && event.actorHandle === "Alice") event.createdAt = old;
  }
  state = reduceEvents(room, events);

  state = applyFixtureCommand(state, events, commandCreateSeason(state, "Alice"));
  state = applyFixtureCommand(state, events, commandJoinSeason(state, "Bob"));
  state = applyFixtureCommand(state, events, commandJoinSeason(state, "Cora"));
  state = applyFixtureCommand(state, events, commandSetReady(state, "Bob", true));
  state = applyFixtureCommand(state, events, commandSetReady(state, "Cora", true));
  state = applyFixtureCommand(state, events, commandStartSeason(state, "Alice"));

  let round = currentRound(activeGame(state)!)!;
  expect(round.farmerHandle).toBe("Alice");
  state = applyFixtureCommand(state, events, commandChooseField(state, "Alice", round.fieldOptions[0]!));
  state = applyFixtureCommand(state, events, commandPlantSeed(state, "Bob", "Bale"));
  state = applyFixtureCommand(
    state,
    events,
    commandPlantLetters(state, "Bob", new Map([[0, clampLetter("h")], [1, clampLetter("s")]])),
  );
  state = applyFixtureCommand(
    state,
    events,
    commandPlantLetters(state, "Cora", new Map([[2, clampLetter("c")], [3, clampLetter("w")]])),
  );
  round = currentRound(activeGame(state)!)!;
  expect(round.phase).toBe("farmer-call");
  return events;
}

function activeGameWithOfflineHostEvents(room: string): SowsEarEvent[] {
  const events: SowsEarEvent[] = [];
  let state = reduceEvents(room, events);
  for (const handle of ["Alice", "Bob", "Cora"]) {
    state = applyFixtureCommand(state, events, commandClaimHandle(state, handle));
  }

  const old = Date.now() - 60000;
  for (const event of events) {
    if (event.type === "handle.claimed" && event.actorHandle === "Alice") event.createdAt = old;
  }
  state = reduceEvents(room, events);

  state = applyFixtureCommand(state, events, commandCreateSeason(state, "Alice"));
  state = applyFixtureCommand(state, events, commandJoinSeason(state, "Bob"));
  state = applyFixtureCommand(state, events, commandJoinSeason(state, "Cora"));
  state = applyFixtureCommand(state, events, commandSetReady(state, "Bob", true));
  state = applyFixtureCommand(state, events, commandSetReady(state, "Cora", true));
  state = applyFixtureCommand(state, events, commandStartSeason(state, "Alice"));
  expect(activeGame(state)?.hostHandle).toBe("Alice");
  return events;
}

describe("Chromium CDP app flow", () => {
  test("room and handle forms join in-place on the same document", async () => {
    const room = `cdp-entry-${Date.now().toString(36)}`;
    const page = await newPage(`/?local=1`);
    await page.send("Storage.clearDataForOrigin", { origin: appUrl, storageTypes: "local_storage" });
    await page.send("Page.navigate", { url: `${appUrl}/?local=1` });
    await page.waitFor("document.readyState === 'complete'");
    await page.eval(`localStorage.clear()`);
    await page.send("Page.navigate", { url: `${appUrl}/?local=1` });
    await page.waitFor("document.readyState === 'complete'");
    await page.waitFor(`document.querySelector('[data-testid="room-input"]')`);
    const navigationCount = await page.eval<number>(`performance.getEntriesByType('navigation').length`);
    await page.waitFor(`document.querySelector('.plain-lockup')`);
    expect(await page.eval<number>(`document.querySelectorAll('.brand-title, .brand-pig, .handle-mascot').length`)).toBe(0);
    expect(await page.eval<boolean>(`document.querySelector('.plain-lockup')?.innerText.includes("Word Game")`)).toBe(true);
    await page.click("help-button");
    await page.waitFor(`document.querySelector('[data-testid="help-dialog"]')?.open === true`);
    expect(await page.eval<boolean>(`document.body.innerText.includes('How to Play') && document.body.innerText.includes('Scoring')`)).toBe(true);
    await page.click("close-help");
    await page.waitFor(`document.querySelector('[data-testid="help-dialog"]')?.open === false`);
    expect(await page.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("room-input");
    expect(await page.eval<boolean>(`getComputedStyle(document.body).backgroundImage.includes('sowsear-art')`)).toBe(false);
    expect((await page.text()).toLowerCase()).not.toContain("refresh");
    expect((await page.text()).toLowerCase()).not.toContain("reload");

    await page.keyboardType("room-input", room);
    await page.pressEnter();
    await page.waitFor(`document.querySelector('[data-testid="handle-input"]')`);
    expect(await page.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("handle-input");
    expect((await page.text()).toLowerCase()).not.toContain("refresh");
    expect((await page.text()).toLowerCase()).not.toContain("reload");

    await page.keyboardType("handle-input", "Alice");
    await page.pressEnter();
    await page.waitFor(`document.querySelector('[data-testid="create-season"]')`);
    expect(await page.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("create-season");

    expect(await page.eval<number>(`performance.getEntriesByType('navigation').length`)).toBe(navigationCount);
    expect(await page.eval<boolean>(`document.body.innerText.includes('Alice')`)).toBe(true);
    expect(await page.eval<boolean>(`new URL(location.href).searchParams.get('room') === ${JSON.stringify(room)}`)).toBe(true);

    await page.click("leave-room");
    await page.waitFor(`document.querySelector('[data-testid="room-input"]') && !new URL(location.href).searchParams.has('room')`);
    await page.waitFor(`document.querySelector('[data-testid="remembered-room-${room}"]')`);
    await page.click(`remembered-room-${room}`);
    await page.waitFor(`document.querySelector('[data-testid="create-season"]')`);
    expect(await page.eval<boolean>(`new URL(location.href).searchParams.get('room') === ${JSON.stringify(room)}`)).toBe(true);
    expect(await page.eval<boolean>(`document.body.innerText.includes('Alice')`)).toBe(true);
  }, 20000);

  test("entry screen can open and copy a shareable Room before handle claim", async () => {
    const room = `cdp-share-${Date.now().toString(36)}`;
    const page = await newPage(`/?local=1`);
    await page.send("Storage.clearDataForOrigin", { origin: appUrl, storageTypes: "local_storage" });
    await page.send("Page.navigate", { url: `${appUrl}/?local=1` });
    await page.waitFor("document.readyState === 'complete'");
    await page.waitFor(`document.querySelector('[data-testid="room-input"]')`);
    const navigationCount = await page.eval<number>(`performance.getEntriesByType('navigation').length`);

    await page.keyboardType("room-input", room);
    await page.click("enter-room");
    await page.waitFor(`document.querySelector('[data-testid="handle-input"]')`);
    expect(await page.eval<string>(`new URL(location.href).searchParams.get('room') ?? ''`)).toBe(room);
    expect(await page.eval<number>(`performance.getEntriesByType('navigation').length`)).toBe(navigationCount);

    await page.eval(`
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__sowsearCreatedRoomLink = text;
          }
        }
      });
    `);
    const cardTopBefore = await page.eval<number>(`document.querySelector('.handle-panel').getBoundingClientRect().top`);
    await page.click("copy-room");
    await page.waitFor(`Boolean(window.__sowsearCreatedRoomLink)`);
    await page.waitFor(`document.querySelector('[data-testid="copy-room"]')?.dataset.copyStatus === 'copied'`);
    expect(await page.has("error")).toBe(false);
    const cardTopAfter = await page.eval<number>(`document.querySelector('.handle-panel').getBoundingClientRect().top`);
    expect(cardTopAfter).toBe(cardTopBefore);
    const copied = await page.eval<string>(`window.__sowsearCreatedRoomLink`);
    const copiedUrl = new URL(copied);
    expect(copiedUrl.searchParams.get("room")).toBe(room);
    expect(copiedUrl.searchParams.has("handle")).toBe(false);
    expect(copiedUrl.searchParams.has("local")).toBe(false);

    await page.type("handle-input", "Alice");
    await page.click("claim-handle");
    await page.waitFor(`document.querySelector('[data-testid="create-season"]')`);
  }, 20000);

  test("lobby seats show online and offline presence from room handle heartbeats", async () => {
    const room = `cdp-presence-${Date.now().toString(36)}`;
    const gameId = `${room}:game:preloaded`;
    const old = Date.now() - 60000;
    const events = [
      {
        actionId: `${room}:alice-claim`,
        type: "handle.claimed",
        roomSlug: room,
        actorHandle: "Alice",
        createdAt: old,
        payload: { handle: "Alice", normalizedHandle: "alice" },
      },
      {
        actionId: `${room}:drew-claim`,
        type: "handle.claimed",
        roomSlug: room,
        actorHandle: "Drew",
        createdAt: old + 1,
        payload: { handle: "Drew", normalizedHandle: "drew" },
      },
      {
        actionId: `${room}:game`,
        type: "season.created",
        roomSlug: room,
        actorHandle: "Alice",
        gameId,
        createdAt: old + 2,
        payload: { gameId, hostHandle: "Alice" },
      },
      {
        actionId: `${room}:alice-joined`,
        type: "player.joined",
        roomSlug: room,
        actorHandle: "Alice",
        gameId,
        createdAt: old + 3,
        payload: { handle: "Alice", normalizedHandle: "alice", ready: true },
      },
      {
        actionId: `${room}:drew-joined`,
        type: "player.joined",
        roomSlug: room,
        actorHandle: "Drew",
        gameId,
        createdAt: old + 4,
        payload: { handle: "Drew", normalizedHandle: "drew", ready: false },
      },
    ];

    const page = await newPage(`/?local=1`);
    await page.send("Storage.clearDataForOrigin", { origin: appUrl, storageTypes: "local_storage" });
    await page.eval(`localStorage.setItem(${JSON.stringify(`sowsear:events:${room}`)}, ${JSON.stringify(JSON.stringify(events))})`);
    await page.send("Page.navigate", { url: `${appUrl}/?room=${room}&handle=Alice&local=1` });
    await page.waitFor("document.readyState === 'complete'");
    await page.waitFor(`document.querySelector('[data-testid="presence-Alice"]')?.innerText === 'Online'`);
    await page.waitFor(`document.querySelector('[data-testid="presence-Drew"]')?.innerText === 'Offline'`);
    expect(await page.eval<string>(`document.querySelector('[data-testid="seat-Drew"]').dataset.presence`)).toBe("offline");
  }, 20000);

  test("copied Room link excludes handle, review, and local transport params", async () => {
    const room = `cdp-copy-${Date.now().toString(36)}`;
    const page = await newPage(`/?room=${room}&handle=Alice&local=1&review=private-history`);
    await page.waitFor(`document.querySelector('[data-testid="create-season"]')`);
    await page.eval(`
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__sowsearCopied = text;
          }
        }
      });
    `);

    await page.click("copy-room");
    await page.waitFor(`Boolean(window.__sowsearCopied)`);
    const copied = await page.eval<string>(`window.__sowsearCopied`);
    const copiedUrl = new URL(copied);
    expect(copiedUrl.searchParams.get("room")).toBe(room);
    expect(copiedUrl.searchParams.has("handle")).toBe(false);
    expect(copiedUrl.searchParams.has("review")).toBe(false);
    expect(copiedUrl.searchParams.has("local")).toBe(false);
    expect(copiedUrl.hash).toBe("");
  }, 20000);

  test("host Start button is disabled until three players are ready", async () => {
    const room = `cdp-start-${Date.now().toString(36)}`;
    const alice = await newPage(`/?room=${room}&handle=Alice&local=1`);
    await alice.click("create-season");
    await alice.waitFor(`document.body.innerText.toLowerCase().includes('game lobby')`);
    const summary = await alice.eval<string>(`document.querySelector('[data-testid="rules-summary"]').innerText`);
    expect(summary).toContain("Starter Categories");
    expect(summary).toContain("points 20/10/7/5/3");
    expect(summary).toContain("best five rounds");
    await alice.waitFor(`document.querySelector('[data-testid="start-season"]').disabled === true`);

    const bob = await newPage(`/?room=${room}&handle=Bob&local=1`);
    await alice.waitFor(`document.body.innerText.includes('2 ready')`);
    expect(await alice.eval<boolean>(`document.querySelector('[data-testid="start-season"]').disabled`)).toBe(true);

    const cora = await newPage(`/?room=${room}&handle=Cora&local=1`);
    await alice.waitFor(`document.body.innerText.includes('3 ready')`);
    expect(await alice.eval<boolean>(`document.querySelector('[data-testid="start-season"]').disabled`)).toBe(false);
  }, 20000);

  test("keyboard focus has a visible focus ring", async () => {
    const room = `cdp-focus-${Date.now().toString(36)}`;
    const page = await newPage(`/?room=${room}&handle=Alice&local=1`);
    await page.waitFor(`document.querySelector('[data-testid="create-season"]')`);
    await page.focus("create-season");
    const focusStyle = await page.eval<{ width: string; style: string; color: string }>(`
      (() => {
        const computed = getComputedStyle(document.activeElement);
        return {
          width: computed.outlineWidth,
          style: computed.outlineStyle,
          color: computed.outlineColor
        };
      })()
    `);
    expect(focusStyle.style).not.toBe("none");
    expect(parseFloat(focusStyle.width)).toBeGreaterThanOrEqual(3);
  }, 20000);

  test("reduced-motion preference suppresses sprout animation", async () => {
    const room = `cdp-reduced-motion-${Date.now().toString(36)}`;
    const { alice, bob, cora } = await setupThreePlayers(room);
    await alice.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });

    await alice.waitFor(`document.querySelectorAll('[data-testid="field-option"]').length === 2`);
    await alice.click("field-option");
    await bob.waitFor(`document.querySelector('[data-testid="seed-input"]')`);
    await bob.type("seed-input", "Bale");
    await bob.click("plant-seed");

    await bob.waitFor(`document.querySelector('[data-testid="letter-input-0"]')`);
    await fillAndSubmitLetters(bob, { 0: "h", 1: "s" });
    await cora.waitFor(`document.querySelector('[data-testid="letter-input-2"]')`);
    await fillAndSubmitLetters(cora, { 2: "c", 3: "w" });
    await alice.waitFor(`document.querySelector('.slot.filled')`);

    const motion = await alice.eval<{ matches: boolean; maxMs: number; duration: string }>(`
      (() => {
        function toMs(value) {
          const trimmed = value.trim();
          if (!trimmed) return 0;
          if (trimmed.endsWith('ms')) return Number.parseFloat(trimmed);
          if (trimmed.endsWith('s')) return Number.parseFloat(trimmed) * 1000;
          return Number.parseFloat(trimmed);
        }
        const slot = document.querySelector('.slot.filled');
        const duration = getComputedStyle(slot).animationDuration;
        return {
          matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
          duration,
          maxMs: Math.max(...duration.split(',').map(toMs))
        };
      })()
    `);
    expect(motion.matches).toBe(true);
    expect(motion.maxMs).toBeLessThanOrEqual(0.02);
  }, 20000);

  test("three handles complete the first round without revealing the answer to the guesser UI", async () => {
    const room = `cdp-${Date.now().toString(36)}`;
    const { alice, bob, cora } = await setupThreePlayers(room);
    await alice.waitFor(`document.querySelectorAll('[data-testid="field-option"]').length === 2`);
    await bob.waitFor(`document.body.innerText.includes('The guesser is choosing a category.')`);
    await cora.waitFor(`document.body.innerText.includes('The guesser is choosing a category.')`);
    expect(await bob.count("field-option")).toBe(0);
    expect(await cora.count("field-option")).toBe(0);

    const aliceAgain = await newPage(`/?room=${room}&handle=Alice&local=1`);
    await aliceAgain.waitFor(`document.querySelectorAll('[data-testid="field-option"]').length === 2`);

    const chosenField = await alice.eval<string>(`document.querySelector('[data-testid="field-option"] strong')?.innerText ?? ''`);
    await alice.click("field-option");
    await bob.waitFor(`document.querySelector('[data-testid="seed-input"]')`);
    await cora.waitFor(`document.body.innerText.includes('The picker is choosing the answer.')`);
    await alice.waitFor(`document.body.innerText.includes(${JSON.stringify(chosenField)})`);
    await cora.waitFor(`document.body.innerText.includes(${JSON.stringify(chosenField)})`);
    expect(await bob.eval<boolean>(`document.body.innerText.includes(${JSON.stringify(chosenField)})`)).toBe(true);
    expect(await cora.has("seed-input")).toBe(false);
    expect(await alice.has("seed-input")).toBe(false);
    await bob.type("seed-input", "Bale");
    await bob.click("plant-seed");

    await alice.waitFor(`document.body.innerText.includes('The cluers are adding letters.')`);
    expect(await alice.eval<boolean>(`document.body.innerText.toLowerCase().includes('bale')`)).toBe(false);

    await bob.waitFor(`document.querySelector('[data-testid="letter-input-0"]')`);
    await bob.send("Emulation.setDeviceMetricsOverride", {
      width: 2048,
      height: 1240,
      deviceScaleFactor: 1,
      mobile: false,
    });
    expect(
      await bob.eval<boolean>(`
        (() => {
          const inputs = Array.from(document.querySelectorAll('.clue-letter-input'));
          const button = document.querySelector('[data-testid="submit-letters"]');
          if (!inputs.length || !(button instanceof HTMLElement)) return false;
          const inputBottom = Math.max(...inputs.map((input) => input.getBoundingClientRect().bottom));
          return button.getBoundingClientRect().top >= inputBottom + 8;
        })()
      `),
    ).toBe(true);
    await cora.waitFor(`document.querySelector('[data-testid="letter-input-2"]')`);
    expect(await bob.eval<boolean>(`document.body.innerText.includes('Answer: Bale')`)).toBe(true);
    expect(await cora.eval<boolean>(`document.body.innerText.includes('Answer: Bale')`)).toBe(true);
    expect(
      await bob.eval<string[]>(
        `Array.from(document.querySelectorAll('.clue-letter-input')).map((input) => input.getAttribute('name') ?? '')`,
      ),
    ).toEqual(["letter-0-1", "letter-1-1"]);
    expect(await bob.eval<boolean>(`/clue word|intended|whole word/i.test(document.body.innerText)`)).toBe(false);
    await fillAndSubmitLetters(bob, { 0: "h", 1: "s" });
    await alice.waitFor(`document.querySelector('[data-testid="planting-status-0"]')?.dataset.state === 'planted'`);
    const plantingStatus = await alice.eval<string>(`document.querySelector('[data-testid="planting-status"]').innerText`);
    expect(plantingStatus).toContain("Row 1");
    expect(plantingStatus).toContain("Bob");
    expect(plantingStatus).toContain("Submitted");
    expect(plantingStatus).toContain("Cora");
    expect(plantingStatus).toContain("Waiting");
    expect(await alice.eval<boolean>(`document.querySelector('[data-testid="planting-status"]').innerText.includes('H')`)).toBe(false);

    await fillAndSubmitLetters(cora, { 2: "c", 3: "w" });

    await alice.waitFor(`document.querySelector('[data-testid="guess-input"]')`);
    await alice.waitFor(`document.querySelectorAll('.slot.filled .clue-letter').length === 4`);
    const clueLetters = await alice.eval<string[]>(`
      Array.from(document.querySelectorAll('.slot.filled .clue-letter')).map((cell) => cell.textContent.trim())
    `);
    expect(clueLetters.sort()).toEqual(["C", "H", "S", "W"]);
    expect(await alice.eval<number>(`document.querySelectorAll('img.letter-sprite').length`)).toBe(0);
    expect(await alice.eval<string>(`document.querySelector('[data-testid="current-ribbon"]').innerText`)).toBe("Current Points: 20");
    await alice.type("guess-input", "bale");
    await alice.click("submit-guess");
    await alice.waitFor(`document.querySelector('[data-testid="guess-confirmation"]')`);
    await alice.click("confirm-guess");
    await alice.waitFor(`document.querySelector('[data-testid="revealed-seed"]')?.innerText === 'Bale'`);
    expect(await alice.eval<string>(`document.querySelector('[data-testid="revealed-seed"]').innerText`)).toBe("Bale");
    expect(await alice.eval<string>(`document.querySelector('[data-testid="running-county-fair"]').innerText`)).toBe(
      "Final score so far: 20 / 100",
    );
    expect(await alice.eval<boolean>(`document.querySelector('[data-testid="player-legend"]').innerText.includes('Bob')`)).toBe(true);
    expect(await alice.eval<boolean>(`document.querySelector('[data-testid="player-legend"]').innerText.includes('Cora')`)).toBe(true);
  }, 20000);

  test("planting waits on an offline Hand without auto-filling or revealing draft letters", async () => {
    const room = `cdp-offline-hand-${Date.now().toString(36)}`;
    const events = plantingWithOfflineHandEvents(room);
    const page = await newPage(`/?local=1`);
    await page.send("Storage.clearDataForOrigin", { origin: appUrl, storageTypes: "local_storage" });
    await page.eval(`localStorage.setItem(${JSON.stringify(`sowsear:events:${room}`)}, ${JSON.stringify(JSON.stringify(events))})`);
    await page.send("Page.navigate", { url: `${appUrl}/?room=${room}&handle=Alice&local=1` });
    await page.waitFor("document.readyState === 'complete'");
    await page.waitFor(`document.querySelector('[data-testid="planting-status-2"]')?.dataset.presence === 'offline'`);

    expect(await page.has("guess-input")).toBe(false);
    expect(await page.eval<string>(`document.querySelector('[data-testid="planting-status-0"]').dataset.state`)).toBe("planted");
    expect(await page.eval<string>(`document.querySelector('[data-testid="planting-status-2"]').dataset.state`)).toBe("waiting");
    expect(await page.eval<string>(`document.querySelector('[data-testid="planting-status-2"]').dataset.presence`)).toBe("offline");
    expect(
      await page.eval<boolean>(
        `Array.from(document.querySelectorAll('[data-testid^="clue-cell"]')).map((cell) => cell.innerText).join('').includes('H')`,
      ),
    ).toBe(false);
    expect(
      await page.eval<boolean>(
        `Array.from(document.querySelectorAll('[data-testid^="clue-cell"]')).map((cell) => cell.innerText).join('').includes('S')`,
      ),
    ).toBe(false);
  }, 20000);

  test("answer phase waits on an offline picker without exposing answer controls to other players", async () => {
    const room = `cdp-offline-picker-${Date.now().toString(36)}`;
    const events = answerPhaseWithOfflinePickerEvents(room);
    const page = await newPage(`/?local=1`);
    await page.send("Storage.clearDataForOrigin", { origin: appUrl, storageTypes: "local_storage" });
    await page.eval(`localStorage.setItem(${JSON.stringify(`sowsear:events:${room}`)}, ${JSON.stringify(JSON.stringify(events))})`);
    await page.send("Page.navigate", { url: `${appUrl}/?room=${room}&handle=Cora&local=1` });
    await page.waitFor("document.readyState === 'complete'");
    await page.waitFor(`document.body.innerText.includes('The picker is choosing the answer.')`);

    expect(await page.has("seed-input")).toBe(false);
    expect(await page.has("submit-letters")).toBe(false);
    expect(await page.has("guess-input")).toBe(false);
    expect(await page.eval<boolean>(`document.body.innerText.includes('Secret Answer')`)).toBe(false);
  }, 20000);

  test("guesser call waits on an offline guesser without handing Guess controls to cluers", async () => {
    const room = `cdp-offline-guesser-${Date.now().toString(36)}`;
    const events = guesserCallWithOfflineGuesserEvents(room);
    const page = await newPage(`/?local=1`);
    await page.send("Storage.clearDataForOrigin", { origin: appUrl, storageTypes: "local_storage" });
    await page.eval(`localStorage.setItem(${JSON.stringify(`sowsear:events:${room}`)}, ${JSON.stringify(JSON.stringify(events))})`);
    await page.send("Page.navigate", { url: `${appUrl}/?room=${room}&handle=Bob&local=1` });
    await page.waitFor("document.readyState === 'complete'");
    await page.waitFor(`document.body.innerText.includes('The guesser is deciding.')`);

    expect(await page.eval<boolean>(`document.body.innerText.includes('Answer: Bale')`)).toBe(true);
    expect(await page.has("guess-input")).toBe(false);
    expect(await page.has("one-more-letter")).toBe(false);
    expect(await page.has("spoil")).toBe(false);
    expect(await page.has("revealed-seed")).toBe(false);
  }, 20000);

  test("local room polling does not clear a draft letter before submit", async () => {
    const room = `cdp-draft-${Date.now().toString(36)}`;
    const { alice, bob } = await setupThreePlayers(room);
    await alice.waitFor(`document.querySelectorAll('[data-testid="field-option"]').length === 2`);
    await alice.click("field-option");
    await bob.waitFor(`document.querySelector('[data-testid="seed-input"]')`);
    await bob.type("seed-input", "Bale");
    await bob.click("plant-seed");

    await bob.waitFor(`document.querySelector('[data-testid="letter-input-0"]')`);
    await bob.type("letter-input-0", "q");
    await Bun.sleep(450);
    expect(await bob.eval<string>(`document.querySelector('[data-testid="letter-input-0"]').value`)).toBe("Q");
  }, 20000);

  test("duplicate letter Submit presses produce one planting command", async () => {
    const room = `cdp-duplicate-submit-${Date.now().toString(36)}`;
    const { alice, bob } = await setupThreePlayers(room);
    await alice.waitFor(`document.querySelectorAll('[data-testid="field-option"]').length === 2`);
    await alice.click("field-option");
    await bob.waitFor(`document.querySelector('[data-testid="seed-input"]')`);
    await bob.type("seed-input", "Bale");
    await bob.click("plant-seed");

    await bob.waitFor(`document.querySelector('[data-testid="letter-input-0"]')`);
    await bob.eval(`
      (() => {
        for (const [rowIndex, letter] of Object.entries({ 0: 'h', 1: 's' })) {
          const input = document.querySelector(\`[data-testid="letter-input-\${rowIndex}"]\`);
          if (!(input instanceof HTMLInputElement)) throw new Error(\`Missing letter input \${rowIndex}\`);
          input.value = String(letter);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const button = document.querySelector('[data-testid="submit-letters"]');
        if (!(button instanceof HTMLButtonElement)) throw new Error('Missing submit-letters button');
        button.click();
        button.click();
      })()
    `);
    await bob.waitFor(`document.querySelectorAll('[data-testid^="letter-input-"]').length === 0`);
    const bobPlantEvents = await bob.eval<number>(`
      JSON.parse(localStorage.getItem(${JSON.stringify(`sowsear:events:${room}`)}))
        .filter((event) => event.type === 'letters.planted' && event.actorHandle === 'Bob').length
    `);
    expect(bobPlantEvents).toBe(1);
    expect(await bob.eval<boolean>(`document.body.innerText.includes('Waiting for the handoff')`)).toBe(true);
  }, 20000);

  test("Guesser cannot wait at five cells and pass resolves the round at zero", async () => {
    const room = `cdp-fifth-${Date.now().toString(36)}`;
    const { alice, bob, pages: playerPages } = await setupThreePlayers(room);
    await alice.waitFor(`document.querySelectorAll('[data-testid="field-option"]').length === 2`);
    await alice.click("field-option");
    await bob.waitFor(`document.querySelector('[data-testid="seed-input"]')`);
    await bob.type("seed-input", "Bale");
    await bob.click("plant-seed");

    for (let depth = 1; depth <= 4; depth += 1) {
      await fillCurrentLetters(playerPages);
      await alice.waitFor(`document.querySelector('[data-testid="one-more-letter"]')`);
      await alice.click("one-more-letter");
    }

    await fillCurrentLetters(playerPages);
    await alice.waitFor(`document.querySelector('[data-testid="spoil"]')`);
    expect(await alice.has("one-more-letter")).toBe(false);
    await alice.click("spoil");
    await alice.waitFor(`document.querySelector('[data-testid="revealed-seed"]')?.innerText === 'Bale'`);
    expect(await alice.eval<boolean>(`document.body.innerText.includes('Points') && document.body.innerText.includes('0')`)).toBe(true);
  }, 30000);

  test("Picker can accept a near-miss Guess as correct in Chromium", async () => {
    const room = `cdp-accept-${Date.now().toString(36)}`;
    const { alice, bob, cora, pages: playerPages } = await setupThreePlayers(room);
    await alice.waitFor(`document.querySelectorAll('[data-testid="field-option"]').length === 2`);
    await alice.click("field-option");
    await bob.waitFor(`document.querySelector('[data-testid="seed-input"]')`);
    await bob.type("seed-input", "Bale");
    await bob.click("plant-seed");
    await fillCurrentLetters(playerPages);

    await alice.waitFor(`document.querySelector('[data-testid="guess-input"]')`);
    await alice.type("guess-input", "haystack");
    await alice.click("submit-guess");
    await alice.waitFor(`document.querySelector('[data-testid="guess-confirmation"]')`);
    await alice.click("confirm-guess");
    await bob.waitFor(`document.querySelector('[data-testid="accept-guess"]')`);
    await alice.waitFor(`document.querySelector('[data-testid="adjudication-guess"]')?.innerText === 'haystack'`);
    expect(await alice.eval<boolean>(`document.body.innerText.includes('The picker is judging the guess.')`)).toBe(true);
    expect(await alice.eval<boolean>(`document.body.innerText.includes('Bale')`)).toBe(false);
    expect(await bob.eval<boolean>(`document.body.innerText.includes('Answer') && document.body.innerText.includes('Bale')`)).toBe(true);
    expect(await bob.eval<boolean>(`document.body.innerText.includes('Guess') && document.body.innerText.includes('haystack')`)).toBe(true);
    await cora.waitFor(`document.body.innerText.includes('The picker is judging the guess.')`);
    expect(await cora.eval<boolean>(`document.body.innerText.includes('haystack')`)).toBe(false);
    expect(await cora.eval<boolean>(`document.body.innerText.includes('Answer: Bale')`)).toBe(true);
    await bob.click("accept-guess");
    await alice.waitFor(`document.querySelector('[data-testid="revealed-seed"]')?.innerText === 'Bale'`);
    expect(await alice.eval<boolean>(`document.body.innerText.includes('Points') && document.body.innerText.includes('20')`)).toBe(true);
  }, 20000);

  test("4, 5, and 8 player games expose standard Row counts in Chromium", async () => {
    for (const count of [4, 5, 8]) {
      const room = `cdp-count-${count}-${Date.now().toString(36)}`;
      const { pages: playerPages } = await setupPlayerCount(room, count);
      const guesser = playerPages[0]!;
      const picker = playerPages[1]!;

      await guesser.waitFor(`document.querySelectorAll('[data-testid="field-option"]').length === 2`);
      await guesser.click("field-option");
      await picker.waitFor(`document.querySelector('[data-testid="seed-input"]')`);
      await picker.type("seed-input", `Answer ${count}`);
      await picker.click("plant-seed");

      await waitForTotalLetterInputs(playerPages, count - 1);
      expect(await guesser.eval<number>(`document.querySelectorAll('[data-testid^="letter-input-"]').length`)).toBe(0);
      expect(await guesser.eval<boolean>(`document.body.innerText.includes('Answer ${count}')`)).toBe(false);
      for (const hand of playerPages.slice(1)) {
        expect(await hand.eval<number>(`document.querySelectorAll('[data-testid^="letter-input-"]').length`)).toBe(1);
      }
    }
  }, 30000);

  test("keyboard-only controls complete a round across lobby, category, answer, rows, guess, and picker judgment", async () => {
    const room = `cdp-keyboard-${Date.now().toString(36)}`;
    const alice = await newPage(`/?room=${room}&handle=Alice&local=1`);
    await alice.activate("create-season");
    await alice.waitFor(`document.body.innerText.toLowerCase().includes('game lobby')`);

    const bob = await newPage(`/?room=${room}&handle=Bob&local=1`);
    await alice.waitFor(`document.body.innerText.includes('2 ready')`);

    const cora = await newPage(`/?room=${room}&handle=Cora&local=1`);

    await alice.waitFor(`document.body.innerText.includes('3 ready')`);
    await alice.waitFor(`document.querySelector('[data-testid="start-season"]').disabled === false`);
    expect(await alice.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("start-season");
    await alice.activate("start-season");
    await alice.waitFor(`document.querySelectorAll('[data-testid="field-option"]').length === 2`);
    expect(await alice.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("field-option");
    await alice.activate("field-option");

    await bob.waitFor(`document.querySelector('[data-testid="seed-input"]')`);
    expect(await bob.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("seed-input");
    await bob.keyboardType("seed-input", "Bale");
    await bob.pressEnter();

    await bob.waitFor(`document.querySelector('[data-testid="letter-input-0"]')`);
    expect(await bob.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("letter-input-0");
    await bob.click("word-end-0");
    expect(await bob.eval<boolean>(`document.querySelector('[data-testid="word-end-0"]').checked`)).toBe(true);
    await bob.keyboardType("letter-input-0", "h");
    expect(await bob.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("letter-input-1");
    await bob.keyboardType("letter-input-1", "s");
    expect(await bob.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("submit-letters");
    await bob.pressEnter();
    await bob.waitFor(`document.querySelectorAll('[data-testid^="letter-input-"]').length === 0`);

    await cora.waitFor(`document.querySelector('[data-testid="letter-input-2"]')`);
    expect(await cora.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("letter-input-2");
    await cora.keyboardType("letter-input-2", "c");
    expect(await cora.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("letter-input-3");
    await cora.keyboardType("letter-input-3", "w");
    expect(await cora.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("submit-letters");
    await cora.pressEnter();
    await cora.waitFor(`document.querySelectorAll('[data-testid^="letter-input-"]').length === 0`);

    await alice.waitFor(`document.querySelector('[data-testid="guess-input"]')`);
    expect(
      await alice.eval<boolean>(`
        (() => {
          const cell = document.querySelector('[data-testid="clue-cell-0-1"]');
          return cell?.querySelector('.clue-letter')?.textContent.replace(/\\s+/g, '') === 'H.';
        })()
      `),
    ).toBe(true);
    expect(
      await alice.eval<boolean>(`
        (() => {
          const widths = Array.from(document.querySelectorAll('.slot')).map((cell) => Math.round(cell.getBoundingClientRect().width));
          return widths.length >= 4 && new Set(widths).size === 1;
        })()
      `),
    ).toBe(true);
    expect(await alice.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("guess-input");
    await alice.keyboardType("guess-input", "hay bale");
    await alice.pressEnter();
    await alice.waitFor(`document.querySelector('[data-testid="guess-confirmation"]')`);
    expect(await alice.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("confirm-guess");
    await alice.activate("confirm-guess");
    await bob.waitFor(`document.querySelector('[data-testid="accept-guess"]')`);
    expect(await bob.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("accept-guess");
    await bob.activate("accept-guess");
    await alice.waitFor(`document.querySelector('[data-testid="revealed-seed"]')?.innerText === 'Bale'`);
    expect(await alice.eval<boolean>(`document.body.innerText.includes('Points') && document.body.innerText.includes('20')`)).toBe(true);
  }, 20000);

  test("blank creates a trailing blank and the next turn edits that blank plus a new cell", async () => {
    const room = `cdp-skip-${Date.now().toString(36)}`;
    const { alice, bob, cora } = await setupThreePlayers(room);

    await alice.waitFor(`document.querySelectorAll('[data-testid="field-option"]').length === 2`);
    await alice.click("field-option");
    await bob.waitFor(`document.querySelector('[data-testid="seed-input"]')`);
    await bob.type("seed-input", "Bale");
    await bob.click("plant-seed");

    await bob.waitFor(`document.querySelector('[data-testid="letter-input-0"]')`);
    await bob.click("skip-cell-0");
    expect(await bob.eval<string>(`document.querySelector('[data-testid="skip-input-0"]').value`)).toBe("1");
    expect(await bob.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("letter-input-1");
    await bob.keyboardType("letter-input-1", "s");
    await bob.pressEnter();

    await cora.waitFor(`document.querySelector('[data-testid="letter-input-2"]')`);
    await fillAndSubmitLetters(cora, { 2: "c", 3: "w" });

    await alice.waitFor(`document.querySelector('[data-testid="guess-input"]')`);
    expect(await alice.eval<boolean>(`document.querySelector('[data-testid="clue-cell-0-1"]').classList.contains('skipped')`)).toBe(true);
    expect(await alice.eval<string>(`document.querySelector('[data-testid="clue-cell-0-1"]').innerText.trim()`)).toBe("");

    await alice.click("one-more-letter");
    const rowZeroCluer = await findPageWith(
      [bob, cora],
      `document.querySelector('[data-testid="letter-input-0"]') && document.querySelectorAll('[data-testid^="clue-cell-0-"]').length === 2`,
    );
    expect(await rowZeroCluer.eval<boolean>(`document.querySelector('[data-testid="clue-cell-0-1"] input[data-testid="letter-input-0"]') !== null`)).toBe(true);
    expect(await rowZeroCluer.eval<boolean>(`document.querySelector('[data-testid="clue-cell-0-2"] input[data-testid="letter-input-0"]') !== null`)).toBe(true);
    expect(await rowZeroCluer.eval<number>(`document.querySelectorAll('[data-testid="letter-input-0"]').length`)).toBe(2);
  }, 20000);

  test("same room and handle reopen restores each active round phase", async () => {
    const room = `cdp-reopen-${Date.now().toString(36)}`;
    const { alice, bob, cora } = await setupThreePlayers(room);

    const aliceAtFieldChoice = await reopenSameHandle(room, "Alice", `document.querySelectorAll('[data-testid="field-option"]').length === 2`);
    expect(await aliceAtFieldChoice.eval<boolean>(`document.body.innerText.includes('Alice')`)).toBe(true);

    await alice.click("field-option");
    const bobAtSeed = await reopenSameHandle(room, "Bob", `document.querySelector('[data-testid="seed-input"]')`);
    expect(await bobAtSeed.eval<boolean>(`document.body.innerText.includes('Bob')`)).toBe(true);

    await bob.type("seed-input", "Bale");
    await bob.click("plant-seed");
    const bobAtPlanting = await reopenSameHandle(room, "Bob", `document.querySelector('[data-testid="letter-input-0"]')`);
    expect(await bobAtPlanting.eval<boolean>(`document.body.innerText.includes('Answer: Bale')`)).toBe(true);
    const aliceAtPlanting = await reopenSameHandle(room, "Alice", `document.body.innerText.includes('The cluers are adding letters.')`);
    expect(await aliceAtPlanting.eval<boolean>(`document.body.innerText.includes('Bale')`)).toBe(false);

    await fillAndSubmitLetters(bob, { 0: "h", 1: "s" });
    await fillAndSubmitLetters(cora, { 2: "c", 3: "w" });
    const aliceAtFarmerCall = await reopenSameHandle(room, "Alice", `document.querySelector('[data-testid="guess-input"]')`);
    expect(await aliceAtFarmerCall.has("one-more-letter")).toBe(true);

    await alice.type("guess-input", "hay bale");
    await alice.click("submit-guess");
    await alice.waitFor(`document.querySelector('[data-testid="guess-confirmation"]')`);
    await alice.click("confirm-guess");
    const bobAtAdjudication = await reopenSameHandle(room, "Bob", `document.querySelector('[data-testid="accept-guess"]')`);
    expect(await bobAtAdjudication.has("reject-guess")).toBe(true);

    await bob.click("reject-guess");
    const aliceAtRecap = await reopenSameHandle(room, "Alice", `document.querySelector('[data-testid="revealed-seed"]')?.innerText === 'Bale'`);
    expect(await aliceAtRecap.has("advance")).toBe(true);
    expect(await aliceAtRecap.eval<boolean>(`document.body.innerText.includes('Points') && document.body.innerText.includes('0')`)).toBe(true);
  }, 30000);

  test("host can reorder lobby seats and the new first seat becomes guesser", async () => {
    const room = `cdp-seats-${Date.now().toString(36)}`;
    const alice = await newPage(`/?room=${room}&handle=Alice&local=1`);
    await alice.click("create-season");
    await alice.waitFor(`document.body.innerText.toLowerCase().includes('game lobby')`);

    const bob = await newPage(`/?room=${room}&handle=Bob&local=1`);
    await alice.waitFor(`document.body.innerText.includes('2 ready')`);

    const cora = await newPage(`/?room=${room}&handle=Cora&local=1`);
    await alice.waitFor(`document.body.innerText.includes('3 ready')`);

    await alice.click("seat-up-Cora");
    await alice.waitFor(`Array.from(document.querySelectorAll('[data-testid="seat-name"]')).map((el) => el.innerText).join('|') === 'Alice|Cora|Bob'`);
    await alice.click("seat-up-Cora");
    await alice.waitFor(`Array.from(document.querySelectorAll('[data-testid="seat-name"]')).map((el) => el.innerText).join('|') === 'Cora|Alice|Bob'`);

    await alice.waitFor(`document.body.innerText.includes('3 ready')`);
    await alice.click("start-season");
    await cora.waitFor(`document.querySelectorAll('[data-testid="field-option"]').length === 2`);
    expect(await alice.eval<boolean>(`document.querySelectorAll('[data-testid="field-option"]').length === 0`)).toBe(true);
  }, 20000);

  test("complete game reaches final score and room review/replay survives same-handle reopen", async () => {
    const room = `cdp-full-${Date.now().toString(36)}`;
    const { alice, pages } = await setupThreePlayers(room);

    await playSecondRevealRound(pages, "Answer 1");
    await alice.waitFor(`document.querySelector('[data-testid="advance"]')`);
    await alice.click("advance");

    for (let i = 2; i <= 6; i += 1) {
      await playExactRound(pages, `Answer ${i}`);
      await alice.waitFor(`document.querySelector('[data-testid="advance"]')`);
      await alice.click("advance");
    }

    await alice.waitFor(`document.body.innerText.toLowerCase().includes('final score')`);
    expect(await alice.eval<boolean>(`document.body.innerText.includes('100 / 100')`)).toBe(true);
    expect(await alice.has("review-panel")).toBe(true);
    expect(await alice.has("copy-summary")).toBe(true);
    await alice.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    expect(await alice.eval<boolean>(`document.documentElement.scrollWidth <= window.innerWidth + 1`)).toBe(true);
    expect(await alice.eval<string>(`document.querySelector('[data-testid="all-ribbons"]').innerText`)).toBe(
      "Every Round: 10, 20, 20, 20, 20, 20",
    );
    expect(await alice.eval<string>(`document.querySelector('[data-testid="counted-ribbons"]').innerText`)).toBe(
      "Counted Rounds: 20, 20, 20, 20, 20",
    );
    const summary = await alice.eval<string>(`document.querySelector('[data-testid="summary-text"]').value`);
    expect(summary).toContain("Final Score 100 / 100");
    expect(summary).toContain("Best five rounds: 20, 20, 20, 20, 20");
    await alice.click("copy-summary");
    await alice.waitFor(`document.querySelector('[data-testid="error"]')?.innerText.includes('Summary')`);

    const gameId = await alice.eval<string>(`
      JSON.parse(localStorage.getItem(${JSON.stringify(`sowsear:events:${room}`)}))
        .find((event) => event.type === 'season.created').payload.gameId
    `);
    const reopened = await newPage(`/?room=${room}&handle=Alice&local=1&review=${encodeURIComponent(gameId)}`);
    await reopened.waitFor(`document.querySelector('[data-testid="review-panel"]')`);
    await reopened.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    expect(await reopened.eval<boolean>(`document.documentElement.scrollWidth <= window.innerWidth + 1`)).toBe(true);
    expect(await reopened.eval<boolean>(`document.body.innerText.includes('Round 6')`)).toBe(true);
    expect(await reopened.eval<string>(`document.querySelector('[data-testid="review-final-score"]').innerText`)).toBe(
      "Final score 100 / 100",
    );
    expect(await reopened.eval<boolean>(`document.querySelector('[data-testid="review-panel"]').innerText.includes('Alice')`)).toBe(true);
    await reopened.waitFor(`document.querySelector('[data-testid="harvest-replay-1"]')`);
    expect(await reopened.eval<number>(`document.querySelectorAll('[data-testid="replay-step-1-1"] .slot.filled').length`)).toBe(4);
    expect(await reopened.eval<number>(`document.querySelectorAll('[data-testid="replay-step-1-2"] .slot.filled').length`)).toBe(8);

    await alice.click("rematch");
    await alice.waitFor(`document.body.innerText.toLowerCase().includes('game lobby')`);
    expect(await alice.eval<boolean>(`document.body.innerText.includes('Review 100')`)).toBe(true);
    expect(
      await alice.eval<number>(`
        JSON.parse(localStorage.getItem(${JSON.stringify(`sowsear:events:${room}`)}))
          .filter((event) => event.type === 'season.created').length
      `),
    ).toBe(2);
  }, 30000);

  test("host emergency controls pause, transfer, resume, and void a round", async () => {
    const room = `cdp-host-${Date.now().toString(36)}`;
    const { alice, bob } = await setupThreePlayers(room);

    await alice.waitFor(`document.querySelector('[data-testid="pause-season"]')`);
    await alice.click("pause-season");
    await alice.waitFor(`document.querySelector('[data-testid="paused-panel"]')`);

    await alice.eval(`
      const select = document.querySelector('[data-testid="host-transfer-select"]');
      select.value = 'Bob';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    `);
    await alice.click("transfer-host-selected");

    await bob.waitFor(`document.querySelector('[data-testid="resume-season"]')`);
    await bob.click("resume-season");
    await bob.waitFor(`!document.querySelector('[data-testid="paused-panel"]')`);
    await bob.click("void-harvest");
    await bob.waitFor(`document.body.innerText.toLowerCase().includes('round recap')`);
    expect(await bob.eval<boolean>(`document.body.innerText.includes('Points') && document.body.innerText.includes('0')`)).toBe(true);
    await bob.click("advance");
    await bob.waitFor(`document.body.innerText.includes('ROUND 2 OF 6')`);
    await bob.waitFor(`document.querySelectorAll('[data-testid="field-option"]').length === 2`);
  }, 20000);

  test("non-host can recover host controls when the host is offline", async () => {
    const room = `cdp-host-offline-${Date.now().toString(36)}`;
    const events = activeGameWithOfflineHostEvents(room);
    const bob = await newPage(`/?local=1`);
    await bob.send("Storage.clearDataForOrigin", { origin: appUrl, storageTypes: "local_storage" });
    await bob.eval(`localStorage.setItem(${JSON.stringify(`sowsear:events:${room}`)}, ${JSON.stringify(JSON.stringify(events))})`);
    await bob.send("Page.navigate", { url: `${appUrl}/?room=${room}&handle=Bob&local=1` });
    await bob.waitFor("document.readyState === 'complete'");
    await bob.waitFor(`document.querySelector('[data-testid="host-offline-panel"]')`);
    expect(await bob.has("pause-season")).toBe(false);

    await bob.click("claim-host");
    await bob.waitFor(`document.querySelector('[data-testid="pause-season"]')`);
    expect(await bob.has("host-offline-panel")).toBe(false);
    expect(await bob.eval<boolean>(`document.body.innerText.includes('Host') && document.body.innerText.includes('Pause')`)).toBe(true);
  }, 20000);

  test("real Instant transport syncs lobby and resumes the same Room handle", async () => {
    if (!process.env.BUN_PUBLIC_INSTANT_APP_ID) return;
    const room = `cdp-instant-${Date.now().toString(36)}`;
    const alice = await newPage(`/?room=${room}&handle=Alice`);
    await alice.waitFor(`document.querySelector('[data-testid="create-season"]')`, 12000);
    await alice.click("create-season");
    await alice.waitFor(`document.body.innerText.toLowerCase().includes('game lobby')`, 12000);

    const bob = await newPage(`/?room=${room}&handle=Bob`);
    await bob.waitFor(`document.querySelector('[data-testid="toggle-ready"]')`, 12000);
    await alice.waitFor(`document.body.innerText.includes('Bob') && document.body.innerText.includes('2 ready')`, 12000);
    expect(await alice.eval<boolean>(`document.body.innerText.includes('Bob')`)).toBe(true);

    const bobAgain = await newPage(`/?room=${room}&handle=Bob`);
    await bobAgain.waitFor(`document.querySelector('[data-testid="toggle-ready"]')`, 12000);
    expect(await bobAgain.has("join-season")).toBe(false);
    expect(await bobAgain.eval<number>(`document.querySelectorAll('[data-testid="seat-Bob"]').length`)).toBe(1);
    expect(await bobAgain.eval<string>(`document.querySelector('[data-testid="seat-Bob"]').innerText`)).toContain("Ready");
    await alice.waitFor(`document.querySelectorAll('[data-testid="seat-Bob"]').length === 1`, 12000);
  }, 30000);

  test("mobile viewport has no horizontal overflow and supports keyboard activation", async () => {
    const room = `cdp-mobile-${Date.now().toString(36)}`;
    const page = await newPage(`/?room=${room}&handle=Alice&local=1`);
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await page.send("Page.navigate", { url: `${appUrl}/?room=${room}&handle=Alice&local=1` });
    await page.waitFor("document.readyState === 'complete'");
    await page.waitFor(`document.querySelector('[data-testid="create-season"]')`);
    expect(await page.eval<boolean>(`document.documentElement.scrollWidth <= window.innerWidth + 1`)).toBe(true);
    await page.eval(`document.querySelector('[data-testid="create-season"]').focus()`);
    expect(await page.eval<string>(`document.activeElement?.dataset?.testid ?? ''`)).toBe("create-season");
    await page.pressEnter();
    await page.waitFor(`document.body.innerText.toLowerCase().includes('game lobby')`);
  }, 20000);

  test("mobile entry screen shows one brand title and no shell duplicate", async () => {
    const page = await newPage(`/?local=1`);
    await page.send("Storage.clearDataForOrigin", { origin: appUrl, storageTypes: "local_storage" });
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await page.send("Page.navigate", { url: `${appUrl}/?local=1` });
    await page.waitFor("document.readyState === 'complete'");
    await page.waitFor(`document.querySelector('[data-testid="room-input"]')`);
    expect(await page.eval<boolean>(`document.documentElement.scrollWidth <= window.innerWidth + 1`)).toBe(true);
    expect(await page.eval<number>(`document.querySelectorAll('.brand-title, .brand-pig, .handle-mascot').length`)).toBe(0);
    expect(await page.eval<number>(`document.querySelectorAll('.topbar-brand').length`)).toBe(0);
  }, 20000);
});
