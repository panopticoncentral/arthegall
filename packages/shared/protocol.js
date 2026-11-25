export const proof = (nonce) => Buffer.from("arthegall.runner.v1/" + nonce);

export function isPromptCommand(type) {
  return type === "prompt" || type === "launch";
}

export const maxMessageBytes = 64 * 1024 * 1024;
export const replayPartBytes = 256 * 1024;

// The original JSON messages are version 1. Unversioned peers may have
// shipped either before or after replayPartBytes was introduced.
export const protocolVersion = 1;
export const replayFeature = "event-parts";
export const projectPathsFeature = "project-paths";
export const sessionSettingsFeature = "session-settings";
export const agentFeature = "agent-instructions";
export const protocolOffer = {
  protocolVersion,
  features: [
    replayFeature,
    projectPathsFeature,
    sessionSettingsFeature,
    agentFeature,
  ],
};

const text = (value) => typeof value === "string";
const id = (value) => text(value) && value.length > 0;
const seq = (value) => Number.isSafeInteger(value) && value >= 0;
const positive = (value) => seq(value) && value > 0;

// Codex advertises effort levels per model. Leave model identifiers and
// Codex effort names open so runners can use their own model catalogs.
const sessionSettings = {
  codex: {
    model: null,
    effort: null,
    approvalPolicy: ["untrusted", "on-request", "never"],
    approvalsReviewer: ["user", "auto_review"],
  },
  claude: {
    model: null,
    effort: ["low", "medium", "high", "xhigh", "max"],
    permissionMode: [
      "manual",
      "acceptEdits",
      "plan",
      "auto",
      "dontAsk",
      "bypassPermissions",
    ],
    permissionPrompts: ["host", "none"],
  },
};
export function sessionSettingsIssue(harness, settings) {
  if (settings === undefined) return null;
  if (
    !settings ||
    typeof settings !== "object" ||
    Array.isArray(settings) ||
    !Object.keys(settings).length
  )
    return "expected one or more session settings";
  if (!Object.hasOwn(sessionSettings, harness))
    return "unsupported harness for session settings";
  const supported = sessionSettings[harness];
  for (const [key, value] of Object.entries(settings)) {
    if (!Object.hasOwn(supported, key))
      return `${key} is not a ${harness} session setting`;
    if (supported[key]) {
      if (!supported[key].includes(value))
        return `${key} must be one of ${supported[key].join(", ")}`;
    } else if (
      typeof value !== "string" ||
      !value ||
      /^-|[\s\x00]/u.test(value)
    ) {
      return `invalid ${key} for ${harness}`;
    }
  }
  return null;
}
const list = (value, check) => Array.isArray(value) && value.every(check);
const handshake = (m) =>
  (m.protocolVersion === undefined || positive(m.protocolVersion)) &&
  (m.features === undefined || list(m.features, id));
const harnesses = (value) =>
  list(
    value,
    (h) =>
      h &&
      id(h.name) &&
      (h.agentInstructions === undefined ||
        typeof h.agentInstructions === "boolean") &&
      ["available", "unavailable", "unknown"].includes(h.status),
  );
const receiptStatuses = [
  "queued",
  "processing",
  "delivered",
  "uncertain",
  "failed",
  "canceled",
];
const commandFields = {
  launch: (c) =>
    (c.agent === undefined ||
      (c.agent &&
        id(c.agent.id) &&
        positive(c.agent.revision) &&
        id(c.agent.name) &&
        id(c.agent.prompt) &&
        c.agent.prompt.trim().length > 0)) &&
    id(c.harness) &&
    id(c.cwd) &&
    text(c.text) &&
    !sessionSettingsIssue(c.harness, c.settings) &&
    (c.additionalDirs === undefined ||
      list(c.additionalDirs, (p) => id(p) && p.startsWith("/"))),
  prompt: (c) => text(c.text),
  steer: (c) => id(c.target) && text(c.text),
  stop: (c) => id(c.target),
  end: () => true,
  approval: (c) => id(c.target) && typeof c.allow === "boolean",
  cancel: (c) => id(c.target) && isPromptCommand(c.targetType),
};
const events = {
  session: (e) => id(e.session) && id(e.state),
  receipt: (e) =>
    id(e.session) && id(e.command) && receiptStatuses.includes(e.status),
  inventory: (e) => harnesses(e.harnesses),
  item: (e) => id(e.session) && id(e.item) && e.value !== undefined,
  delta: (e) => id(e.session) && id(e.item) && text(e.text),
};
export function validEventRow(row) {
  const e = row?.event;
  return (
    positive(row?.seq) &&
    e &&
    id(e.type) &&
    Object.hasOwn(events, e.type) &&
    events[e.type](e)
  );
}
const fromRunner = {
  identify: (m) =>
    handshake(m) &&
    id(m.publicKey) &&
    id(m.signature) &&
    (m.runner === undefined || id(m.runner)),
  events: (m) => list(m.rows, validEventRow) && m.rows.length > 0,
  eventStart: (m) => positive(m.seq) && positive(m.bytes),
  ready: (m) => harnesses(m.harnesses),
  inspected: (m) =>
    list(
      m.outcomes,
      (o) =>
        o &&
        id(o.id) &&
        (o.status === "missing" || receiptStatuses.includes(o.status)),
    ),
};
const fromControl = {
  challenge: (m) => handshake(m) && id(m.nonce),
  pair: (m) => id(m.code) && positive(m.expires),
  welcome: (m) =>
    handshake(m) &&
    id(m.runner) &&
    seq(m.seq) &&
    (m.replayPartBytes === undefined ||
      (positive(m.replayPartBytes) &&
        m.replayPartBytes >= 128 &&
        m.replayPartBytes <= maxMessageBytes)),
  eventContinue: () => true,
  ack: (m) => seq(m.seq),
  inspect: (m) => list(m.ids, id),
  command: ({ command: c }) =>
    c &&
    id(c.id) &&
    id(c.session) &&
    id(c.runner) &&
    id(c.type) &&
    Object.hasOwn(commandFields, c.type) &&
    commandFields[c.type](c),
};

function decode(data, contract) {
  const m = JSON.parse(data);
  if (!m || !id(m.op) || !Object.hasOwn(contract, m.op) || !contract[m.op](m))
    throw Error("Invalid protocol message: " + (m?.op ?? "missing operation"));
  return m;
}
export const decodeRunnerMessage = (data) => decode(data, fromRunner);
export const decodeControlMessage = (data) => decode(data, fromControl);

export function versionIssue(version, remote) {
  if (version === undefined || version === protocolVersion) return null;
  const local = remote === "runner" ? "control plane" : "runner";
  return `Protocol versions differ. Update the ${version < protocolVersion ? remote : local}.`;
}
export function supportsEventParts(welcome) {
  return (
    welcome.replayPartBytes !== undefined &&
    (welcome.protocolVersion === undefined ||
      welcome.features?.includes(replayFeature) === true)
  );
}
