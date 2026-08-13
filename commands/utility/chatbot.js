const fs = require('fs');
const path = require('path');
const settings = require('../../settings');
const { getCurrentProfile } = require('../../lib/botContext');
const { PERMISSION_LEVELS, hasPermission } = require('../../lib/permissionMiddleware');
const { spamCache } = require('../../lib/cacheManager');
const { loadBotProfiles } = require('../../lib/botProfiles');
const Groq = require('groq-sdk');
const { downloadContentFromMessage } = require('../../lib/baileys');
const { InferenceClient } = require('@huggingface/inference');
const { createChatbotModule } = require('../../chatbot-module');
const { voiceEnabled, canUseHfVoice, synthesizeRyoVoiceNote } = require('../../lib/hfVoice');
const { getRegisteredProfile } = require('../../lib/registrationStore');
const { getBotDataPath } = require('../../lib/botDataPath');
const songCommand = require('../media/song');
const spotifyCommand = require('../media/spotify');
const { wifeCommand } = require('../social/wife');
let sharp = null;
try {
  sharp = require('sharp');
} catch {}

const CHATBOT_STICKER_EXTENSIONS = new Set(['.webp', '.png', '.jpg', '.jpeg']);
const CHATBOT_STICKERS_ENABLED = /^(1|true|yes|on)$/i.test(
  String(
    process.env.CHATBOT_STICKER_ENABLED ||
    process.env.CHATBOT_STICKERS ||
    ''
  ).trim()
);
const MAX_CHATBOT_INPUT_CHARS = Math.max(120, Number(process.env.CHATBOT_MAX_INPUT_CHARS || 700));
const CHATBOT_IMAGE_REPLIES_ENABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.CHATBOT_IMAGE_ENABLED || 'true').trim()
);
const CHATBOT_IMAGE_PROVIDER = String(process.env.CHATBOT_IMAGE_PROVIDER || 'hf-inference').trim();
const CHATBOT_IMAGE_MODELS = [
  process.env.CHATBOT_IMAGE_MODEL,
  'nlpconnect/vit-gpt2-image-captioning',
  'Salesforce/blip-image-captioning-base',
  'Salesforce/blip-image-captioning-large'
]
  .map((x) => String(x || '').trim())
  .filter(Boolean);
const CHATBOT_IMAGE_MAX_BYTES = Math.max(64 * 1024, Number(process.env.CHATBOT_IMAGE_MAX_BYTES || 4 * 1024 * 1024));
const CHATBOT_IMAGE_TIMEOUT_MS = Math.max(2000, Number(process.env.CHATBOT_IMAGE_TIMEOUT_MS || 12000));
const GLOBAL_HF_API_KEY = String(
  process.env.HF_API_KEY ||
  process.env.HUGGINGFACE_API_KEY ||
  process.env.HF_TOKEN ||
  ''
).trim();
const CHATBOT_MIN_DELAY_MS = Math.max(0, Number(process.env.CHATBOT_MIN_DELAY_MS || 500));
const CHATBOT_MAX_DELAY_MS = Math.max(CHATBOT_MIN_DELAY_MS, Number(process.env.CHATBOT_MAX_DELAY_MS || 1500));
const CHATBOT_STICKER_ONLY_CHANCE = Math.min(0.2, Math.max(0, Number(process.env.CHATBOT_STICKER_ONLY_CHANCE || 0.04)));
const CHATBOT_AUDIO_REPLIES_ENABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.CHATBOT_AUDIO_ENABLED || 'true').trim()
);
const CHATBOT_AUDIO_MAX_BYTES = Math.max(64 * 1024, Number(process.env.CHATBOT_AUDIO_MAX_BYTES || 25 * 1024 * 1024));
const CHATBOT_AUDIO_MODEL = String(process.env.CHATBOT_AUDIO_MODEL || 'whisper-large-v3-turbo').trim();
const CHATBOT_VOICE_NOTES_ENABLED = voiceEnabled();
let groqClient = null;
const chatbotStickerFilesCache = new Map();
const chatbotStickerRotation = new Map();
let cachedBotProfiles = null;
const HAIMIYA_STICKER_MOODS = {
  calm: ['download.jpg', '￴￴￴ en TikTok.jpg'],
  soft: ['Haimiya Mio.jpg', '￴￴￴ en TikTok.jpg'],
  shy: ['Haimiya Mio.jpg', 'Sylphy mersy_HOK di TikTok.jpg'],
  cute: ['Haimiya Mio (1).jpg', 'Haimiya (1).jpg'],
  tease: ['Haimiya Mio (1).jpg', 'Haimiya (1).jpg', 'download.jpg'],
  dry: ['Haimiya.jpg', 'download.jpg'],
  chaotic: ['Haimiya Mio.jpg', 'Haimiya (1).jpg']
};
const HAIMIYA_STICKER_EXCLUDED = new Set([
  'download (1).jpg',
  'pfp.jpg'
]); // FIXED: exclude non-Haimiya mood assets after visual review

