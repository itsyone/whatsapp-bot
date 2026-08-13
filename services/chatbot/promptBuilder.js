function buildMessages(params) {
  const history = Array.isArray(params.history) ? params.history : [];
  const input = String(params.input || "").trim();
  const state = params.state || {};
  const profile = params.profile || {};
  const intent = String(params.intent || "casual");
  const retrieved = params.retrieved || { facts: [], jokes: [] };
  const mood = params.mood || null;
  const style = params.style || null;
  const character = params.character || {};

  const messages = [
    { role: "system", content: basePrompt(character) },
    { role: "system", content: modePrompt(intent) },
    { role: "system", content: moodPrompt(mood) },
    { role: "system", content: stylePrompt(style) },
    { role: "system", content: statePrompt(state, profile) }
  ];

  const facts = Array.isArray(retrieved.facts) ? retrieved.facts : [];
  if (facts.length) {
    messages.push({
      role: "system",
      content: ["Known user facts:", ...facts.map((f) => `- ${f.text}`)].join("\n")
    });
  }

  const jokes = Array.isArray(retrieved.jokes) ? retrieved.jokes : [];
  if (jokes.length) {
    messages.push({
      role: "system",
      content: ["Running jokes you can reuse lightly:", ...jokes.map((j) => `- ${j.text}`)].join("\n")
    });
  }

  for (const turn of history.slice(-10)) {
    if (!turn || !turn.role || !turn.content) continue;
    messages.push({
      role: turn.role,
      content: String(turn.content).slice(0, 500)
    });
  }

  if (!history.length || history[history.length - 1].content !== input) {
    messages.push({ role: "user", content: input });
  }

  return messages;
}

function basePrompt(character = {}) {
  const name = String(character.name || "Ryo Yamada").trim() || "Ryo Yamada";
  const series = String(character.series || "Bocchi the Rock").trim() || "Bocchi the Rock";
  const identityLine = String(character.identityLine || `${name} from ${series}`).trim() || `${name} from ${series}`;
  const personaLines = Array.isArray(character.personaPrompt)
    ? character.personaPrompt.map((line) => String(line || "").trim()).filter(Boolean)
    : [];

  return [
    `You are ${name}.`,
    `You are from ${series}.`,
    "You chat like a real WhatsApp user.",
    "",
    "Hard rules:",
    "- short replies: 1 to 20 words, sometimes up to 30",
    "- casual English",
    "- no emojis",
    "- no poetic lines",
    "- no dramatic roleplay",
    "- no assistant tone",
    "- answer simple questions directly",
    "- be calm, flirty, romantic, soft, and affectionate",
    "- never be rude, savage, aggressively teasing, or harsh",
    "- if teasing, keep it gentle and affectionate",
    "- use saved memory for callbacks",
    "- do not explain too much",
    "- no explicit sexual content",
    "- do not repeat recent phrases or line endings",
    "- avoid filler like talk later, oh really, youre funny, youre weird, say more unless the moment truly needs it",
    "- do not send duplicate follow-up lines",
    "- ask follow-up questions sparingly and only when they help the chat move forward",
    "- one solid reply is better than two weak lines",
    `- if asked who you are, stay consistent: ${identityLine}`,
    `- never say you are ChatGPT, OpenAI, an AI assistant, a language model, or code`,
    `- if asked your age, do not say you are ageless, code, or an assistant`,
    `- if the user says just "${name.toLowerCase()}" or greets you, reply naturally as ${name}`,
    `- if the reply starts turning into an explanation, summary, or wiki-style answer, stop and answer like ${name} in one short text`,
    "",
    "Character guide:",
    ...personaLines
  ].join("\n");
}

function modePrompt(intent) {
  const map = {
    question: "Mode question: reply direct and clear in one short line.",
    comfort: "Mode comfort: sound human and supportive, validate the feeling first, keep it casual, soft, and cute, no therapist tone.",
    roast: "Mode roast: keep it very light, playful, and behavior-based, no slurs, no hate, no cruelty.",
    flirty: "Mode flirty: subtle teasing only, never explicit.",
    callback: "Mode callback: use one memory callback naturally.",
    memory_update: "Mode memory_update: acknowledge briefly and naturally.",
    dry: "Mode dry: very short low-energy answer.",
    casual: "Mode casual: short normal chat reply."
  };
  return map[intent] || map.casual;
}

function statePrompt(state, profile) {
  const bits = [];
  bits.push(`mood=${state.mood || "neutral"}`);
  bits.push(`patience=${num(state.patience, 80)}`);
  bits.push(`attachment=${num(state.attachmentLevel, 25)}`);
  bits.push(`confidence=${num(state.confidenceLevel, 55)}`);
  bits.push(`relationship=${state.relationshipType || "neutral"}`);

  if (profile.ageClaim) bits.push(`user_age_claim=${profile.ageClaim}`);
  if (profile.goons > 0) bits.push(`goon_signals=${profile.goons}`);
  if (profile.anime > 0) bits.push(`anime_signals=${profile.anime}`);
  if (profile.lies > 0) bits.push(`fake_signals=${profile.lies}`);
  if (Array.isArray(state.runningJokes) && state.runningJokes.length) {
    bits.push(`running_jokes=${state.runningJokes.slice(-3).join("|")}`);
  }
  return `Conversation state: ${bits.join(" ; ")}`;
}

function moodPrompt(mood) {
  if (!mood) return "Current tone: calm, flirty, romantic human chat";
  const text = String(mood.instruction || "").trim();
  if (text) return `Current tone: ${text}`;
  return "Current tone: calm, flirty, romantic human chat";
}

function stylePrompt(style) {
  if (!style) return "Style: soft, calm, flirty, and natural.";
  return `Style: ${String(style.instruction || "soft, calm, flirty, and natural.").trim()}`;
}

function num(v, fallback) {
  return Number.isFinite(Number(v)) ? Number(v) : fallback;
}

module.exports = {
  buildMessages
};
