const publicReadAppend = {
  allow: {
    view: "true",
    create: "true",
    update: "true",
    delete: "false",
  },
};

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
  rooms: publicReadAppend,
  roomHandles: publicReadAppend,
  games: publicReadAppend,
  gamePlayers: publicReadAppend,
  categories: {
    allow: {
      view: "true",
      create: "false",
      update: "false",
      delete: "false",
    },
  },
  rounds: publicReadAppend,
  roundHandleViews: publicReadAppend,
  arrows: publicReadAppend,
  clueEntries: publicReadAppend,
  phaseLocks: {
    allow: {
      view: "false",
      create: "true",
      update: "false",
      delete: "false",
    },
  },
  roundDecisions: publicReadAppend,
  gameEvents: publicReadAppend,
};

export default rules;