const botModules = new Map();

function getCharacterProfile(profile = null) {
  return profile?.characterProfile || {
    name: settings.botName || 'Ryo Yamada',
    series: 'Bocchi the Rock',
    identityLine: `${settings.botName || 'Ryo Yamada'} from Bocchi the Rock`,
    tone: 'cool, cute, lightly teasing',
    personaPrompt: [
      'Your response MUST be between 20 and 35 words. Never give short one-word or one-sentence replies. Be descriptive and detailed within this limit.',
      'You speak casually like a real chat message. Stay cool, cute, lightly teasing and warm, never harsh.'
    ]
  };
}

function toEnvPrefix(profile = null) {
  return String(profile?.botId || 'eclipse')
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function normalizeIdentityToken(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeDigits(value = '') {
  return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function getBotProfiles() {
  if (!cachedBotProfiles) {
    cachedBotProfiles = loadBotProfiles(settings); // FIXED: share configured bot identities for chatbot loop prevention
  }
  return cachedBotProfiles;
}

function getKnownBotIdentityMap(sock, profile = null) {
  const activeProfile = profile || getCurrentProfile() || null;
  const numberSet = new Set();
  const nameSet = new Set();

  const currentSocketIds = [
    sock?.user?.id,
    sock?.user?.lid,
    `${String(sock?.user?.id || '').split(':')[0]}@s.whatsapp.net`,
    `${String(sock?.user?.lid || '').split(':')[0]}@lid`,
  ];

  for (const raw of currentSocketIds) {
    const digits = normalizeDigits(raw);
    if (digits) numberSet.add(digits);
  }

  for (const botProfile of getBotProfiles()) {
    const pairingDigits = normalizeDigits(botProfile?.pairingNumber);
    if (pairingDigits) numberSet.add(pairingDigits);

    const rawNames = [
      botProfile?.botName,
      botProfile?.characterProfile?.name
    ];

    for (const rawName of rawNames) {
      const normalizedName = normalizeIdentityToken(rawName);
      if (normalizedName) {
        nameSet.add(normalizedName);
        nameSet.add(normalizedName.replace(/[-_]+/g, ' ').trim());
      }
    }
  }

  const activeNames = [
    activeProfile?.botName,
    activeProfile?.characterProfile?.name
  ];
  for (const rawName of activeNames) {
    const normalizedName = normalizeIdentityToken(rawName);
    if (normalizedName) {
      nameSet.add(normalizedName);
      nameSet.add(normalizedName.replace(/[-_]+/g, ' ').trim());
    }
  }

  return { numbers: numberSet, names: nameSet };
}

function isKnownBotSender(sock, message, senderId, profile = null) {
  const identities = getKnownBotIdentityMap(sock, profile);
  const senderDigits = normalizeDigits(senderId);
  if (senderDigits && identities.numbers.has(senderDigits)) {
    return true; // FIXED: stop chatbot from replying to configured bot accounts
  }

  const senderName = normalizeIdentityToken(message?.pushName || '');
  if (senderName && identities.names.has(senderName)) {
    return true; // FIXED: prevent bot-to-bot loops when WhatsApp exposes bot display names instead of phone JIDs
  }

  return false;
}

function getProfileHfApiKey(profile = null) {
  const prefix = toEnvPrefix(profile);
  return String(
    process.env[`${prefix}_HF_API_KEY`] ||
    process.env[`${prefix}_HUGGINGFACE_API_KEY`] ||
    process.env[`${prefix}_HF_TOKEN`] ||
    GLOBAL_HF_API_KEY
  ).trim();
}

function getBotChat(profile = null) {
  const botId = String(profile?.botId || 'eclipse').trim().toLowerCase() || 'eclipse';
  if (!botModules.has(botId)) {
    botModules.set(botId, createChatbotModule({
      logger: console,
      stickerEnabled: CHATBOT_STICKERS_ENABLED,
      stickerMinTurns: Number(process.env.CHATBOT_STICKER_MIN_TURNS || process.env.CHATBOT_STICKERS_MIN_TURNS || 2),
      stickerMaxTurns: Number(process.env.CHATBOT_STICKER_MAX_TURNS || process.env.CHATBOT_STICKERS_MAX_TURNS || 3),
      stickerMaxChats: Number(process.env.CHATBOT_STICKER_MAX_CHATS || process.env.CHATBOT_STICKERS_MAX_CHATS || 2000),
      characterProfile: getCharacterProfile(profile),
      profile
    }));
  }
  return botModules.get(botId);
}

function getGroqClient() {
  const apiKey = String(process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) return null;
  if (!groqClient) groqClient = new Groq({ apiKey, dangerouslyAllowBrowser: true });
  return groqClient;
}

function getChatbotStickerDir(profile = null) {
  const activeProfile = profile || getCurrentProfile() || null;
  return path.join(
    process.cwd(),
    activeProfile?.chatbotStickerDir || settings.chatbotStickerDir || path.join('assets', 'new stickers')
  ); // FIXED: profile-aware chatbot sticker directory
}

function loadUserGroupData() {
  try {
    return JSON.parse(fs.readFileSync(getBotDataPath('userGroupData.json'), 'utf8'));
  } catch {
    return { groups: [], chatbot: {} };
  }
}

function getChatbotStickerFiles(profile = null) {
  const stickerDir = getChatbotStickerDir(profile);
  if (chatbotStickerFilesCache.has(stickerDir)) return chatbotStickerFilesCache.get(stickerDir);
  try {
    const files = fs.readdirSync(stickerDir)
      .filter((name) => CHATBOT_STICKER_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .filter((name) => !HAIMIYA_STICKER_EXCLUDED.has(name.toLowerCase()))
      .map((name) => path.join(stickerDir, name));
    chatbotStickerFilesCache.set(stickerDir, files);
    return files;
  } catch {
    chatbotStickerFilesCache.set(stickerDir, []);
    return chatbotStickerFilesCache.get(stickerDir);
  }
}

function normalizeStickerMood(mood) {
  const value = String(mood || '').trim().toLowerCase();
  if (!value) return 'tease';
  if (value === 'friendly') return 'soft';
  if (value === 'flirty') return 'shy';
  if (value === 'dominant' || value === 'roaster') return 'dry';
  if (value === 'teaser') return 'tease';
  return value;
}

function isHaimiyaStickerProfile(profile = null) {
  const activeProfile = profile || getCurrentProfile() || null;
  const botName = String(activeProfile?.botName || activeProfile?.characterProfile?.name || '').toLowerCase();
  const stickerDir = String(activeProfile?.chatbotStickerDir || '').toLowerCase();
  return botName.includes('haimiya') || botName.includes('hamiya') || stickerDir.includes('haumiya'); // FIXED: Haimiya sticker profile detection
}

function getChatbotStickerFilesForMood(mood, profile = null) {
  const files = getChatbotStickerFiles(profile);
  if (files.length <= 2) return files;
  const wanted = normalizeStickerMood(mood);
  if (isHaimiyaStickerProfile(profile)) {
    const preferredNames = HAIMIYA_STICKER_MOODS[wanted] || [];
    const preferred = files.filter((filePath) => preferredNames.includes(path.basename(filePath)));
    if (preferred.length) return preferred; // FIXED: visual mood buckets for Haimiya stickers
  }
  const exact = files.filter((filePath) => path.basename(filePath).toLowerCase().startsWith(`${wanted}__`));
  if (exact.length >= 4) return exact;

  const fallbacks = {
    soft: ['calm', 'cute', 'tease', 'shy', 'dry'],
    shy: ['cute', 'soft', 'calm', 'tease'],
    cute: ['soft', 'shy', 'tease', 'calm'],
    tease: ['cute', 'soft', 'dry', 'chaotic'],
    dry: ['calm', 'tease', 'soft'],
    chaotic: ['tease', 'cute', 'dry'],
    calm: ['soft', 'dry', 'cute']
  };

  for (const nextMood of fallbacks[wanted] || ['tease']) {
    const bucket = files.filter((filePath) => path.basename(filePath).toLowerCase().startsWith(`${nextMood}__`));
    if (bucket.length) return bucket;
  }

  return files;
}

function pickRotatingSticker(files, mood = 'all', profile = null) {
  if (!files.length) return null;
  const key = `${getChatbotStickerDir(profile)}::${normalizeStickerMood(mood)}`;
  let rotation = chatbotStickerRotation.get(key);
  const sameSet = rotation?.all?.length === files.length && rotation.all.every((file, index) => file === files[index]);

  if (!rotation || !sameSet || !rotation.remaining.length) {
    const shuffled = [...files].sort(() => Math.random() - 0.5);
    rotation = { all: [...files], remaining: shuffled };
    chatbotStickerRotation.set(key, rotation);
  }

  return rotation.remaining.shift() || files[Math.floor(Math.random() * files.length)];
}

function clampReplyWords(text, maxWords = 35, minWords = 2) {
  const trimmed = String(text || '').trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < minWords) return '';
  if (words.length <= maxWords) return trimmed;
  return words.slice(0, maxWords).join(' ');
}

function getReplyWordLimit(profile = null) {
  const botName = String(profile?.botName || profile?.characterProfile?.name || '').toLowerCase();
  if (botName.includes('haimiya')) return 80; // FIXED: longer Haimiya chatbot replies
  return 30;
}

function hasLocalChatbotStickers() {
  return getChatbotStickerFiles().length > 0;
}

async function buildLocalChatbotStickerMessage(mood = 'tease', profile = null) {
  const allFiles = getChatbotStickerFiles(profile);
  const moodFiles = getChatbotStickerFilesForMood(mood, profile);
  const files = allFiles.length > 2 ? allFiles : moodFiles;
  if (!files.length) return null;

  const picked = pickRotatingSticker(files, mood, profile);
  if (!picked) return null;
  const ext = path.extname(picked).toLowerCase();

  try {
    if (ext === '.webp') {
      return { sticker: fs.readFileSync(picked) };
    }

    if (!sharp) return null;

    const stickerBuffer = await sharp(picked)
      .resize(512, 512, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .webp({ quality: 92 })
      .toBuffer();

    return { sticker: stickerBuffer };
  } catch (error) {
    console.error('Error building local chatbot sticker:', error?.message || error);
    return null;
  }
}

function saveUserGroupData(data) {
  fs.writeFileSync(getBotDataPath('userGroupData.json'), JSON.stringify(data, null, 2), 'utf8');
}

function isChatbotEnabled(chatId) {
  const data = loadUserGroupData();
  return Boolean(data.chatbot && data.chatbot[chatId]);
}

function normalizeReplyPayload(out) {
  const profile = getCurrentProfile() || null;
  const maxWords = getReplyWordLimit(profile);
  if (!out) return { texts: [], delayMs: 0 };
  if (typeof out === 'string') return { texts: [out.trim()].filter(Boolean), delayMs: 0 };

  const directText = [out.response, out.text, out.message]
    .map((x) => String(x || '').trim())
    .find(Boolean);
  const texts = Array.isArray(out.texts)
    ? out.texts.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3)
    : directText
      ? [directText]
      : [];
  const delayMs = Math.max(0, Number(out.delayMs || 0));
  return { texts: texts.map((text) => clampReplyWords(text, maxWords, 2)).filter(Boolean), delayMs }; // FIXED: Haimiya reply length with minimum text guard
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldLaughReact(text = '') {
  const input = String(text || '').toLowerCase();
  if (!input) return false;
  return /\b(haha|hehe|lol|lmao|lmfao|funny|joke|rofl)\b/.test(input) || /😂|🤣/.test(text);
}

async function sendReaction(sock, message, emoji) {
  try {
    if (!emoji || !message?.key?.id) return;
    await sock.sendMessage(message.key.remoteJid, {
      react: {
        text: emoji,
        key: message.key
      }
    });
  } catch {}
}

async function showFakeTyping(sock, chatId, totalMs) {
  if (!sock || typeof sock.sendPresenceUpdate !== 'function') {
    await sleep(totalMs);
    return;
  }

  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < totalMs) {
      await sock.sendPresenceUpdate('composing', chatId);
      await sleep(Math.min(3600, Math.max(1200, totalMs - (Date.now() - startedAt))));
    }
  } catch {}

  try {
    await sock.sendPresenceUpdate('paused', chatId);
  } catch {}
}

function pickReplyDelayMs(texts) {
  const min = Number(process.env.FAKE_TYPING_MIN_MS || 500);
  const max = Number(process.env.FAKE_TYPING_MAX_MS || 2500);
  const text = texts.join(' ');
  const lengthDelay = Math.min(max, min + (text.length * 15)); // 15ms per character
  return randomInt(min, lengthDelay);
}

function normalizeSpamText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLowSignalText(text) {
  const normalized = normalizeSpamText(text);
  if (!normalized) return true;

  const words = normalized.split(' ').filter(Boolean);
  const compact = normalized.replace(/\s+/g, '');

  if (compact.length <= 2) return true;
  if (/^(hi|hii|hey|yo|hm|hmm|ok|okay|bro|sis|lol|lmao|test)$/.test(normalized)) return true;
  if (/^(.)\1{4,}$/.test(compact)) return true;
  if (words.length >= 3 && words.every((word) => word.length <= 3)) return true;
  if (words.length >= 4 && new Set(words).size <= 2) return true;
  return false;
}

function shouldIgnoreSpam(chatId, senderId, text, opts = {}) {
  const directTrigger = Boolean(opts.directTrigger);
  const strict = Boolean(opts.strict);
  const meaningful = !isLowSignalText(text);
  const key = `${chatId}:${senderId}`;
  const now = Date.now();
  const normalized = normalizeSpamText(text);
  
  // Get current state from cache
  const state = spamCache.get(key) || {
    lastText: '',
    repeatCount: 0,
    burstHits: [],
    ignoredUntil: 0
  };

  state.burstHits = state.burstHits.filter((stamp) => now - stamp <= 18_000);

  if (!meaningful) {
    state.burstHits.push(now);
  }

  if (normalized && normalized === state.lastText) {
    state.repeatCount += 1;
  } else {
    state.repeatCount = 1;
    state.lastText = normalized;
  }

  const repeatedSameMessage = Boolean(normalized && normalized === state.lastText && state.repeatCount >= 3);

  if (normalized && normalized === state.lastText && state.repeatCount >= 3) {
    state.ignoredUntil = now + 60_000;
  }

  if ((state.repeatCount >= 3 && !meaningful) || state.burstHits.length >= 5) {
    state.ignoredUntil = now + 45_000;
  }

  if (state.ignoredUntil > now && (repeatedSameMessage || !meaningful || strict)) {
    spamCache.set(key, state, 2 * 60 * 1000); // Cache for 2 minutes
    return true;
  }

  if (state.ignoredUntil > now && directTrigger && meaningful && !repeatedSameMessage) {
    state.ignoredUntil = 0;
    state.burstHits = [];
  }

  if (state.repeatCount >= (strict ? 3 : 4) && !meaningful) {
    spamCache.set(key, state, 2 * 60 * 1000);
    return true;
  }

  if (strict && (state.repeatCount >= 3 || state.burstHits.length >= 4)) {
    state.ignoredUntil = now + 90_000;
    spamCache.set(key, state, 2 * 60 * 1000);
    return true;
  }

  spamCache.set(key, state, 2 * 60 * 1000);
  return false;
}

function getMessageContextInfo(message) {
  return (
    message?.message?.extendedTextMessage?.contextInfo ||
    message?.message?.imageMessage?.contextInfo ||
    message?.message?.videoMessage?.contextInfo ||
    message?.message?.audioMessage?.contextInfo ||
    message?.message?.stickerMessage?.contextInfo ||
    null
  );
}

function buildBotNameTriggers(profile = null) {
  const activeProfile = profile || getCurrentProfile() || null;
  const rawNames = [
    activeProfile?.botName,
    activeProfile?.characterProfile?.name
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);

  const variants = new Set(rawNames);
  for (const name of rawNames) {
    variants.add(name.replace(/[-_]+/g, ' '));
    variants.add(name.replace(/\bsenpai\b/g, '').replace(/\s+/g, ' ').trim());
  }

  if (rawNames.some((name) => name.includes('haimiya') || name.includes('hamiya'))) {
    variants.add('haimiya');
    variants.add('hamiya');
    variants.add('haimiya senpai');
    variants.add('hamiya senpai');
  }

  return Array.from(variants).filter(Boolean); // FIXED: Haimiya name trigger variants
}

function normalizeMentionTrigger(sock, message, userMessage) {
  const profile = getCurrentProfile() || sock?.profile || null;
  const botId = String(sock?.user?.id || '');
  const botNum = botId.split(':')[0];
  const botLid = String(sock?.user?.lid || '');
  const botName = String(profile?.botName || settings.botName || '').trim();

  const botJids = [
    botId,
    `${botNum}@s.whatsapp.net`,
    `${botNum}@lid`,
    botLid,
    `${botLid.split(':')[0]}@lid`,
  ].filter(Boolean);

  const ctx = getMessageContextInfo(message);
  const mentioned = Array.isArray(ctx?.mentionedJid) ? ctx.mentionedJid : [];
  const quotedParticipant = String(ctx?.participant || '');

  const botNums = botJids.map((j) => String(j).split('@')[0].split(':')[0]);

  const isMentioned = mentioned.some((jid) => {
    const n = String(jid).split('@')[0].split(':')[0];
    return botNums.includes(n);
  }) || userMessage.includes(`@${botNum}`);

  const quotedNum = quotedParticipant.split('@')[0].split(':')[0];
  const isReplyToBot = quotedNum && botNums.includes(quotedNum);
  const calledByName = buildBotNameTriggers(profile).some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(String(userMessage || ''));
  });

  const cleaned = userMessage.replace(new RegExp(`@${botNum}`, 'g'), '').trim();
  return { isMentioned: isMentioned || calledByName, isReplyToBot, cleaned };
}

