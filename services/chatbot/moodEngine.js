const MOODS = ["dry", "teaser", "flirty", "friendly", "chaotic", "calm"];
const STYLES = ["dry", "tease", "soft", "chaotic"];

function detectMood(input, userMemory) {
  const text = String(input || "").toLowerCase();
  const hits = [];

  if (/\b(ok|k|hmm|fine|whatever|idk)\b/.test(text)) hits.push("dry");
  if (/\b(lol|haha|lmao|funny|joke)\b/.test(text)) hits.push("teaser");
  if (/\b(stupid|wtf|bro|clown|fake|99|goon|roast)\b/.test(text)) hits.push("dry");
  if (/\b(love|miss you|cute|date|kiss|hot|horny)\b/.test(text)) hits.push("flirty");
  if (/\b(yo|hey|sup|hello|good morning|good night)\b/.test(text)) hits.push("friendly");
  if (/\b(listen|focus|do it|obey|watch your tone)\b/.test(text)) hits.push("calm");
  if (/\b(glitch|random|cursed|weird|chaos)\b/.test(text)) hits.push("chaotic");

  if (hits.length) return hits[0];
  return userMemory && userMemory.mood && userMemory.mood.current ? userMemory.mood.current : "teaser";
}

function applyMoodSwitch(userMood, nextMood, input) {
  const mood = normalizeMoodObject(userMood);
  const target = isValidMood(nextMood) ? nextMood : mood.current;
  const now = Date.now();
  const elapsed = now - Number(mood.lastSwitch || 0);
  const strength = switchStrength(input, target);

  if (target !== mood.current) {
    const canSwitch = elapsed > 5 * 60 * 1000 || strength >= 2;
    if (canSwitch) {
      mood.current = target;
      mood.lastSwitch = now;
      mood.intensity = clamp(mood.intensity * 0.4 + 0.6, 0.25, 1);
    } else {
      mood.intensity = clamp(mood.intensity * 0.92, 0.2, 1);
    }
    return mood;
  }

  mood.intensity = clamp(mood.intensity + 0.03, 0.2, 1);
  mood.lastSeen = now;
  return mood;
}

function moodInstruction(mood, intensity) {
  const level = Number(intensity || 0.5);
  const bank = {
    dry: "Reply very short low effort minimal words",
    teaser: "Reply playful lightly teasing casual and cute",
    flirty: "Reply shy teasing non explicit and sweet",
    friendly: "Reply chill warm cute but short",
    chaotic: "Reply slightly weird playful but still cute and short",
    calm: "Reply gentle cool and composed with only a tiny bit of attitude"
  };
  const line = bank[mood] || bank.teaser;

  if (level >= 0.8) return `${line}. Keep tone stronger than usual.`;
  if (level <= 0.35) return `${line}. Keep tone soft.`;
  return `${line}. Keep tone balanced.`;
}

function chooseStyle(params) {
  const mood = String(params && params.mood ? params.mood : "teaser");
  const intent = String(params && params.intent ? params.intent : "casual");
  const base = styleFromMoodAndIntent(mood, intent);

  // Controlled unpredictability: small chance to spike into another style.
  if (Math.random() < 0.3) {
    const options = STYLES.filter((x) => x !== base);
    const pick = options[Math.floor(Math.random() * options.length)];
    return pick || base;
  }

  return base;
}

function styleInstruction(style) {
  const map = {
    dry: "Style dry: minimal words, low energy, no extra explanation.",
    tease: "Style tease: playful, lightly smug, cute, compact line.",
    soft: "Style soft: warm, cute, reassuring, still brief.",
    chaotic: "Style chaotic: weird playful exaggeration, but not mean."
  };
  return map[style] || map.tease;
}

function styleFromMoodAndIntent(mood, intent) {
  if (intent === "question") return "dry";
  if (intent === "comfort") return "soft";
  if (intent === "roast") return "tease";
  if (intent === "flirty") return "tease";
  if (intent === "callback") return mood === "chaotic" ? "chaotic" : "tease";

  if (mood === "dry") return "dry";
  if (mood === "friendly" || mood === "flirty" || mood === "calm") return "soft";
  if (mood === "chaotic") return "chaotic";
  return "tease";
}

function normalizeMoodObject(mood) {
  const current = isValidMood(mood && mood.current) ? mood.current : "teaser";
  return {
    current,
    intensity: clamp(Number(mood && mood.intensity), 0.2, 1, 0.6),
    lastSwitch: Number(mood && mood.lastSwitch) || 0,
    lastSeen: Number(mood && mood.lastSeen) || Date.now()
  };
}

function switchStrength(input, mood) {
  const text = String(input || "").toLowerCase();
  let score = 0;
  if (mood === "dry" && /\b(stupid|wtf|fake|99|goon|clown)\b/.test(text)) score += 1;
  if (mood === "flirty" && /\b(love|cute|kiss|date|horny|hot)\b/.test(text)) score += 2;
  if (mood === "dry" && /\b(ok|k|hmm|fine|idk)\b/.test(text)) score += 1;
  if (mood === "chaotic" && /\b(random|weird|cursed|glitch)\b/.test(text)) score += 2;
  if (mood === "friendly" && /\b(hey|hello|sup|yo)\b/.test(text)) score += 1;
  if (mood === "calm" && /\b(obey|listen|focus|watch your tone)\b/.test(text)) score += 1;
  return score;
}

function isValidMood(mood) {
  return MOODS.includes(String(mood || "").toLowerCase());
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback !== undefined ? fallback : min;
  return Math.max(min, Math.min(max, n));
}

module.exports = {
  MOODS,
  detectMood,
  applyMoodSwitch,
  moodInstruction,
  normalizeMoodObject,
  chooseStyle,
  styleInstruction
};
