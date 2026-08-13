const { normalizeJid } = require("../utils/jid");

const MAX_GROUP_BUFFER = 150;
const MAX_USER_RECENT = 20;

const SHORT_REPLY_POOL = ["anyway", "relax", "you", "hi", "what", "not really", "maybe"];
const IGNORED_BANK = {
  playful: ["yo i exist btw", "im literally right here", "include me too"],
  teasing: ["damn no one talks to me here", "nice, didnt invite me", "you all having fun without me"],
  jealous: ["so we acting like i dont exist?", "you all talk like im invisible", "not even one reply for me huh"],
  dry: ["alright", "noted", "cool", "ill just watch"],
  passive: ["nice, just ignore me then", "yeah im just decoration", "ill remember this"]
};

function createSocialStateService(options = {}) {
  const logger = options.logger;
  const users = new Map();
  const groups = new Map();

  function captureMessage(message) {
    if (!message || !message.chatId || !message.senderId || message.isFromMe) return null;

    const groupId = normalizeJid(message.chatId);
    const userId = normalizeJid(message.senderId);
    const now = Date.now();
    const text = String(message.text || "").trim();
    const low = text.toLowerCase();

    const group = getGroup(groupId);
    const user = getUser(userId);
    if (message.pushName && !user.name) user.name = String(message.pushName).trim().slice(0, 40);

    user.recent.push(text);
    if (user.recent.length > MAX_USER_RECENT) {
      user.recent.splice(0, user.recent.length - MAX_USER_RECENT);
    }

    const keyword = extractKeyword(low);
    if (keyword) {
      user.keywords.push(keyword);
      if (user.keywords.length > 30) {
        user.keywords.splice(0, user.keywords.length - 30);
      }
    }

    updateTone(user, low);

    group.buffer.push({
      userId,
      text: text.slice(0, 320),
      ts: now,
      mentions: Array.isArray(message.mentions) ? message.mentions.map(normalizeJid).slice(0, 8) : []
    });
    if (group.buffer.length > MAX_GROUP_BUFFER) {
      group.buffer.splice(0, group.buffer.length - MAX_GROUP_BUFFER);
    }
    group.lastMessageAt = now;
    group.messagesSinceBot += 1;
    group.activityWindow.push(now);
    trimActivityWindow(group, now);

    const event = extractEvent(message, user, low);
    if (event) {
      group.events.push(event);
      if (group.events.length > 80) {
        group.events.splice(0, group.events.length - 80);
      }
    }

    return event;
  }

  function markBotReply(chatId) {
    const group = getGroup(normalizeJid(chatId));
    group.lastBotAt = Date.now();
    group.messagesSinceBot = 0;
  }

  function getUserProfile(userId, name) {
    const user = getUser(normalizeJid(userId));
    if (name && !user.name) user.name = String(name).trim().slice(0, 40);
    return {
      tone: user.tone,
      nickname: user.nickname,
      relation: user.relation,
      name: user.name
    };
  }

  function maybeInjectName(reply, userProfile) {
    const text = String(reply || "").trim();
    if (!text || !userProfile || !userProfile.name) return text;
    if (Math.random() > 0.3) return text;
    if (/^[a-z0-9_ ]{2,30},\s/i.test(text)) return text;
    return `${userProfile.name}, ${text}`;
  }

  function maybeCallback(chatId, userId) {
    if (Math.random() > 0.2) return "";
    const group = getGroup(normalizeJid(chatId));
    const user = getUser(normalizeJid(userId));
    const all = [...user.keywords.slice(-8), ...collectRecentKeywords(group.buffer.slice(-60))];
    const keyword = pickRandom(all.filter(Boolean));
    if (!keyword) return "";
    return `oh that ${keyword} thing again`;
  }

  function maybeShortReply(intent) {
    const chance = intent === "question" ? 0.04 : 0.08;
    if (Math.random() > chance) return "";
    return pickRandom(SHORT_REPLY_POOL);
  }

  function maybeIgnoredLine(chatId) {
    const group = getGroup(normalizeJid(chatId));
    const now = Date.now();
    trimActivityWindow(group, now);

    const enoughMessages = group.messagesSinceBot >= 25;
    const enoughSilence = now - group.lastBotAt >= 5 * 60 * 1000;
    const cooldownOk = now - group.lastIgnoredAt >= randomInt(10, 20) * 60 * 1000;
    const active = group.activityWindow.length >= 18;
    if (!enoughMessages || !enoughSilence || !cooldownOk || !active) return "";

    group.lastIgnoredAt = now;
    const tone = pickRandom(["playful", "teasing", "jealous", "dry", "passive"]);
    return pickRandom(IGNORED_BANK[tone] || []);
  }

  function getRecentEvents(chatId, limit = 10) {
    const group = getGroup(normalizeJid(chatId));
    return group.events.slice(-Math.max(1, Number(limit || 10)));
  }

  return {
    captureMessage,
    markBotReply,
    getUserProfile,
    maybeInjectName,
    maybeCallback,
    maybeShortReply,
    maybeIgnoredLine,
    getRecentEvents
  };

  function getUser(userId) {
    let user = users.get(userId);
    if (!user) {
      user = {
        tone: "tease",
        nickname: "",
        relation: "neutral",
        name: "",
        recent: [],
        keywords: []
      };
      users.set(userId, user);
    }
    return user;
  }

  function getGroup(groupId) {
    let group = groups.get(groupId);
    if (!group) {
      group = {
        buffer: [],
        events: [],
        messagesSinceBot: 0,
        lastBotAt: Date.now(),
        lastIgnoredAt: 0,
        activityWindow: [],
        lastMessageAt: 0
      };
      groups.set(groupId, group);
    }
    return group;
  }

  function updateTone(user, text) {
    const isFriendly = /\bthanks|thank you|cute|love|nice\b/.test(text);
    const isAnnoying = /\bstupid|idiot|shut up|wtf\b/.test(text);
    const isNew = user.recent.length < 4;
    const flirt = /\blove you|kiss|flirt|gf|bf\b/.test(text);

    if (isNew) {
      user.tone = "tease";
      user.relation = "neutral";
      return;
    }
    if (isAnnoying) {
      user.tone = "dry";
      user.relation = "annoying";
      user.nickname = "problem child";
      return;
    }
    if (flirt || isFriendly) {
      user.tone = "flirty";
      user.relation = "liked";
      if (!user.nickname) user.nickname = "anime kid";
      return;
    }
    user.tone = "tease";
    if (user.relation !== "annoying") user.relation = "neutral";
  }
}