function getDirectImageMessage(message) {
  return message?.message?.imageMessage || null;
}

function getDirectAudioMessage(message) {
  return message?.message?.audioMessage || null;
}

function hasImageContent(message) {
  return Boolean(getDirectImageMessage(message));
}

function hasAudioContent(message) {
  return Boolean(getDirectAudioMessage(message));
}

async function imageMessageToBuffer(imageMessage) {
  if (!imageMessage) return null;
  const stream = await downloadContentFromMessage(imageMessage, 'image');
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  const out = Buffer.concat(chunks);
  return out.length ? out : null;
}

async function audioMessageToBuffer(audioMessage) {
  if (!audioMessage) return null;
  const stream = await downloadContentFromMessage(audioMessage, 'audio');
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  const out = Buffer.concat(chunks);
  return out.length ? out : null;
}

async function describeImageFromBuffer(buffer) {
  const profile = getCurrentProfile() || null;
  const hfApiKey = getProfileHfApiKey(profile);
  const hfVision = hfApiKey ? new InferenceClient(hfApiKey) : null;
  if (!buffer || !buffer.length || !hfVision) return '';
  if (buffer.length > CHATBOT_IMAGE_MAX_BYTES) return '';

  for (const model of CHATBOT_IMAGE_MODELS) {
    try {
      const task = hfVision.imageToText({
        data: buffer,
        model,
        provider: CHATBOT_IMAGE_PROVIDER
      });

      const result = await Promise.race([
        task,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Image caption timeout')), CHATBOT_IMAGE_TIMEOUT_MS))
      ]);

      const text = String(result?.generated_text || '').replace(/\s+/g, ' ').trim();
      if (text) return text;
    } catch (_) {
      continue;
    }
  }

  return '';
}

