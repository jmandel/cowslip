const mutablePublicState = {
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
  roomSummaries: mutablePublicState,
  roomPresence: mutablePublicState,
  gameEvents: {
    allow: {
      view: "true",
      create: "true",
      update: "false",
      delete: "false",
    },
  },
};

export default rules;
