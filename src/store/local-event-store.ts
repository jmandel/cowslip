import type { GameEvent, RoomPresence } from "../game/types";
import type { EventStore } from "./event-store";

type LockManagerLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

export class LocalEventStore implements EventStore {
  readonly mode = "local" as const;
  private callbacks = new Map<string, Set<(events: GameEvent[]) => void>>();
  private presenceCallbacks = new Map<string, Set<(presence: RoomPresence[]) => void>>();
  private channels = new Map<string, BroadcastChannel>();
  private intervals = new Map<string, number>();
  private snapshots = new Map<string, string>();
  private presenceSnapshots = new Map<string, string>();

  subscribe(roomSlug: string, callback: (events: GameEvent[]) => void): () => void {
    const callbacks = this.callbacks.get(roomSlug) ?? new Set();
    callbacks.add(callback);
    this.callbacks.set(roomSlug, callbacks);

    this.ensureChannel(roomSlug);
    if (!this.intervals.has(roomSlug)) {
      const interval = window.setInterval(() => this.emit(roomSlug), 250);
      this.intervals.set(roomSlug, interval);
      window.addEventListener("storage", (event) => {
        if (event.key === this.key(roomSlug)) this.emit(roomSlug);
        if (event.key === this.presenceKey(roomSlug)) this.emitPresence(roomSlug);
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

  subscribePresence(roomSlug: string, callback: (presence: RoomPresence[]) => void): () => void {
    const callbacks = this.presenceCallbacks.get(roomSlug) ?? new Set();
    callbacks.add(callback);
    this.presenceCallbacks.set(roomSlug, callbacks);
    this.ensureChannel(roomSlug);
    queueMicrotask(() => this.emitPresence(roomSlug, true));
    return () => {
      callbacks.delete(callback);
      if (!callbacks.size) this.presenceCallbacks.delete(roomSlug);
    };
  }

  async append(events: GameEvent[]): Promise<void> {
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

  private async appendUnlocked(roomSlug: string, events: GameEvent[]): Promise<void> {
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

  async markSeen(input: { roomSlug: string; handle: string; normalizedHandle: string; displayName: string }): Promise<void> {
    const now = Date.now();
    const presenceKey = `${input.roomSlug}:${input.normalizedHandle}`;
    const current = this.loadPresence(input.roomSlug);
    const existing = current.find((presence) => presence.presenceKey === presenceKey);
    const nextPresence: RoomPresence = {
      presenceKey,
      roomSlug: input.roomSlug,
      handle: input.handle,
      normalizedHandle: input.normalizedHandle,
      displayName: input.displayName,
      lastSeenAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const next = existing
      ? current.map((presence) => (presence.presenceKey === presenceKey ? nextPresence : presence))
      : [...current, nextPresence];
    localStorage.setItem(this.presenceKey(input.roomSlug), JSON.stringify(next));
    this.emitPresence(input.roomSlug);
    this.channels.get(input.roomSlug)?.postMessage({ type: "presence" });
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

  private load(roomSlug: string): GameEvent[] {
    const raw = localStorage.getItem(this.key(roomSlug));
    if (!raw) return [];
    return this.parse(raw);
  }

  private loadPresence(roomSlug: string): RoomPresence[] {
    const raw = localStorage.getItem(this.presenceKey(roomSlug));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as RoomPresence[]) : [];
    } catch {
      return [];
    }
  }

  private emitPresence(roomSlug: string, force = false): void {
    const raw = localStorage.getItem(this.presenceKey(roomSlug)) ?? "[]";
    if (!force && this.presenceSnapshots.get(roomSlug) === raw) return;
    this.presenceSnapshots.set(roomSlug, raw);
    const presence = this.loadPresence(roomSlug);
    for (const callback of this.presenceCallbacks.get(roomSlug) ?? []) {
      callback(presence);
    }
  }

  private ensureChannel(roomSlug: string): void {
    if (this.channels.has(roomSlug)) return;
    const channel = new BroadcastChannel(`cowslip:${roomSlug}`);
    channel.addEventListener("message", () => {
      this.emit(roomSlug);
      this.emitPresence(roomSlug);
    });
    this.channels.set(roomSlug, channel);
  }

  private parse(raw: string): GameEvent[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as GameEvent[]) : [];
    } catch {
      return [];
    }
  }

  private key(roomSlug: string): string {
    return `cowslip:events:${roomSlug}`;
  }

  private presenceKey(roomSlug: string): string {
    return `cowslip:presence:${roomSlug}`;
  }
}
