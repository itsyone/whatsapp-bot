const CALLBACK_TEMPLATES = {
  fake99: ["99 again", "still pushing fake 99", "old man lore again"],
  gooner: ["gooner behavior again", "classic no filter move", "of course you said that"],
  animeKid: ["anime kid logic", "another anime brain moment", "you live in edits huh"]
};

const TOPIC_TEMPLATES = {
  kazuki: ["kazuki planet again", "still stuck in space lore", "you never left that planet huh"],
  love: ["that was quick", "you fall too fast", "you say that to everyone"],
  age16: ["bro youre 16 relax", "youre 16 slow down", "not now kid"]
};

function sanitizeReply(text) {
  return String(text || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function finalizeReply(text) {
  let out = sanitizeReply(text);
  out = out.replace(/\bI am\b/gi, "im").replace(/\bI'm\b/g, "im");
  out = out.replace(/[!]{2,}/g, "!");
  out = out
    .replace(/\bdon't you think\b/gi, "")
    .replace(/\bwe both know\b/gi, "")
    .replace(/\bfor now\b/gi, "")
    .replace(/\bperhaps\b/gi, "maybe");

  const words = out.split(/\s+/).filter(Boolean);
  if (words.length > 14) out = words.slice(0, 14).join(" ");
  return out.trim();
}

function scoreReply(reply, input, thread) {
  const out = String(reply || "");
  const low = out.toLowerCase();
  const inLow = String(input || "").toLowerCase();
  let score = 100;

  if (out.split(/\s+/).filter(Boolean).length > 14) score -= 20;
  if (/whirlwind|destiny|ancient one|my heart|dimension|eternal/.test(low)) score -= 40;
  if (/😊|😏|😎|😂|😍|😘/.test(out)) score -= 20;
  if (inLow.includes("?") && /\bmaybe|perhaps|lets focus|can't answer\b/.test(low)) score -= 22;
  if (/\b(as an ai|i cannot|i cant assist)\b/.test(low)) score -= 25;

  const recent = (thread && thread.history ? thread.history : [])
    .filter((x) => x && x.role === "assistant" && x.content)
    .slice(-3)
    .map((x) => sanitizeReply(x.content).toLowerCase());
  if (recent.includes(low)) score -= 30;

  return score;
}

function needsRegen(score) {
  return Number(score) < 70;
}

function buildRegenHint(score, intent) {
  const base = `Previous draft score ${score}/100. Rewrite shorter and more natural.`;
  if (intent === "question") return `${base} Answer direct.`;
  if (intent === "roast") return `${base} Dry roast only, one line.`;
  if (intent === "flirty") return `${base} Keep subtle tease, no explicit text.`;
  return `${base} No poetic style.`;
}

function applyDeterministicCallback(reply, input, thread) {
  const text = String(input || "").toLowerCase();
  if (!/\b(who am i|remember|nickname|what do you know)\b/.test(text)) return reply;

  const profile = thread && thread.profile ? thread.profile : {};
  const key = callbackKeyFromProfile(profile);
  if (!key) return reply;
  const template = pickTemplate(CALLBACK_TEMPLATES[key], text);
  if (!template) return reply;

  return `${reply} ${template}`.trim();
}

function applyTopicFlavor(reply, input, style) {
  const low = String(input || "").toLowerCase();
  let key = "";
  if (/\bkazuki\b|\bplanet\b|\bspace\b/.test(low)) key = "kazuki";
  else if (/\blove you\b|\bmy gf\b|\bgf\b/.test(low)) key = "love";
  else if (/\b16\b|\bteen\b/.test(low)) key = "age16";
  if (!key) return reply;

  // Controlled randomness: mostly on tease/chaotic/roast styles.
  const allow = style === "chaotic" || style === "tease" || style === "roast";
  if (!allow) return reply;
  if (Math.random() >= 0.45) return reply;

  const list = TOPIC_TEMPLATES[key];
  if (!Array.isArray(list) || !list.length) return reply;
  const pick = list[hash(low) % list.length];
  return `${reply} ${pick}`.trim();
}

function callbackKeyFromProfile(profile) {
  if (!profile) return "";
  if (profile.lies >= 2 && String(profile.ageClaim || "") === "99") return "fake99";
  if (profile.goons >= 2) return "gooner";
  if (profile.anime >= 2) return "animeKid";
  return "";
}

function pickTemplate(bank, seedText) {
  const list = Array.isArray(bank) ? bank : [];
  if (!list.length) return "";
  const seed = hash(seedText);
  return list[seed % list.length];
}

function hash(text) {
  let h = 0;
  const str = String(text || "");
  for (let i = 0; i < str.length; i += 1) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

module.exports = {
  sanitizeReply,
  finalizeReply,
  scoreReply,
  needsRegen,
  buildRegenHint,
  applyDeterministicCallback,
  applyTopicFlavor
};
