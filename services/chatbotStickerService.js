const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const settings = require("../settings");

const DEFAULT_MOOD = "tease";

function createChatbotStickerService(options = {}) {
  const logger = options.logger;
  const enabled = options.enabled !== false;
  const minTurns = Math.max(2, Number(options.minTurns || 4));
  const maxTurns = Math.max(minTurns, Number(options.maxTurns || 7));
  const maxChats = Math.max(50, Number(options.maxChats || 2000));

  const state = new Map();
  const stickerCache = new Map();
  const stickers = resolveStickerFiles();

  function shouldSend(chatId) {
    if (!enabled || !chatId || stickers.length === 0) return false;
    const s = getState(chatId);
    s.count += 1;
    if (s.count < s.nextAt) return false;

    s.count = 0;
    s.nextAt = randomTrigger(minTurns, maxTurns);
    s.updatedAt = Date.now();
    pruneStateIfNeeded();
    return true;
  }

  async function buildMessage(preferredMood = DEFAULT_MOOD) {
    if (stickers.length === 0) return null;
    const picked = pickStickerForMood(stickers, preferredMood);
    if (!picked) return null;

    try {
      const stickerBuffer = await getStickerBuffer(picked, stickerCache);
      if (!stickerBuffer) return null;
      return { sticker: stickerBuffer };
    } catch (error) {
      logger.warn(
        { file: picked, error: error && error.message ? error.message : String(error) },
        "Chatbot sticker read failed"
      );
      return null;
    }
  }

  function hasAssets() {
    return stickers.length > 0;
  }

  function getState(chatId) {
    let s = state.get(chatId);
    if (!s) {
      s = {
        count: 0,
        nextAt: randomTrigger(minTurns, maxTurns),
        updatedAt: Date.now()
      };
      state.set(chatId, s);
    }
    return s;
  }

  function pruneStateIfNeeded() {
    if (state.size <= maxChats) return;
    const entries = Array.from(state.entries()).sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
    const overflow = state.size - maxChats;
    for (let i = 0; i < overflow; i += 1) {
      state.delete(entries[i][0]);
    }
  }

  return {
    shouldSend,
    buildMessage,
    hasAssets
  };
}

async function getStickerBuffer(filePath, cache) {
  if (cache.has(filePath)) return cache.get(filePath);

  const input = fs.readFileSync(filePath);
  const webp = await sharp(input)
    .resize(512, 512, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();

  cache.set(filePath, webp);
  return webp;
}

function randomTrigger(minTurns, maxTurns) {
  if (minTurns === maxTurns) return minTurns;
  return Math.floor(Math.random() * (maxTurns - minTurns + 1)) + minTurns;
}

function resolveStickerFiles() {
  const bases = [
    path.join(process.cwd(), settings.chatbotStickerDir || path.join("assets", "new stickers")),
    path.join(process.cwd(), "assets", "new stickers"),
    path.join(process.cwd(), "chatbot-main", "assets"),
    path.join(process.cwd(), "src", "assets")
  ];

  for (const base of bases) {
    try {
      if (!fs.existsSync(base)) continue;
      const files = fs.readdirSync(base)
        .filter((name) => /\.(webp|png|jpe?g)$/i.test(name))
        .map((name) => path.join(base, name));
      if (files.length) return files;
    } catch (_) {
      continue;
    }
  }
  return [];
}

function pickStickerForMood(files, preferredMood) {
  const mood = normalizeMood(preferredMood);
  const exact = files.filter((file) => stickerMoodFromPath(file) === mood);
  if (exact.length) return exact[Math.floor(Math.random() * exact.length)];

  const fallbackOrder = fallbackMoodsFor(mood);
  for (const nextMood of fallbackOrder) {
    const bucket = files.filter((file) => stickerMoodFromPath(file) === nextMood);
    if (bucket.length) return bucket[Math.floor(Math.random() * bucket.length)];
  }

  return files[Math.floor(Math.random() * files.length)] || null;
}

function stickerMoodFromPath(filePath) {
  const name = path.basename(filePath).toLowerCase();
  return normalizeMood(name.split("__")[0]);
}

function normalizeMood(mood) {
  const value = String(mood || "").toLowerCase().trim();
  if (!value) return DEFAULT_MOOD;
  if (value === "friendly") return "soft";
  if (value === "flirty") return "shy";
  if (value === "dominant" || value === "roaster") return "dry";
  if (value === "chaotic") return "chaotic";
  if (value === "dry") return "dry";
  if (value === "calm") return "calm";
  if (value === "soft") return "soft";
  if (value === "shy") return "shy";
  if (value === "cute") return "cute";
  if (value === "tease" || value === "teaser") return "tease";
  return DEFAULT_MOOD;
}

function fallbackMoodsFor(mood) {
  const map = {
    soft: ["calm", "cute", "tease", "shy", "dry"],
    shy: ["cute", "soft", "calm", "tease"],
    cute: ["soft", "shy", "tease", "calm"],
    tease: ["cute", "soft", "dry", "chaotic"],
    dry: ["calm", "tease", "soft"],
    chaotic: ["tease", "cute", "dry"],
    calm: ["soft", "dry", "cute"]
  };
  return map[mood] || [DEFAULT_MOOD];
}

module.exports = {
  createChatbotStickerService
};
