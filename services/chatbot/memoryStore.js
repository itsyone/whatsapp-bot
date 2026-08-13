const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { normalizeMoodObject } = require("./moodEngine");
const { readChatbotMemory, writeChatbotMemory } = require("../../lib/mongoStore");

const MEMORY_FILE = path.join(process.cwd(), "data", "memory.json");
const MAX_FACTS = 6;
const MAX_JOKES = 3;
const MAX_TOTAL_MEMORY_LINES = 9;
const MAX_FACT_TEXT = 150;
const MAX_JOKE_TEXT = 150;


function ensureMemoryDir() {
  const dir = path.dirname(MEMORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadMemory() {
  ensureMemoryDir();
  try {
    return readChatbotMemory();
  } catch {
    return {};
  }
}

async function hydrateMemoryFromSupabase(db) {
  return db || {};
}

function saveMemory(db, userId) {
  ensureMemoryDir();
  writeChatbotMemory(db || {}, userId);
}

function ensureUserRecord(db, userId) {
  if (!db[userId]) {
    db[userId] = normalizeUserRecord({
      name: null,
      facts: [],
      jokes: [],
      mood: normalizeMoodObject(null),
      relationship: {
        level: 0,
        trust: 0,
        closeness: 0,
        lastSeenAt: Date.now(),
        lastBotReplyAt: 0,
        ignoredCount: 0
      },
      behavior: {
        toxic: 0,
        funny: 0,
        dry: 0,
        horny: 0
      },
      topics: {},
      nicknames: [],
      preferences: {
        likes_roasts: false,
        hates_emojis: true
      },
      updatedAt: Date.now()
    });
    return db[userId];
  }

  db[userId] = normalizeUserRecord(db[userId]);
  return db[userId];
}

function upsertFact(db, userId, fact) {
  if (!userId || !fact || !fact.text) return;
  const user = ensureUserRecord(db, userId);
  const now = Date.now();
  const normalized = normalizeLegacyFact(fact);

  if (!normalized.text) return;

  const idx = user.facts.findIndex((x) => x && x.text === normalized.text && x.type === normalized.type);
  if (idx >= 0) {
    user.facts[idx].weight = Math.min(1, Number(user.facts[idx].weight || 0.5) + 0.05);
    user.facts[idx].ts = now;
  } else {
    user.facts.push({
      text: normalized.text,
      type: normalized.type,
      weight: normalized.weight,
      ts: now
    });
  }

  user.facts = user.facts
    .map(normalizeLegacyFact)
    .filter((x) => x.text)
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
    .slice(-MAX_FACTS);
  trimMemoryLines(user);
  user.updatedAt = now;
}

function upsertJoke(db, userId, text, strength = 0.7) {
  if (!userId || !text) return;
  const user = ensureUserRecord(db, userId);
  const now = Date.now();
  const safe = compactMemoryText(text, MAX_JOKE_TEXT);
  if (!safe) return;

  const idx = user.jokes.findIndex((x) => x && x.text === safe);
  if (idx >= 0) {
    user.jokes[idx].strength = Math.min(1, Number(user.jokes[idx].strength || 0.6) + 0.07);
    user.jokes[idx].ts = now;
  } else {
    user.jokes.push({ text: safe, strength: Math.max(0.2, Math.min(1, Number(strength) || 0.7)), ts: now });
  }

  user.jokes = user.jokes
    .map((x) => ({
      text: compactMemoryText(x && x.text ? x.text : "", MAX_JOKE_TEXT),
      strength: Math.max(0.2, Math.min(1, Number(x && x.strength ? x.strength : 0.7))),
      ts: Number(x && x.ts ? x.ts : Date.now())
    }))
    .filter((x) => x.text)
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
    .slice(-MAX_JOKES);
  trimMemoryLines(user);
  user.updatedAt = now;
}

function setUserName(db, userId, name) {
  if (!userId || !name) return;
  const user = ensureUserRecord(db, userId);
  const safe = String(name).trim().slice(0, 60);
  if (!safe) return;
  user.name = safe;
  user.updatedAt = Date.now();
}

function getUserMemory(db, userId) {
  const user = ensureUserRecord(db, userId);
  user.facts = user.facts.map(normalizeLegacyFact).slice(-MAX_FACTS);
  user.jokes = Array.isArray(user.jokes) ? user.jokes.slice(-MAX_JOKES) : [];
  trimMemoryLines(user);
  user.mood = normalizeMoodObject(user.mood);
  return user;
}

function setUserMood(db, userId, mood) {
  if (!userId) return;
  const user = ensureUserRecord(db, userId);
  user.mood = normalizeMoodObject(mood);
  user.updatedAt = Date.now();
}

function updateUserDynamics(db, userId, patch = {}) {
  if (!userId) return;
  const user = ensureUserRecord(db, userId);

  if (patch.relationship && typeof patch.relationship === "object") {
    user.relationship = {
      ...user.relationship,
      ...patch.relationship
    };
  }
  if (patch.behavior && typeof patch.behavior === "object") {
    user.behavior = {
      ...user.behavior,
      ...patch.behavior
    };
  }
  if (patch.topics && typeof patch.topics === "object") {
    user.topics = {
      ...user.topics,
      ...patch.topics
    };
  }
  if (Array.isArray(patch.nicknames) && patch.nicknames.length) {
    const set = new Set([...(user.nicknames || []), ...patch.nicknames.map((x) => String(x).trim()).filter(Boolean)]);
    user.nicknames = Array.from(set).slice(-20);
  }
  user.updatedAt = Date.now();
}

function normalizeLegacyFact(fact) {
  if (!fact) {
    return { text: "", type: "identity", weight: 0.5, ts: Date.now() };
  }

  if (typeof fact === "string") {
    const text = compactMemoryText(fact, MAX_FACT_TEXT);
    return {
      text: sanitizeFactText(text),
      type: inferFactType(text),
      weight: 0.6,
      ts: Date.now()
    };
  }

  const text = sanitizeFactText(compactMemoryText(fact.text || "", MAX_FACT_TEXT));
  return {
    text,
    type: inferFactType(fact.type || text),
    weight: Math.max(0.2, Math.min(1, Number(fact.weight) || 0.6)),
    ts: Number(fact.ts) || Date.now()
  };
}

function compactMemoryText(input, maxLen) {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function sanitizeFactText(text) {
  const cleaned = compactMemoryText(String(text || "").replace(/^location_hint\s+/i, ""), MAX_FACT_TEXT);
  if (!cleaned) return "";
  if (/[?]/.test(cleaned)) return "";
  if (/\bwhere are you from\b|\bwhere you from\b/.test(cleaned)) return "";
  return cleaned;
}

function trimMemoryLines(user) {
  if (!user || typeof user !== "object") return;
  const facts = Array.isArray(user.facts) ? user.facts : [];
  const jokes = Array.isArray(user.jokes) ? user.jokes : [];

  user.facts = facts.slice(-MAX_FACTS);
  user.jokes = jokes.slice(-MAX_JOKES);

  while ((user.facts.length + user.jokes.length) > MAX_TOTAL_MEMORY_LINES) {
    const factTs = Number(user.facts[0] && user.facts[0].ts ? user.facts[0].ts : Infinity);
    const jokeTs = Number(user.jokes[0] && user.jokes[0].ts ? user.jokes[0].ts : Infinity);
    if (factTs <= jokeTs) user.facts.shift();
    else user.jokes.shift();
  }
}

function normalizeUserRecord(record) {
  const now = Date.now();
  const user = record && typeof record === "object" ? { ...record } : {};

  user.name = user.name ? String(user.name).trim().slice(0, 60) : null;
  user.facts = Array.isArray(user.facts) ? user.facts.map(normalizeLegacyFact).filter((x) => x.text) : [];
  user.jokes = Array.isArray(user.jokes)
    ? user.jokes
      .map((x) => ({
        text: compactMemoryText(x && x.text ? x.text : "", MAX_JOKE_TEXT),
        strength: Math.max(0.2, Math.min(1, Number(x && x.strength ? x.strength : 0.7))),
        ts: Number(x && x.ts ? x.ts : now)
      }))
      .filter((x) => x.text)
    : [];
  user.relationship = user.relationship && typeof user.relationship === "object"
    ? {
      level: Number(user.relationship.level || 0),
      trust: Number(user.relationship.trust || 0),
      closeness: Number(user.relationship.closeness || 0),
      lastSeenAt: Number(user.relationship.lastSeenAt || now),
      lastBotReplyAt: Number(user.relationship.lastBotReplyAt || 0),
      ignoredCount: Number(user.relationship.ignoredCount || 0)
    }
    : { level: 0, trust: 0, closeness: 0, lastSeenAt: now, lastBotReplyAt: 0, ignoredCount: 0 };
  user.behavior = user.behavior && typeof user.behavior === "object"
    ? {
      toxic: Number(user.behavior.toxic || 0),
      funny: Number(user.behavior.funny || 0),
      dry: Number(user.behavior.dry || 0),
      horny: Number(user.behavior.horny || 0)
    }
    : { toxic: 0, funny: 0, dry: 0, horny: 0 };
  user.topics = user.topics && typeof user.topics === "object" ? user.topics : {};
  user.nicknames = Array.isArray(user.nicknames)
    ? user.nicknames.map((x) => compactMemoryText(x, 32)).filter(Boolean).slice(-20)
    : [];
  user.mood = normalizeMoodObject(user.mood);
  user.preferences = user.preferences && typeof user.preferences === "object"
    ? {
      likes_roasts: Boolean(user.preferences.likes_roasts),
      hates_emojis: user.preferences.hates_emojis !== false
    }
    : { likes_roasts: false, hates_emojis: true };
  user.updatedAt = Number(user.updatedAt || now);
  trimMemoryLines(user);
  return user;
}

function pickNewerUserRecord(localUser, remoteUser) {
  const local = localUser ? normalizeUserRecord(localUser) : null;
  const remote = remoteUser ? normalizeUserRecord(remoteUser) : null;
  if (!local) return remote || normalizeUserRecord({});
  if (!remote) return local;
  return Number(remote.updatedAt || 0) >= Number(local.updatedAt || 0) ? remote : local;
}

function inferFactType(input) {
  const text = String(input || "").toLowerCase();
  if (/\banime|manga|waifu|music|game|movie|football|cricket\b/.test(text)) return "interest";
  if (/\broast|joke|funny|meme|goon|fake 99|piccolo\b/.test(text)) return "running_joke";
  if (/\bname|age|yo|year|from|city|tokyo|pakistan|india\b/.test(text)) return "identity";
  if (/\bfriend|bro|sis|daughter|son|couple\b/.test(text)) return "relationship";
  if (/\bemoji|reply|language|english\b/.test(text)) return "conversation_preference";
  return "identity";
}

module.exports = {
  loadMemory,
  saveMemory,
  hydrateMemoryFromSupabase,
  getUserMemory,
  setUserName,
  upsertFact,
  upsertJoke,
  setUserMood,
  updateUserDynamics,
  inferFactType
};