function extractKeyword(text) {
  if (!text) return "";
  const candidates = [
    "anime",
    "bocchi",
    "naruto",
    "gojo",
    "genshin",
    "sleep",
    "insomnia",
    "love",
    "flirt",
    "breakup",
    "fight",
    "sad"
  ];
  return candidates.find((k) => text.includes(k)) || "";
}

function collectRecentKeywords(buffer) {
  const out = [];
  for (const row of buffer || []) {
    const k = extractKeyword(String(row && row.text ? row.text : "").toLowerCase());
    if (k) out.push(k);
  }
  return out.slice(-20);
}

function extractEvent(message, user, lowText) {
  const groupId = normalizeJid(message.chatId);
  const userId = normalizeJid(message.senderId);
  const mentions = Array.isArray(message.mentions) ? message.mentions.map(normalizeJid) : [];

  if (/\breject|rejected|left on seen|ignored me\b/.test(lowText)) {
    return {
      groupId,
      userId,
      targetUserId: mentions[0] || "",
      type: "rejection",
      summary: "got rejected vibe in chat",
      confidence: 0.72,
      createdAt: new Date()
    };
  }
  if (/\bflirt|i love you|kiss me|date me\b/.test(lowText) && mentions.length) {
    return {
      groupId,
      userId,
      targetUserId: mentions[0] || "",
      type: "failed_flirt",
      summary: "flirt attempt detected",
      confidence: 0.66,
      createdAt: new Date()
    };
  }
  if (/\bignore me|nobody replies|invisible\b/.test(lowText)) {
    return {
      groupId,
      userId,
      targetUserId: "",
      type: "attention_seek",
      summary: "attention seeking signal",
      confidence: 0.62,
      createdAt: new Date()
    };
  }
  if (/\banime\b/.test(lowText) && user && user.nickname !== "anime kid") {
    return {
      groupId,
      userId,
      targetUserId: "",
      type: "anime_obsession",
      summary: "repeated anime interest",
      confidence: 0.58,
      createdAt: new Date()
    };
  }
  return null;
}

function trimActivityWindow(group, now) {
  const cutoff = now - 10 * 60 * 1000;
  group.activityWindow = group.activityWindow.filter((ts) => ts >= cutoff);
}

function pickRandom(list) {
  if (!Array.isArray(list) || !list.length) return "";
  return list[Math.floor(Math.random() * list.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = {
  createSocialStateService
};