async function transcribeAudioFromBuffer(buffer, mimeType = '') {
  const client = getGroqClient();
  if (!client || !buffer || !buffer.length) return '';
  if (buffer.length > CHATBOT_AUDIO_MAX_BYTES) return '';

  try {
    const ext = mimeType.includes('ogg') ? 'ogg'
      : mimeType.includes('mpeg') || mimeType.includes('mp3') ? 'mp3'
      : mimeType.includes('wav') ? 'wav'
      : mimeType.includes('webm') ? 'webm'
      : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a'
      : 'ogg';

    const file = await Groq.toFile(buffer, `voice-note.${ext}`);
    const result = await client.audio.transcriptions.create({
      file,
      model: CHATBOT_AUDIO_MODEL,
      temperature: 0,
      response_format: 'json'
    });

    return String(result?.text || '').replace(/\s+/g, ' ').trim();
  } catch (error) {
    console.error('Error transcribing chatbot audio:', error?.message || error);
    return '';
  }
}

function buildImageAwareInput(userText, imageDescription, hasImage = false) {
  const text = String(userText || '').trim();
  const description = String(imageDescription || '').trim();
  if (text && description) return `${text}\n\nImage context: ${description}`;
  if (description) return `React to this image naturally.\n\nImage context: ${description}`;
  if (hasImage && text) return `${text}\n\nThe user sent an image. Respond naturally to it even if the image details are limited.`;
  if (hasImage) return 'The user sent an image. React naturally to it in one short line.';
  return text;
}

