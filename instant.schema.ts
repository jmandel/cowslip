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
