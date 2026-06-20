import type { SowsEarEvent } from "../game/types";
import type { EventStore } from "./event-store";

type LockManagerLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

export class LocalEventStore implements EventStore {
  readonly mode = "local" as const;
  private callbacks = new Map<string, Set<(events: SowsEarEvent[]) => void>>();
  private channels = new Map<string, BroadcastChannel>();
  private intervals = new Map<string, number>();
  private snapshots = new Map<string, string>();

  subscribe(roomSlug: string, callback: (events: SowsEarEvent[]) => void): () => void {
    const callbacks = this.callbacks.get(roomSlug) ?? new Set();
    callbacks.add(callback);
    this.callbacks.set(roomSlug, callbacks);

    if (!this.channels.has(roomSlug)) {
      const channel = new BroadcastChannel(`sowsear:${roomSlug}`);
      channel.addEventListener("message", () => this.emit(roomSlug));
      this.channels.set(roomSlug, channel);
    }
    if (!this.intervals.has(roomSlug)) {
      const interval = window.setInterval(() => this.emit(roomSlug), 250);
      this.intervals.set(roomSlug, interval);
      window.addEventListener("storage", (event) => {
        if (event.key === this.key(roomSlug)) this.emit(roomSlug);
      });
    }

    queueMicrotask(() => this.emit(roomSlug, true));

    return () => {
      callbacks.delete(callback);
      if (!callbacks.size) {
        this.callbacks.delete(roomSlug);
        this.channels.get(roomSlug)?.close();
        this.channels.delete(roomSlug);
        const interval = this.intervals.get(roomSlug);
        if (interval) window.clearInterval(interval);
        this.intervals.delete(roomSlug);
      }
    };
  }

  async append(events: SowsEarEvent[]): Promise<void> {
    if (!events.length) return;
    const roomSlug = events[0]?.roomSlug;
    if (!roomSlug) return;
    const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
    if (locks) {
      await locks.request(this.key(roomSlug), async () => this.appendUnlocked(roomSlug, events));
      return;
    }
    await this.appendUnlocked(roomSlug, events);
  }

  private async appendUnlocked(roomSlug: string, events: SowsEarEvent[]): Promise<void> {
    const current = this.load(roomSlug);
    const seen = new Set(current.map((event) => event.actionId));
    const next = [...current];
    for (const event of events) {
      if (!seen.has(event.actionId)) {
        next.push(event);
        seen.add(event.actionId);
      }
    }
    localStorage.setItem(this.key(roomSlug), JSON.stringify(next));
    this.emit(roomSlug);
    this.channels.get(roomSlug)?.postMessage({ type: "events" });
  }

  private emit(roomSlug: string, force = false): void {
    const raw = localStorage.getItem(this.key(roomSlug)) ?? "[]";
    if (!force && this.snapshots.get(roomSlug) === raw) return;
    this.snapshots.set(roomSlug, raw);
    const events = this.parse(raw);
    for (const callback of this.callbacks.get(roomSlug) ?? []) {
      callback(events);
    }
  }

  private load(roomSlug: string): SowsEarEvent[] {
    const raw = localStorage.getItem(this.key(roomSlug));
    if (!raw) return [];
    return this.parse(raw);
  }

  private parse(raw: string): SowsEarEvent[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as SowsEarEvent[]) : [];
    } catch {
      return [];
    }
  }

  private key(roomSlug: string): string {
    return `sowsear:events:${roomSlug}`;
  }
}