function buildMediaAwareInput(userText, imageDescription, audioTranscript, opts = {}) {
  const text = String(userText || '').trim();
  const imagePart = String(imageDescription || '').trim();
  const audioPart = String(audioTranscript || '').trim();
  const hasImage = Boolean(opts.hasImage);
  const hasAudio = Boolean(opts.hasAudio);
  const parts = [];

  if (text) parts.push(text);
  if (audioPart) parts.push(`Voice note transcript: ${audioPart}`);
  if (imagePart) parts.push(`Image context: ${imagePart}`);

  if (parts.length) return parts.join('\n\n');
  if (hasAudio) return 'The user sent a voice note. Reply naturally to what they said.';
  if (hasImage) return buildImageAwareInput(text, imagePart, hasImage);
  return text;
}

function toSocialMessage(chatId, senderId, pushName, text, message, isFromMe) {
  const mentions = message?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  return {
    chatId,
    senderId,
    pushName: pushName || '',
    text: text || '',
    mentions,
    isFromMe: Boolean(isFromMe),
  };
}

function buildSyntheticCommandMessage(message, commandText) {
  return {
    ...message,
    message: {
      conversation: commandText
    }
  };
}

function detectChatbotCommandIntent(input, chatId) {
  const text = String(input || '').trim();
  if (!text) return null;

  const wifePatterns = [
    /\b(?:pick|choose|find)\s+(?:me\s+)?(?:a\s+)?(?:wife|biwi)\b/i,
    /\bwho\s+(?:is|'s)\s+my\s+(?:wife|biwi)\b/i,
    /\b(?:give|get)\s+me\s+(?:a\s+)?(?:wife|biwi)\b/i
  ];
  if (wifePatterns.some((pattern) => pattern.test(text))) {
    return {
      type: 'wife',
      commandText: '.wife'
    };
  }

  const playPatterns = [
    /\b(?:play|put on|send)\s+(?:me\s+)?(?:a\s+)?(?:song|music|track)\s+(.+)/i,
    /^\s*play\s+(.+)/i,
    /\b(?:song|music|track)\s+(?:called|named)\s+(.+)/i
  ];

  for (const pattern of playPatterns) {
    const match = text.match(pattern);
    const query = String(match?.[1] || '').trim();
    if (query) {
      return {
        type: /\bspotify\b/i.test(text) ? 'spotify' : 'song',
        commandText: `${/\bspotify\b/i.test(text) ? '.spotify' : '.song'} ${query}`
      };
    }
  }

  return null;
}

async function tryHandleChatbotCommandIntent(sock, chatId, message, input) {
  const intent = detectChatbotCommandIntent(input, chatId);
  if (!intent) return false;

  if (intent.type === 'wife') {
    await wifeCommand(sock, chatId, message, intent.commandText);
    return true;
  }

  if (intent.type === 'song') {
    const syntheticMessage = buildSyntheticCommandMessage(message, intent.commandText);
    await songCommand(sock, chatId, syntheticMessage);
    return true;
  }

  if (intent.type === 'spotify') {
    const syntheticMessage = buildSyntheticCommandMessage(message, intent.commandText);
    await spotifyCommand(sock, chatId, syntheticMessage);
    return true;
  }

  return false;
}

async function handleChatbotCommand(sock, chatId, message, match) {
  const profile = getCurrentProfile() || sock?.profile || null;
  const botChat = getBotChat(profile);
  const data = loadUserGroupData();
  if (!data.chatbot || typeof data.chatbot !== 'object') data.chatbot = {};

  const mode = String(match || '').trim().toLowerCase();

  if (!mode) {
    const enabled = Boolean(data.chatbot[chatId]);
    return sock.sendMessage(chatId, {
      text: `*CHATBOT MENU*\n\n.chatbot on\n.chatbot off\n\nStatus: ${enabled ? 'ON' : 'OFF'}`,
    }, { quoted: message });
  }

  // Permission check: only admins can toggle chatbot
  const senderId = message?.key?.participant || message?.key?.remoteJid;
  const hasAccess = await hasPermission(sock, chatId, senderId, PERMISSION_LEVELS.ADMIN);
  if (!hasAccess) {
    return sock.sendMessage(chatId, { text: '❌ Only admins can toggle chatbot.' }, { quoted: message });
  }

  if (mode === 'on') {
    if (data.chatbot[chatId]) {
      return sock.sendMessage(chatId, { text: '*Chatbot already ON*' }, { quoted: message });
    }
    data.chatbot[chatId] = true;
    saveUserGroupData(data);
    return sock.sendMessage(chatId, { text: '*Chatbot turned ON*' }, { quoted: message });
  }

  if (mode === 'off') {
    if (!data.chatbot[chatId]) {
      return sock.sendMessage(chatId, { text: '*Chatbot already OFF*' }, { quoted: message });
    }
    delete data.chatbot[chatId];
    saveUserGroupData(data);
    return sock.sendMessage(chatId, { text: '*Chatbot turned OFF*' }, { quoted: message });
  }

  return sock.sendMessage(chatId, { text: 'Use `.chatbot on` or `.chatbot off`' }, { quoted: message });
}

async function handleChatbotResponse(sock, chatId, message, userMessage, senderId) {
  const profile = getCurrentProfile() || sock?.profile || null;
  const botChat = getBotChat(profile);
  if (!isChatbotEnabled(chatId)) return;
  if (isKnownBotSender(sock, message, senderId, profile)) return;

  try {
    const imageMessage = getDirectImageMessage(message);
    const audioMessage = getDirectAudioMessage(message);
    const imagePresent = hasImageContent(message);
    const audioPresent = hasAudioContent(message);
    const socialMsg = toSocialMessage(
      chatId,
      senderId,
      message?.pushName,
      userMessage || (audioPresent ? '[voice]' : (imagePresent ? '[image]' : '')),
      message,
      message?.key?.fromMe
    );
    botChat.socialState.captureMessage(socialMsg);

    const trigger = normalizeMentionTrigger(sock, message, userMessage);
    const directTrigger = trigger.isMentioned || trigger.isReplyToBot;
    const isReze = /reze/i.test(String(profile?.botName || settings.botName || ''));
    const shouldRespondToImage = imagePresent && directTrigger;
    const shouldRespondToAudio = audioPresent && directTrigger;
    if (!directTrigger && !shouldRespondToImage && !shouldRespondToAudio) {
      return;
    }

    const incomingText = String(trigger.cleaned || userMessage || '').replace(/\s+/g, ' ').trim();
    if (shouldIgnoreSpam(chatId, senderId, incomingText || (audioPresent ? '[voice]' : (imagePresent ? '[image]' : '')), {
      directTrigger,
      strict: isReze
    })) {
      return;
    }

    let imageDescription = '';
    let audioTranscript = '';

    if (CHATBOT_IMAGE_REPLIES_ENABLED && imageMessage && shouldRespondToImage) {
      try {
        const imageBuffer = await imageMessageToBuffer(imageMessage);
        imageDescription = await describeImageFromBuffer(imageBuffer);
      } catch (error) {
        console.error('Error reading chatbot image:', error?.message || error);
      }
    }

    if (CHATBOT_AUDIO_REPLIES_ENABLED && audioMessage && shouldRespondToAudio) {
      try {
        const audioBuffer = await audioMessageToBuffer(audioMessage);
        audioTranscript = await transcribeAudioFromBuffer(audioBuffer, audioMessage?.mimetype || '');
      } catch (error) {
        console.error('Error reading chatbot audio:', error?.message || error);
      }
    }

    const preparedInput = buildMediaAwareInput(incomingText, imageDescription, audioTranscript, {
      hasImage: imagePresent,
      hasAudio: audioPresent
    });
    if (!preparedInput) return;
    const trimmedText = preparedInput.slice(0, MAX_CHATBOT_INPUT_CHARS);

    const handledAsCommand = await tryHandleChatbotCommandIntent(sock, chatId, message, incomingText);
    if (handledAsCommand) {
      botChat.socialState.markBotReply(chatId);
      return;
    }

    const registeredProfile = getRegisteredProfile(senderId);
    const registeredName = String(registeredProfile?.name || '').trim();
    const chatbotInput = registeredName
      ? `[registered_name:${registeredName}]\n${trimmedText}`
      : trimmedText;

    const out = await botChat.chatbot.reply({
      chatId,
      senderId,
      text: chatbotInput,
      pushName: registeredName || message?.pushName || '',
    });

    const payload = normalizeReplyPayload(out);
    const replyMood = normalizeStickerMood(out?.mood || out?.style || 'tease');
    if (!payload.texts.length) return;

    if (shouldLaughReact(incomingText)) {
      await sendReaction(sock, message, '😂');
    }

    const sendSticker = CHATBOT_STICKERS_ENABLED
      && trimmedText.length <= 280
      && (hasLocalChatbotStickers() || botChat.chatbotSticker.shouldSend(chatId));
    const stickerOnly = sendSticker && payload.texts.length <= 1 && Math.random() < CHATBOT_STICKER_ONLY_CHANCE;

    if (stickerOnly) {
      const sticker = await buildLocalChatbotStickerMessage(replyMood, profile) || await botChat.chatbotSticker.buildMessage(replyMood); // FIXED: Haimiya sticker pack selection
      if (sticker) {
        await sock.sendMessage(chatId, sticker, { quoted: message });
        botChat.socialState.markBotReply(chatId);
        return;
      }
    }

    const shouldReplyWithVoiceNote = (
      CHATBOT_VOICE_NOTES_ENABLED &&
      shouldRespondToAudio &&
      canUseHfVoice() &&
      /ryo/i.test(String(profile?.botName || settings.botName || ''))
    );

    const replyDelayMs = pickReplyDelayMs(payload.texts);
    await showFakeTyping(sock, chatId, replyDelayMs);

    if (shouldReplyWithVoiceNote) {
      try {
        const voiceReply = await synthesizeRyoVoiceNote(payload.texts[0]);
        if (voiceReply?.buffer?.length) {
          await sock.sendMessage(chatId, {
            audio: voiceReply.buffer,
            mimetype: voiceReply.mimetype,
            ptt: true
          }, { quoted: message });
          botChat.socialState.markBotReply(chatId);
        } else {
          await sock.sendMessage(chatId, { text: payload.texts[0] }, { quoted: message });
          botChat.socialState.markBotReply(chatId);
        }
      } catch (voiceError) {
        console.error('Error generating chatbot voice note:', voiceError?.message || voiceError);
        await sock.sendMessage(chatId, { text: payload.texts[0] }, { quoted: message });
        botChat.socialState.markBotReply(chatId);
      }
    } else {
      await sock.sendMessage(chatId, { text: payload.texts[0] }, { quoted: message });
      botChat.socialState.markBotReply(chatId);
    }

    if (sendSticker) {
      const sticker = await buildLocalChatbotStickerMessage(replyMood, profile) || await botChat.chatbotSticker.buildMessage(replyMood); // FIXED: Haimiya sticker pack selection
      if (sticker) {
        await sock.sendMessage(chatId, sticker);
        botChat.socialState.markBotReply(chatId);
      }
    }
  } catch (error) {
    console.error('Error in chatbot response:', error?.message || error);
  }
}

module.exports = {
  handleChatbotCommand,
  handleChatbotResponse,
  permission: PERMISSION_LEVELS.ADMIN // Restrict to admins
};
