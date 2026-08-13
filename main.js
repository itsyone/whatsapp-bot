const settings = require('./settings');
require('./config.js');
const { getCurrentBot, getCurrentProfile } = require('./lib/botContext');
const { isBanned } = require('./lib/isBanned');
const { getTempBan, setTempBan } = require('./lib/tempBan');
const { canUseInMode, readAccessModeState, writeAccessModeState } = require('./lib/accessMode');
const { fetchBuffer } = require('./lib/myfunc');
const fs = require('fs');
const fetch = require('node-fetch');
const ytdl = require('ytdl-core');
const path = require('path');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');

// Ensure required directories exist
try {
    const dirs = ['tmp', 'temp', 'data', 'session'];
    dirs.forEach(dir => {
        const fullPath = path.join(process.cwd(), dir);
        if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
    });
} catch (err) {
    console.error('[SYS] Directory creation error:', err);
}
const { isSudo } = require('./lib/index');
const isOwnerOrSudo = require('./lib/isOwner');
const isAdmin = require('./lib/isAdmin');
const { consumeAdminUpdate } = require('./lib/adminUpdateTracker');
const { hasStaffRole } = require('./lib/staffRoles');
const modRoleCommand = require('./commands/admin/modrole');
const topMembers = require('./commands/social/topmembers');
let { incrementMessageCount } = topMembers;

function isCanvasLoadError(err) {
    const text = String(err?.stack || err?.message || err || '').toLowerCase();
    return text.includes('canvas.node') || text.includes("cannot find module 'canvas'") || text.includes('module did not self-register');
}

function makeCanvasUnavailableCommand(featureName) {
    return async (sock, chatId, message) => {
        if (!sock?.sendMessage || !chatId) return;
        await sock.sendMessage(
            chatId,
            { text: `${featureName} is unavailable on this host because the canvas module failed to load.` },
            message ? { quoted: message } : {}
        );
    };
}

function optionalCommandRequire(modulePath, fallbackValue) {
    try {
        return require(modulePath);
    } catch (err) {
        if (!isCanvasLoadError(err)) throw err;
        console.error(`[optional] ${modulePath} disabled: ${err?.message || err}`);
        return fallbackValue;
    }
}

const { handleAntideleteCommand, handleMessageRevocation, storeMessage: antideleteStoreMessage } = optionalCommandRequire('./commands/admin/antidelete', { storeMessage: ()=>{}, handleMessageRevocation: async()=>{} });
const { handleStatusUpdate } = optionalCommandRequire('./commands/utility/autostatus', { handleStatusUpdate: async()=>{} });
const { handleStatusMentionDetection } = optionalCommandRequire('./commands/admin/antism', { handleStatusMentionDetection: null });
const { handleAntipornDetection } = optionalCommandRequire('./commands/admin/antiporn', { handleAntipornDetection: null });
const { handleAfkMentions, handleAfkReturn } = optionalCommandRequire('./commands/utility/afk', { handleAfkMentions: async()=>{}, handleAfkReturn: async()=>{} });
const { getSession } = require('./lib/gameSessions');
const { handleChatbotCommand, handleChatbotResponse } = optionalCommandRequire('./commands/utility/chatbot', { handleChatbotResponse: async()=>{} });
const { startTruthOrDare, joinTruthOrDare, isParticipant: isTodParticipant, handleTodMessage, handleReaction: handleTodReaction } = require('./commands/games/truthordare');
const { handleTagDetection } = optionalCommandRequire('./commands/admin/antitag', { handleTagDetection: async()=>{} });
const { handleMentionDetection } = optionalCommandRequire('./commands/social/mention', { handleMentionDetection: async()=>{} });
const { maybeTriggerBondBonus } = optionalCommandRequire('./commands/social/marriage', { maybeTriggerBondBonus: async()=>{} });
const { handlePinterestCarouselResponse } = optionalCommandRequire('./commands/media/pint', { handlePinterestCarouselResponse: async()=>false });
const { joinStickRoll, isStickRollParticipant } = optionalCommandRequire('./commands/rpg/stickroll', { joinStickRoll: async()=>false, isStickRollParticipant: ()=>false });
const { joinArena, isArenaParticipant } = optionalCommandRequire('./commands/rpg/arena', { joinArena: async()=>false, isArenaParticipant: ()=>false });
const { handleShadowFightMove, joinShadowFight, isShadowFightParticipant } = optionalCommandRequire('./commands/rpg/shadowfight', { handleShadowFightMove: async()=>false, joinShadowFight: async()=>false, isShadowFightParticipant: ()=>false });
const { handleBombPassCommand, joinBombPass, isBombPassParticipant } = optionalCommandRequire('./commands/rpg/bombpass', { handleBombPassCommand: async()=>false, joinBombPass: async()=>false, isBombPassParticipant: ()=>false });
const { handlePuzzleBoxAnswer, joinPuzzleBox, isPuzzleBoxParticipant } = optionalCommandRequire('./commands/rpg/puzzlebox', { handlePuzzleBoxAnswer: async()=>false, joinPuzzleBox: async()=>false, isPuzzleBoxParticipant: ()=>false });
const { handleWordQuestAnswer, joinWordQuest, isWordQuestParticipant } = optionalCommandRequire('./commands/rpg/wordquest', { handleWordQuestAnswer: async()=>false, joinWordQuest: async()=>false, isWordQuestParticipant: ()=>false });

const { handleStickerSearchReply } = optionalCommandRequire('./commands/media/sticker-search', { handleStickerSearchReply: async()=>false });

const { crewCommand, handleCrewReply } = require('./commands/rpg/crew');
const { horseCommand, handleHorseReply } = require('./commands/games/horse');
const { elementWarCommand, handleElementWarReply } = require('./commands/rpg/elementwar');
const { joinCommand } = require('./commands/utility/join');
const aiCommand = require('./commands/utility/ai');
const urlCommand = require('./commands/utility/url');
const { handleTranslateCommand } = require('./commands/utility/translate');
const { handleSsCommand } = require('./commands/utility/ss');
const { addCommandReaction, handleAreactCommand } = require('./lib/reactions');
const imagineCommand = require('./commands/media/imagine');
const videoCommand = require('./commands/media/video');
const { animeCommand } = require('./commands/media/anime');
const animeSfwCommand = require('./commands/media/anime-sfw');
const { animeStreamCommand } = require('./commands/media/animeStream');
const { interactionCommand } = require('./commands/social/interaction');
const { orientationMeterCommand } = require('./commands/utility/orientationMeter');
const coupleppCommand = require('./commands/social/couplepp');
const { wifeCommand } = require('./commands/social/wife');
const removebgCommand = require('./commands/media/removebg');
const { anticallCommand, readState: readAnticallState } = require('./commands/admin/anticall');
const { pmblockerCommand, readState: readPmBlockerState } = require('./commands/admin/pmblocker');
const { readMuteState, writeMuteState } = require('./commands/admin/mute');

// State Caching (5s TTL)
let cachedMuteState = null;
let lastMuteRead = 0;
function getCachedMuteState() {
    if (Date.now() - lastMuteRead > 5000) {
        cachedMuteState = readMuteState();
        lastMuteRead = Date.now();
    }
    return cachedMuteState;
}

let cachedAccessModeStates = new Map();
function getCachedAccessModeState(botId) {
    const key = botId || 'default';
    const cached = cachedAccessModeStates.get(key);
    const now = Date.now();
    
    if (!cached || now - cached.timestamp > 5000) {
        const state = readAccessModeState(botId);
        cachedAccessModeStates.set(key, { state, timestamp: now });
        return state;
    }
    return cached.state;
}

// Hoisted moderation libs
const antibadLib = optionalCommandRequire('./lib/antibadword', {});
const antilinkLib = optionalCommandRequire('./lib/antilink', {});
const { handlePromotionEvent } = optionalCommandRequire('./commands/admin/promote', { handlePromotionEvent: async()=>{} });
const { handleDemotionEvent } = optionalCommandRequire('./commands/admin/demote', { handleDemotionEvent: async()=>{} });
const { handleJoinEvent } = optionalCommandRequire('./commands/social/welcome', { handleJoinEvent: async()=>{} });
const { handleLeaveEvent } = optionalCommandRequire('./commands/social/goodbye', { handleLeaveEvent: async()=>{} });
const { pintCommand } = optionalCommandRequire('./commands/media/pint', { pintCommand: async()=>{} });
const { processAdminGuard, getGuardConfig, setGuardConfig } = require('./lib/adminGuard');
const { analyzeBotMessage, enforceAntiBot } = require('./lib/antibot');
const { processMessageActivity, ensureSharedEconomyReady } = require('./lib/economy');
const { observeGroupActivity, buildSpawnText, getRewardImage, buildDropCard } = require('./lib/dropSystem');
const { handleWelcomeSetupReply } = require('./lib/welcome');
const { isRegistered, resolveRegisteredJid, linkProfileAliases } = require('./lib/registrationStore');
const commandHandler = require('./lib/commandHandler');
const { getBotId } = require('./lib/botDataPath');
const { isGamblingEnabled, sendGamblingLockedMessage } = require('./lib/gamblingAccess');
const { isWistoriaEnabled } = require('./lib/wistoriaState');
const { ensureMongoReady, isSynced } = require('./lib/mongoStore');


const COMMAND_SPAM_BAN_MS = 10 * 60 * 1000;
const MAX_REPLAY_MESSAGE_AGE_MS = 15 * 60 * 1000;
const commandSpamState = new Map();
const processedMessageIds = new Set();
const privilegeCache = new Map();
const PRIVILEGE_CACHE_TTL_MS = 30_000;
const mongoReadyKickoffBots = new Set();
setInterval(() => processedMessageIds.clear(), 10 * 60 * 1000); // Clear every 10 mins

function formatDuration(ms) {
    const totalSeconds = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${totalSeconds}s`;
}

function getMessageTimestampMs(message = {}) {
    const rawTimestamp = message?.messageTimestamp;
    if (typeof rawTimestamp === 'number') return rawTimestamp * 1000;
    if (typeof rawTimestamp === 'string' && rawTimestamp.trim()) return Number(rawTimestamp) * 1000;
    if (typeof rawTimestamp?.toNumber === 'function') return rawTimestamp.toNumber() * 1000;
    if (typeof rawTimestamp?.low === 'number') return rawTimestamp.low * 1000;
    return 0; // FIXED: replay message age parsing
}

function sameUserId(a, b) {
    const left = String(a || '').split('@')[0].split(':')[0];
    const right = String(b || '').split('@')[0].split(':')[0];
    return Boolean(left && right && left === right);
}

function getSenderCandidates(message = {}) {
    return [
        message?.key?.participantAlt,
        message?.key?.participant,
        message?.key?.remoteJid
    ]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .filter((value) => value !== 'status@broadcast' && !value.endsWith('@g.us'));
}

function resolveSenderId(message = {}) {
    const candidates = getSenderCandidates(message);
    const registeredJid = resolveRegisteredJid(candidates);
    if (registeredJid) return registeredJid;

    // Prefer phone JID over LID
    const phoneCandidate = candidates.find((value) => value.endsWith('@s.whatsapp.net'));
    if (phoneCandidate) return phoneCandidate;

    const lidCandidate = candidates.find((value) => value.endsWith('@lid'));
    return lidCandidate || candidates[0] || String(message?.key?.remoteJid || '').trim();
}
const BASE_COMMAND_ALIASES = new Map(Object.entries({
    '.p': '.profile',
    '.bal': '.balance',
    '.dep': '.deposit',
    '.wd': '.withdraw',
    '.purge': '.delete',
    '.gpt': '.ai',
    '.gemini': '.ai',
    '.llama': '.ai',
    '.cohere': '.ai',
    '.menu': '.help',
    '.inv': '.inventory',
    '.bag': '.inventory',
    '.cf': '.coinflip',
    '.cfb': '.coinflipb',
    '.dp': '.dicepoker',
    '.slot': '.slots',
    '.tg': '.stickertelegram',
    '.fb': '.facebook',
    '.pm': '.promote',
    '.d': '.delete',
    '.del': '.delete',
    '.dm': '.demote',
    '.reg': '.register',
    '.jp': '.jackpot',
    '.rlt': '.roulette',
    '.h': '.help',
    '.img': '.imagine',
    '.v': '.video',
    '.t': '.translate',
    '.pgif': '.profilegif',
    '.r': '.startregister',
    '.register': '.startregister',
    '.alive': '.ping',
    '.bio': '.editbio',
    '.edit': '.rename',
    '.a': '.attack',
    '.df': '.defend',
    '.s': '.special',
    '.manga': '.manga',
    '.nigger': '.white',
    '.remini': '.upscale',
    '.hd': '.upscale',
    '.hdr': '.upscale',
    '.stickersearch': '.sticker-search',
    '.sticker-s': '.sticker-search',
    '.s': '.sticker',
    '.ig': '.instagram',
    '.yt': '.video',
    '.bg': '.removebg',
    '.bgrem': '.removebg',
    '.rmbg': '.removebg',
    '.nobg': '.removebg',
    '.ttsearch': '.tiktoksearch',
    '.ttksearch': '.tiktoksearch',
    '.ttk': '.tiktok',
    '.open': '.opengroup',
    '.close': '.closegroup',
    '.hangman': '.starthangman',
    '.guess': '.guessletter',
    '.tovid': '.tovideo',
    '.team': '.owner',
    '.support': '.support',
    '.puzzlebox': '.startpuzzlebox',
    '.pb': '.startpuzzlebox',
    '.mysticroll': '.startstickroll',
    '.mr': '.startstickroll',
    '.stickroll': '.startstickroll',
    '.sr': '.startstickroll',
    '.wordquest': '.startwordquest',
    '.wq': '.startwordquest',
    '.shadowfight': '.startshadowfight',
    '.sf': '.startshadowfight',
    '.elementwar': '.elementwar',
    '.ew': '.elementwar',
    '.duel': '.startduel',
    '.dl': '.startduel',
    '.arena': '.startarena',
    '.ar': '.startarena',
    '.bombpass': '.startbombpass',
    '.bp': '.startbombpass',
    '.ttt': '.tictactoe',
    '.tod': '.truthordare',
    '.gjoin': '.gcjoin',
    '.groupjoin': '.gcjoin'
}));

const REGISTRATION_COMMANDS = new Set([
    '.p', '.profile', '.pgif', '.profilegif', '.bal', '.balance', '.daily', '.beg', '.mine', '.hunt', '.pickaxe', 
    '.work', '.missions', '.gamble', '.claim', '.sell', '.bank', '.network', '.switch', '.deposit', '.dep', 
    '.withdraw', '.wd', '.showcase', '.inv', '.inventory', '.bag', '.back', '.donate', '.use', '.duel', 
    '.elementwar', '.ew', '.battle', '.coinflip', '.cf', '.market', '.wheel', '.dicepoker', '.dp', '.horse', 
    '.slots', '.slot', '.jackpot', '.jp', '.dice', '.roll', '.raffle', '.roulette', '.rlt', '.arena', 
    '.stickroll', '.mr', '.wordquest', '.wq', '.join', '.bet', '.accept', '.tod', '.truthordare',
    '.sf', '.shadowfight', '.pb', '.puzzlebox', '.mr', '.mysticroll', '.bp', '.bombpass', '.ar', '.arena', '.dl'
]);

function getCommandAliases(profile = null) {
    const profileAliases = profile?.aliases && typeof profile.aliases === 'object' && !Array.isArray(profile.aliases)
        ? profile.aliases
        : null;

    if (!profileAliases) return BASE_COMMAND_ALIASES;

    const aliases = new Map(BASE_COMMAND_ALIASES);
    for (const [key, value] of Object.entries(profileAliases)) {
        const normalizedKey = String(key || '').trim().toLowerCase();
        const normalizedValue = String(value || '').trim().toLowerCase();
        if (!normalizedKey || !normalizedValue) continue;
        aliases.set(normalizedKey.startsWith('.') ? normalizedKey : `.${normalizedKey}`,
            normalizedValue.startsWith('.') ? normalizedValue : `.${normalizedValue}`);
    }

    return aliases;
}

function normalizeIncomingCommandText(text = '', profile = null) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const prefix = String(profile?.prefix || '').trim();
    if (!prefix || prefix === '.') return raw;
    if (raw.startsWith(prefix)) {
        return `.${raw.slice(prefix.length)}`.trim();
    }
    return raw;
}

function getNormalizedCommandKey(userMessage = '') {
    const profile = getCurrentProfile();
    const commandAliases = getCommandAliases(profile);
    const normalizedText = String(userMessage || '').trim().toLowerCase();
    if (/^\.set\s+sail(?:\s|$)/.test(normalizedText)) {
        return '.setsail';
    }
    const rawKey = String(userMessage || '').trim().toLowerCase().split(/\s+/)[0] || '';
    return commandAliases.get(rawKey) || rawKey;
}

function extractInteractiveReplyId(message = {}) {
    if (!message || typeof message !== 'object') return '';

    try {
        const paramsJson = message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
        if (paramsJson) {
            const parsed = JSON.parse(paramsJson);
            const id = parsed?.id || parsed?.selectedId || parsed?.selected_id || parsed?.button_id || parsed?.selection?.id || '';
            if (id) return id;
        }
    } catch {}

    for (const value of Object.values(message)) {
        if (!value || typeof value !== 'object') continue;
        const nested = extractInteractiveReplyId(value);
        if (nested) return nested;
    }

    return '';
}

function extractReplyCommandId(message = {}) {
    return (
        extractInteractiveReplyId(message) ||
        message?.buttonsResponseMessage?.selectedButtonId ||
        message?.templateButtonReplyMessage?.selectedId ||
        message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
        ''
    );
}

function collectMentionedJids(node, bucket = []) {
    if (!node || typeof node !== 'object') return bucket;

    if (Array.isArray(node?.contextInfo?.mentionedJid)) {
        for (const jid of node.contextInfo.mentionedJid) {
            if (jid && !bucket.includes(jid)) bucket.push(jid);
        }
    }

    for (const value of Object.values(node)) {
        if (!value || typeof value !== 'object') continue;
        collectMentionedJids(value, bucket);
    }

    return bucket;
}

function isLikelyExternalBotMessage(message, userMessage = '') {
    const keyId = String(message?.key?.id || '');
    const payload = message?.message || {};
    const hasInteractivePayload =
        Boolean(payload?.buttonsMessage) ||
        Boolean(payload?.listMessage) ||
        Boolean(payload?.interactiveMessage) ||
        Boolean(payload?.templateMessage) ||
        Boolean(payload?.viewOnceMessage?.message?.interactiveMessage);

    return (
        keyId.startsWith('BAE5') ||
        keyId.startsWith('BAE6') ||
        hasInteractivePayload
    );
}

function checkCommandSpam(senderId, userMessage) {
    const cmd = getNormalizedCommandKey(userMessage);
    if (!cmd) return null;
    if (cmd === '.sell' || cmd === '.s' || cmd === '.sticker') return null;

    const key = `${senderId}:${cmd}`;
    const now = Date.now();
    const state = commandSpamState.get(key) || { hits: [] };
    state.hits = state.hits.filter((stamp) => now - stamp <= 25_000);
    state.hits.push(now);
    commandSpamState.set(key, state);

    if (state.hits.length >= 12) {
        setTempBan(senderId, COMMAND_SPAM_BAN_MS, 'command spam');
        commandSpamState.delete(key);
        return { command: cmd, durationMs: COMMAND_SPAM_BAN_MS };
    }

    return null;
}
function getProfileCommand() {
    try {
        const profilePath = require.resolve('./commands/social/profile');
        delete require.cache[profilePath];
        const profileCommandModule = require(profilePath);
        if (typeof profileCommandModule === 'function') return profileCommandModule;
        if (typeof profileCommandModule?.profileCommand === 'function') return profileCommandModule.profileCommand;
        if (typeof profileCommandModule?.default === 'function') return profileCommandModule.default;
        if (typeof profileCommandModule?.default?.profileCommand === 'function') return profileCommandModule.default.profileCommand;
        console.error('[profile] invalid export shape:', typeof profileCommandModule, profileCommandModule && Object.keys(profileCommandModule || {}));
    } catch (err) {
        console.error('[profile] load error:', err?.stack || err?.message || err);
    }
    return null;
}
const {
    startRegisterCommand,
    handleRegisterReply,
    clearState: clearRegistrationState
} = optionalCommandRequire('./commands/social/register', {
    startRegisterCommand: makeCanvasUnavailableCommand('Register'),
    handleRegisterReply: async () => false,
    clearState: () => {}
});

const miscCommand = async () => {};
const handleHeart = async () => {};
const stickercropCommand = async () => {};
const updateCommand = async () => {};
const igsCommand = async () => {};
const FAST_MODE = process.env.FAST_MODE !== 'false';
// Removed channel references - bot is now private/personal use

function readJsonFileSafe(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), 'utf8');
            return fallback;
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJsonFileSafe(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function isSenderInActiveGame(chatId, senderId) {
    return Boolean(
        isBombPassParticipant(chatId, senderId) ||
        isArenaParticipant(chatId, senderId) ||
        isPuzzleBoxParticipant(chatId, senderId) ||
        isShadowFightParticipant(chatId, senderId) ||
        isStickRollParticipant(chatId, senderId) ||
        isWordQuestParticipant(chatId, senderId)
    );
}

// Auto-reply function
async function handleAutoReply(sock, chatId, message, userMessage) {
    try {
        // Validate inputs
        if (!userMessage || typeof userMessage !== 'string' || userMessage.trim() === '') {
            return false;
        }
        if (!message || !message.key) {
            return false;
        }
        
        // Safely get autoReplies, defaulting to empty object if not defined
        const autoReplies = settings.autoReplies || {};
        if (!autoReplies || typeof autoReplies !== 'object') {
            return false;
        }
        
        const normalizedMessage = userMessage.toLowerCase().trim();
        if (!normalizedMessage) {
            return false;
        }
        
        const reply = autoReplies[normalizedMessage];
        if (reply && !message.key.fromMe) {
            await sock.sendMessage(chatId, { 
                text: reply,
            }, { quoted: message });
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error in handleAutoReply:', error.message);
        return false;
    }
}

async function handleMessages(sock, messageUpdate, printLog) {
    const startTime = Date.now();
    // Store original sendMessage before any modifications
    const originalSendMessage = sock.sendMessage.bind(sock);

    // Group routing logic for the second bot profile.
    let forcedGroupReplyRouting = false;
    const profile = getCurrentProfile() || sock?.profile || null;
    const bot = getCurrentBot() || sock || null;
    
    try {
        const { messages, type } = messageUpdate;
        const message = messages[0];
        if (!message?.message) return;

        // Prevent double-processing per bot instance, not globally across all bots.
        const processedMessageKey = message.key?.id
            ? `${profile?.botId || sock?.user?.id || 'default'}:${message.key.id}`
            : '';
        if (processedMessageKey && processedMessageIds.has(processedMessageKey)) return;
        if (processedMessageKey) processedMessageIds.add(processedMessageKey);

        const hasInteractiveReply =
            Boolean(message.message?.interactiveResponseMessage) ||
            Boolean(message.message?.buttonsResponseMessage) ||
            Boolean(message.message?.templateButtonReplyMessage) ||
            Boolean(message.message?.listResponseMessage) ||
            Boolean(message.message?.viewOnceMessage?.message?.interactiveResponseMessage) ||
            Boolean(message.message?.viewOnceMessageV2?.message?.interactiveResponseMessage) ||
            Boolean(message.message?.viewOnceMessageV2Extension?.message?.interactiveResponseMessage);

        const isReplayUpsert = type === 'append'; // FIXED: offline queued message processing
        if (type !== 'notify' && !isReplayUpsert && !hasInteractiveReply) return;
        if (isReplayUpsert) {
            const messageAgeMs = Date.now() - getMessageTimestampMs(message);
            if (messageAgeMs > MAX_REPLAY_MESSAGE_AGE_MS) return; // FIXED: replay age limit
        }

        if (profile?.botId) {
            const normalizedBotId = String(profile.botId || '').trim().toLowerCase();
            if (normalizedBotId && !isSynced(normalizedBotId)) {
                await ensureMongoReady(normalizedBotId).catch(() => false); // FIXED: wait for first Mongo sync so registrations and sudo survive restarts
            } else {
                kickMongoReady(profile.botId); // FIXED: remove per-message Mongo readiness await after initial sync
            }
        }
        await ensureSharedEconomyReady().catch(() => false); // FIXED: shared economy must be ready before commands use balances

        // Store message for antidelete feature
        antideleteStoreMessage(sock, message);

        // Handle message revocation
        if (message.message?.protocolMessage?.type === 0) {
            await handleMessageRevocation(sock, message);
            return;
        }

        const chatId = message.key.remoteJid;

        // Handle Pinterest carousel button responses
        if (message.message?.buttonsResponseMessage) {
            const handled = await handlePinterestCarouselResponse(sock, chatId, message);
            if (handled) return;
        }

        const senderCandidates = getSenderCandidates(message);
        const senderId = resolveSenderId(message);
        if (senderCandidates.length > 1) {
            linkProfileAliases(senderCandidates, senderId);
        }
        const isGroup = chatId.endsWith('@g.us');
        
        const originalSendMessage = sock.sendMessage.bind(sock); // FIXED: keep base sender without per-message monkey patch

        if (profile?.botId === 'reze' && isGroup && !message.key.fromMe) {
            const safeTarget = chatId;
            const wrappedSock = Object.create(sock);
            wrappedSock.sendMessage = async function(targetChatId, messageData, options = {}) {
                if (targetChatId && targetChatId !== safeTarget && targetChatId !== 'status@broadcast') {
                    console.log(`[HAIMIYA-ROUTE] Redirected outgoing message from ${targetChatId} to ${safeTarget}`);
                }
                return originalSendMessage(safeTarget, messageData, options);
            };
            sock = wrappedSock;
        }
        
        // Pre-compute message context for performance
        const mentionedJids = (
            message.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
            message.message?.imageMessage?.contextInfo?.mentionedJid ||
            message.message?.videoMessage?.contextInfo?.mentionedJid ||
            []
        ).filter(Boolean);

        let adminStatusPromise = null;
        const getAdminStatus = async () => {
            if (!isGroup) return { isSenderAdmin: false, isBotAdmin: false };
            if (!adminStatusPromise) {
                adminStatusPromise = isAdmin(sock, chatId, senderId); // FIXED: lazy admin status fetch
            }
            return adminStatusPromise;
        };

        const interactiveReplyId = extractReplyCommandId(message.message);

        const parsedUserMessage = (
            message.message?.conversation?.trim() ||
            message.message?.extendedTextMessage?.text?.trim() ||
            interactiveReplyId ||
            message.message?.imageMessage?.caption?.trim() ||
            message.message?.videoMessage?.caption?.trim() ||
            ''
        );

        // Preserve raw message for commands like .tag that need original casing
        const parsedRawText = message.message?.conversation?.trim() ||
            message.message?.extendedTextMessage?.text?.trim() ||
            interactiveReplyId ||
            message.message?.imageMessage?.caption?.trim() ||
            message.message?.videoMessage?.caption?.trim() ||
            '';
        const rawText = normalizeIncomingCommandText(parsedRawText, profile);
        const userMessage = rawText.toLowerCase().replace(/\.\s+/g, '.').trim();

        if (interactiveReplyId && /^\.pint\s+--sticker\s+/i.test(interactiveReplyId)) {
            console.log('[pint] sticker action:', interactiveReplyId);
            await pintCommand(sock, chatId, message, interactiveReplyId);
            return;
        }

        const cmdBase = userMessage.split(/\s+/)[0];
        const requiresRegistration = REGISTRATION_COMMANDS.has(cmdBase);

        // Suppressed [CMD] logs as requested by user
        if (userMessage.startsWith('.')) {
            // console.log(`📝 Command used in ${isGroup ? 'group' : 'private'}: ${userMessage}`);
        }

        const isCommandMessage = userMessage.startsWith('.');
        let privilegePromise = null;
        const getSenderPrivileges = async () => {
            if (!privilegePromise) {
                privilegePromise = getCachedPrivileges(senderId);
            }
            return privilegePromise;
        }; // FIXED: lazy privilege lookup for hot message path
        
        // Hide-mode redirect is disabled in the multi-bot runtime.
        // Owner commands should answer in the same chat they were used from.

        if (!isCommandMessage) {
            await handleAfkReturn(sock, chatId, message, senderId, rawText, profile?.botId).catch(e => console.error('AfkReturn error:', e)); // FIXED: keep AFK return blocking only for plain chat flow
        } else {
            handleAfkReturn(sock, chatId, message, senderId, rawText, profile?.botId).catch(e => console.error('AfkReturn error:', e)); // FIXED: non-blocking AFK return for commands
        }

        const { senderIsSudo, senderIsMod } = (isCommandMessage || (isGroup && !message.key.fromMe))
            ? await getSenderPrivileges()
            : { senderIsSudo: false, senderIsMod: false }; // FIXED: skip privilege resolution for plain messages that do not need it

        if (isGroup && !message.key.fromMe && !senderIsSudo) {
            const antiBotResult = analyzeBotMessage({
                chatId,
                senderId,
                message,
                rawText
            });
            if (antiBotResult.flagged) {
                await enforceAntiBot(sock, chatId, message, senderId, antiBotResult);
                return;
            }
        }

        // Speed optimization: if user is already registered, ensure they don't have a pending registration state
        // This prevents "Yup! And you?" from being caught as a bio if they somehow triggered .register
        if (isCommandMessage) {
            const candidates = getSenderCandidates(message);
            const registeredJid = resolveRegisteredJid(candidates);
            if (registeredJid) {
                clearRegistrationState(registeredJid);
            }
        }

        if (!isCommandMessage && await handleRegisterReply(sock, chatId, message, senderId, rawText)) {
            return;
        }

        if (!isCommandMessage && await handleWelcomeSetupReply(sock, chatId, message, senderId, rawText)) {
            return;
        }

        if (!isCommandMessage && await handleStickerSearchReply(sock, chatId, message, senderId, rawText)) {
            return;
        }

        if (!isCommandMessage && await handleCrewReply(sock, chatId, message, senderId, rawText)) {
            return;
        }

        if (isGroup && !message.key.fromMe) {
            const muteState = getCachedMuteState();
            const groupMutes = muteState.groups?.[chatId];
            let muteEntry = null;
            if (groupMutes) {
                // Check exact match first
                muteEntry = groupMutes[senderId];
                if (!muteEntry) {
                    // Try to find by candidates (LID/Phone/etc) to resolve JID mismatches
                    const targetKey = Object.keys(groupMutes).find(key => sameUserId(key, senderId));
                    if (targetKey) muteEntry = groupMutes[targetKey];
                }
            }

            if (muteEntry) {
                if (Number(muteEntry.expiresAt || 0) <= Date.now()) {
                    delete muteState.groups[chatId][senderId];
                    writeMuteState(muteState);
                } else {
                    try {
                        await sock.sendMessage(chatId, { delete: message.key });
                    } catch {}
                    return;
                }
            }
        }

        if (userMessage.startsWith('.join')) {
            const isExactJoin = userMessage === '.join';
            let handled = false;

            if (isExactJoin) {
                if (await joinTruthOrDare(sock, chatId, message, senderId)) {
                    handled = true;
                } else if (await joinStickRoll(sock, chatId, message, senderId)) {
                    handled = true;
                } else if (await joinArena(sock, chatId, message, senderId)) {
                    handled = true;
                } else if (await joinShadowFight(sock, chatId, message, senderId)) {
                    handled = true;
                } else if (await joinBombPass(sock, chatId, message, senderId)) {
                    handled = true;
                } else if (await joinPuzzleBox(sock, chatId, message, senderId)) {
                    handled = true;
                } else if (await joinWordQuest(sock, chatId, message, senderId)) {
                    handled = true;
                }
            }

            if (!handled) {
                // If it wasn't a game join or had arguments, try group join
                await joinCommand(sock, chatId, message, senderId, rawText);
            }
            return;
        }

        if (await handleElementWarReply(sock, chatId, message, senderId, rawText)) {
            return;
        }

        const lowMsg = userMessage.toLowerCase();
        const rawLow = rawText.toLowerCase().trim();
        const isSfMove =
            lowMsg === '.attack' || lowMsg.startsWith('.attack ') || lowMsg === '.a' || lowMsg.startsWith('.a ') ||
            lowMsg === '.defend' || lowMsg.startsWith('.defend ') || lowMsg === '.d' || lowMsg.startsWith('.d ') ||
            lowMsg === '.special' || lowMsg.startsWith('.special ') || lowMsg === '.sepcial' || lowMsg.startsWith('.sepcial ') ||
            lowMsg === '.s' || lowMsg.startsWith('.s ');

        const isNoDotSfMove = !isSfMove && (
            rawLow === 'attack' || rawLow.startsWith('attack ') || rawLow === 'a' || rawLow.startsWith('a ') ||
            rawLow === 'defend' || rawLow.startsWith('defend ') || rawLow === 'd' || rawLow.startsWith('d ') ||
            rawLow === 'special' || rawLow.startsWith('special ') || rawLow === 'sepcial' || rawLow.startsWith('sepcial ') ||
            rawLow === 's' || rawLow.startsWith('s ')
        );

        if (isSfMove || (isNoDotSfMove && isShadowFightParticipant(chatId, senderId))) {
            const handledShadowFight = await handleShadowFightMove(sock, chatId, message, senderId, rawText);
            if (handledShadowFight) return;
        }

        if (userMessage.startsWith('.pass')) {
            const handledBombPass = await handleBombPassCommand(sock, chatId, message, senderId, rawText);
            if (handledBombPass) return;
        }

        if (await handlePuzzleBoxAnswer(sock, chatId, message, senderId, rawText)) {
            return;
        }

        if (await handleWordQuestAnswer(sock, chatId, message, senderId, rawText)) {
            return;
        }

        if (userMessage && !userMessage.startsWith('.') && !isGroup) {
            handleAutoReply(sock, chatId, message, userMessage).catch(e => console.error('AutoReply error:', e));
        }


        const accessMode = getCachedAccessModeState(profile?.botId).accessMode || 'public';

        // Enforce access mode BEFORE any replies (except owner/sudo)
        try {
            const accessPrivileges = accessMode !== 'public'
                ? await getSenderPrivileges()
                : { senderIsSudo };
            if (!canUseInMode(accessMode, {
                isGroup,
                isOwner: Boolean(message.key.fromMe || accessPrivileges.senderIsSudo)
            })) {
                return;
            }
        } catch (error) {
            console.error('Error checking access mode:', error);
        }

        const tempBan = getTempBan(senderId);
        if (tempBan && userMessage.startsWith('.') && !userMessage.startsWith('.unban') && !senderIsSudo && !message.key.fromMe) {
            await sock.sendMessage(chatId, {
                    text: `❌ You are temporarily banned for ${tempBan.reason}.\n> try again in ${formatDuration(tempBan.until - Date.now())}`
            }, { quoted: message });
            return;
        }

        // Check if user is banned (skip ban check for unban command and owner/sudo)
        if (isBanned(senderId) && userMessage.startsWith('.') && !userMessage.startsWith('.unban') && !senderIsSudo) {
            await sock.sendMessage(chatId, {
                    text: '❌ You are banned from using the bot. Contact an admin to get unbanned.',
            }, { quoted: message });
            return;
        }


        if (!message.key.fromMe) incrementMessageCount(chatId, senderId, senderCandidates);

        if (isGroup && !message.key.fromMe) {
            const messageContext =
                message.message?.extendedTextMessage?.contextInfo ||
                message.message?.imageMessage?.contextInfo ||
                message.message?.videoMessage?.contextInfo ||
                message.message?.documentMessage?.contextInfo ||
                message.message?.groupMentionedMessage?.message?.extendedTextMessage?.contextInfo ||
                message.message?.groupMentionedMessage?.message?.imageMessage?.contextInfo ||
                message.message?.groupMentionedMessage?.message?.videoMessage?.contextInfo ||
                {};
            const isReplyActivity = Boolean(messageContext?.quotedMessage || messageContext?.participant || messageContext?.stanzaId);
            const shouldTrackDropActivity = !isCommandMessage && !isReplyActivity;
            const activityText =
                rawText ||
                userMessage ||
                (message.message?.stickerMessage ? '[sticker]' : '') ||
                (message.message?.reactionMessage ? '[reaction]' : '') ||
                '';

            if (shouldTrackDropActivity && activityText) {
                const dropEvent = observeGroupActivity({
                    chatId,
                    senderId,
                    text: activityText,
                    isGroup,
                    isFromMe: Boolean(message.key.fromMe)
                });

                if (dropEvent) {
                    const thumb = await getRewardImage(dropEvent.rarity);
                    await sock.sendMessage(chatId, buildDropCard(buildSpawnText(dropEvent), thumb, dropEvent.rarity));
                }
            }
        }

        // Passive moderation checks (Parallelized)
        if (isGroup && !isCommandMessage) {
            (async () => {
                try {
                    const adminStatus = await getAdminStatus();
                    await Promise.all([
                        typeof handleStatusMentionDetection === 'function' ? handleStatusMentionDetection(sock, chatId, message, senderId) : null,
                        typeof handleAntipornDetection === 'function' ? handleAntipornDetection(sock, chatId, message, senderId, adminStatus) : null,
                        typeof antibadLib.handleBadwordDetection === 'function' ? antibadLib.handleBadwordDetection(sock, chatId, message, userMessage, senderId, adminStatus) : null,
                        typeof antilinkLib.Antilink === 'function' ? antilinkLib.Antilink(message, sock, adminStatus) : null,
                        typeof handleAfkMentions === 'function' ? handleAfkMentions(sock, chatId, message, senderId, mentionedJids) : null
                    ]);
                } catch (err) {
                    console.error('[moderation] parallel error:', err);
                }
            })();
        }

        if (!isCommandMessage && await handleHorseReply(sock, chatId, message, senderId, rawText)) {
            return;
        }

        // Centralized Game Session Listener (Hangman, TicTacToe, etc.)
        const gameSession = getSession(chatId);
        if (gameSession && typeof gameSession.onMessage === 'function') {
            const isReply = message.message?.extendedTextMessage?.contextInfo?.quotedMessage || false;
            const isMove = gameSession.type === 'tictactoe' && /^[1-9]$/.test(userMessage);

            // Handle replies (Hangman) or moves (TTT)
            if (isReply || isMove || userMessage.toLowerCase() === 'surrender') {
                const handled = await gameSession.onMessage(sock, message, senderId, userMessage);
                if (handled) return;
            }
        }

        // PM blocker: block non-owner DMs when enabled (do not ban)
        if (!isGroup && !message.key.fromMe && !senderIsSudo) {
            try {
                const pmState = readPmBlockerState();
                if (pmState.enabled) {
                    await sock.sendMessage(chatId, { text: pmState.message || 'Private messages are blocked. Please contact the owner in groups only.' });
                    await new Promise(r => setTimeout(r, 1500));
                    try { await sock.updateBlockStatus(chatId, 'block'); } catch (e) { }
                    return;
                }
            } catch (e) { }
        }

        // Then check for command prefix
        if (!userMessage.startsWith('.')) {
            if (isGroup) {
                // Truth or Dare — single router handles all states
                if (isTodParticipant(chatId, senderId)) {
                    await handleTodMessage(sock, chatId, senderId, message);
                }

                // Process non-command messages first (skip bot's own messages to prevent self-talk)
                if (!message.key.fromMe && !isSenderInActiveGame(chatId, senderId) && !isTodParticipant(chatId, senderId)) {
                    await handleChatbotResponse(sock, chatId, message, userMessage, senderId);
                }
                await handleTagDetection(sock, chatId, message, senderId);
                await handleMentionDetection(sock, chatId, message);
                await maybeTriggerBondBonus(sock, chatId, message, senderId, isGroup);
            }
            return;
        }

        if (!message.key.fromMe && !senderIsSudo) {
            const spamBan = checkCommandSpam(senderId, userMessage);
            if (spamBan) {
                await sock.sendMessage(chatId, {
                    text: `❌ Temporary ban applied for command spam.\n> blocked for ${formatDuration(spamBan.durationMs)}`
                }, { quoted: message });
                return;
            }
        }

        if (
            requiresRegistration &&
            userMessage !== '.reg' &&
            userMessage !== '.register' &&
            !isRegistered(senderId)
        ) {
            await sock.sendMessage(chatId, {
                text: 'Register first with `.register` before using profile or economy commands.'
            }, { quoted: message });
            return;
        }


        if (userMessage.startsWith('.tod') || userMessage.startsWith('.truthordare')) {
            const adminStatus = await getAdminStatus();
            await startTruthOrDare(sock, chatId, message, senderId, adminStatus.isSenderAdmin);
            return;
        }

        if (userMessage.startsWith('.start')) {
            const handledTodStart = await handleTodMessage(sock, chatId, senderId, message);
            if (handledTodStart) return;
        }


        const commandKey = getNormalizedCommandKey(userMessage);
        const cmd = commandHandler.get(commandKey);

        if (cmd) {
            if (isGroup && commandKey !== '.wistoria' && !isWistoriaEnabled(chatId)) {
                return;
            }
            // Speed optimization: avoid re-computing adminStatus and mentions
            const args = userMessage.split(/\s+/).slice(1);

            try {
                const adminStatus = await getAdminStatus();
                await cmd.execute({
                    sock, bot, profile, chatId, message, args, senderId,
                    userMessage, rawText, mentionedJids,
                    commandKey,
                    isSenderAdmin: adminStatus.isSenderAdmin,
                    isBotAdmin: adminStatus.isBotAdmin,
                    isOwner: Boolean(message.key.fromMe || senderIsSudo),
                    isMod: Boolean(senderIsMod)
                });
                commandExecuted = true;
                const cmdTime = Date.now() - startTime;
                if (process.env.DEBUG_PERF === '1') {
                    console.log(`[PERF] Command ${commandKey} took ${cmdTime}ms`);
                }
            } catch (err) {
                console.error(`Command Error [${commandKey}]:`, err); // FIXED: include command key so ctx-style regressions identify the failing command
            }
            return;
        }

        // Passive economy tracking for non-command messages.
        if (userMessage && !message.key.fromMe) {
            processMessageActivity({
                jid: senderId,
                text: userMessage,
                chatId,
                isCommand: userMessage.startsWith('.'),
                isFromMe: Boolean(message.key.fromMe),
                isGroup,
                replyTargetJid: message?.message?.extendedTextMessage?.contextInfo?.participant || ''
            });
        }

        if (!FAST_MODE && userMessage.startsWith('.')) {
            addCommandReaction(sock, message).catch(() => null);
        }
        
    } catch (error) {
        // Only log errors, don't send to WhatsApp to avoid spamming
        console.error('❌ Error in message handler:', error.message);
        console.error('Error in handleMessages:', error);
        if (error.stack) {
            console.error('Stack trace:', error.stack);
        }
        // Do not send error messages to WhatsApp - just log them
    } finally {
        const totalTime = Date.now() - startTime;
        if (process.env.DEBUG_PERF === '1') {
            console.log(`[PERF] Message pipeline total: ${totalTime}ms`);
        }
    }
}

// Function to handle .groupjid command
async function groupJidCommand(sock, chatId, message) {
    const groupJid = message.key.remoteJid;

    if (!groupJid.endsWith('@g.us')) {
        return await sock.sendMessage(chatId, {
            text: "❌ This command can only be used in a group."
        });
    }

    await sock.sendMessage(chatId, {
        text: `✅ Group JID: ${groupJid}`
    }, {
        quoted: message
    });
}

async function handleGroupParticipantUpdate(sock, update) {
    try {
        const { id, participants, action, author } = update;
        const { getBotId } = require('./lib/botDataPath');
        const currentBotId = getBotId();

        console.log(`[EVENT] group-participants.update | Bot: ${currentBotId} | Action: ${action} | Chat: ${id}`);

        if (!id.endsWith('@g.us')) return;
        const normalizeActor = (value) => String(value || '').split('@')[0].split(':')[0].trim();
        const botActors = [
            sock?.user?.id,
            sock?.user?.lid,
            sock?.user?.pn,
            sock?.user?.phoneNumber
        ].map(normalizeActor).filter(Boolean);
        
        const normalizedAuthor = normalizeActor(author);
        if (botActors.includes(normalizedAuthor)) {
            console.log(`[EVENT] Skipping bot-triggered action (${action}) by ${normalizedAuthor}`);
            return;
        }
        
        if (consumeAdminUpdate(id, action, participants || [])) {
            console.log(`[EVENT] Skipping admin-tracked update (${action})`);
            return;
        }

        let accessMode = 'public';
        try {
            accessMode = getCachedAccessModeState(currentBotId).accessMode || 'public';
        } catch (e) {
        }

        const guardHandled = await processAdminGuard(sock, update, isOwnerOrSudo);
        if (guardHandled) return;

        if (action === 'promote') {
            if (!canUseInMode(accessMode, { isGroup: true, isOwner: false })) return;
            await handlePromotionEvent(sock, id, participants, author);
            return;
        }

        if (action === 'demote') {
            if (!canUseInMode(accessMode, { isGroup: true, isOwner: false })) return;
            await handleDemotionEvent(sock, id, participants, author);
            return;
        }

        if (action === 'add') {
            await handleJoinEvent(sock, id, participants);
        }

        if (action === 'remove') {
            await handleLeaveEvent(sock, id, participants);
        }
    } catch (error) {
        const text = String(error?.message || error || '').toLowerCase();
        if (text.includes('forbidden') || text.includes('not-authorized')) {
            console.warn('Group participant update skipped:', error?.message || error); // FIXED: suppress noisy forbidden participant update errors
            return;
        }
        console.error('Error in handleGroupParticipantUpdate:', error);
    }
}

async function getCachedPrivileges(senderId = '') {
    const key = String(senderId || '').trim();
    if (!key) return { senderIsSudo: false, senderIsMod: false };

    const cached = privilegeCache.get(key);
    const now = Date.now();
    if (cached && (now - cached.at) < PRIVILEGE_CACHE_TTL_MS) {
        return cached.value;
    }

    const senderIsMod = hasStaffRole(key, ['mods']);
    const value = {
        senderIsSudo: senderIsMod ? true : await isOwnerOrSudo(key),
        senderIsMod
    }; // FIXED: avoid duplicate mod-role lookups on hot path

    privilegeCache.set(key, { value, at: now });
    return value;
}

function kickMongoReady(botId) {
    const normalized = String(botId || '').trim().toLowerCase();
    if (!normalized || mongoReadyKickoffBots.has(normalized)) return;
    mongoReadyKickoffBots.add(normalized);
    ensureMongoReady(normalized).catch((err) => {
        console.error(`[mongo] readiness failed for ${normalized}:`, err?.message || err);
        mongoReadyKickoffBots.delete(normalized);
    }); // FIXED: background Mongo readiness kickoff
}

module.exports = {
    handleMessages,
    handleGroupParticipantUpdate,
    handleStatus: async (sock, status) => {
        if (status.reaction) {
            await handleTodReaction(sock, status.reaction);
        }
        await handleStatusUpdate(sock, status);
    }
};
