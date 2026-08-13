const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeJsonSafe } = require('../../utils/jsonStore');
const { parseMention } = require('../../lib/myfunc');
const { resolveRegisteredJid } = require('../../lib/registrationStore');
const { resolveAfkName, cleanMentionText, formatMentionsWithNames } = require('../../lib/afkUtils');
const DATA_DIR = path.join(process.cwd(), 'data');
const AFK_FILE = path.join(DATA_DIR, 'afk.json');
const afkMap = new Map();
const AFK_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function normalizeUserKey(userId) {
    return String(userId || '').split('@')[0].split(':')[0].replace(/[^\d]/g, '');
}

function normalizeAnyUserKey(userId) {
    return String(userId || '').split('@')[0].split(':')[0].replace(/[^a-zA-Z0-9]/g, '');
}

function isUserJid(value) {
    const jid = String(value || '').trim();
    if (!jid) return false;
    if (jid.endsWith('@g.us')) return false;
    if (jid === 'status@broadcast') return false;
    return jid.includes('@');
}

function extractAllJids(text) {
    if (!text) return [];
    // 1. Find all things starting with @ followed by optional +, digits, spaces, or dashes (must end with digit)
    const atParts = [...text.matchAll(/@\+?([0-9]+(?:[\s\-]+[0-9]+)*)/g)];
    const fromAt = atParts.map(v => v[1].replace(/[^\d]/g, '') + '@s.whatsapp.net');
    
    // 2. Find all full JIDs (with optional multi-device suffix) or LIDs
    const fullJids = [...text.matchAll(/([0-9]{5,20})(?::\d+)?@(s\.whatsapp\.net|lid)/g)].map(v => v[1] + '@' + v[2]);
    
    return Array.from(new Set([...fromAt, ...fullJids].filter(jid => jid.split('@')[0].length >= 5)));
}

function formatMentionsInText(text) {
    if (!text) return '';
    // Clean up JIDs and +numbers using afkUtils
    return cleanMentionText(text);
}

async function resolveDisplayReason(sock, chatId, reason) {
    if (!reason) return { text: 'No reason', mentions: [] };
    
    const out = await formatMentionsWithNames(sock, reason);
    const jids = extractAllJids(reason);
    const resolvedMentions = jids.map(rawJid => resolveRegisteredJid([rawJid]) || rawJid);
    
    return { text: out, mentions: [...new Set(resolvedMentions)] };
}



function ensureStorage() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (!fs.existsSync(AFK_FILE)) {
        writeJsonSafe(AFK_FILE, {});
    }
}

function normalizeReason(reason) {
    const cleaned = String(reason || '').trim();
    return cleaned || 'No reason';
}

function extractRawAfkReason(message) {
    const rawText =
        message?.message?.conversation ||
        message?.message?.extendedTextMessage?.text ||
        message?.message?.imageMessage?.caption ||
        message?.message?.videoMessage?.caption ||
        '';

    const trimmed = String(rawText || '').trim();
    if (!trimmed) return '';

    return trimmed.replace(/^\.afk\b/i, '').trim();
}

function loadAfkState() {
    try {
        ensureStorage();
        const parsed = readJsonSafe(AFK_FILE, {});
        afkMap.clear();

        for (const [userId, entry] of Object.entries(parsed)) {
            if (!userId || !entry || typeof entry !== 'object') continue;
            if (typeof entry.timestamp !== 'number') continue;

            const key = normalizeUserKey(entry.userId || userId);
            if (!key) continue;

            afkMap.set(key, {
                userId: entry.userId || userId,
                aliases: Array.isArray(entry.aliases) ? [...new Set(entry.aliases.map(normalizeUserKey).filter(Boolean))] : [key],
                reason: normalizeReason(entry.reason),
                displayReason: normalizeReason(entry.displayReason || entry.reason),
                timestamp: entry.timestamp
            });
        }
    } catch (error) {
        console.error('[AFK] Failed to load AFK state:', error.message);
    }
}

function saveAfkState() {
    try {
        ensureStorage();
        const payload = Object.fromEntries(afkMap.entries());
        writeJsonSafe(AFK_FILE, payload);
    } catch (error) {
        console.error('[AFK] Failed to save AFK state:', error.message);
    }
}

function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(' ');
}

function collectActorIds(message, fallbackUserId = '') {
    const ids = [
        fallbackUserId,
        message?.key?.participant,
        message?.key?.participantAlt
        // removed remoteJid as it causes auto-return in private chats
    ];
    return [...new Set(
        ids
            .map((value) => String(value || '').trim())
            .filter((value) => isUserJid(value))
            .filter((value) => !value.endsWith('@g.us')) // Extra safety
    )];
}

function collectNormalizedKeys(ids = []) {
    // Resolve canonical JIDs (Phone JIDs) for each candidate to bridge LID/Phone JID
    const canonicals = ids.map(id => resolveRegisteredJid([id])).filter(Boolean);
    const rawDigits = ids.map(normalizeUserKey).filter(Boolean);
    return [...new Set([...canonicals.map(normalizeUserKey), ...rawDigits])];
}

function getAfkByIds(ids = []) {
    const keys = collectNormalizedKeys(ids);
    for (const key of keys) {
        const entry = afkMap.get(key);
        if (!entry) continue;
        if (Date.now() - Number(entry.timestamp || 0) > AFK_STALE_MS) {
            const staleKeys = new Set([
                key,
                normalizeUserKey(entry.userId),
                ...collectNormalizedKeys(entry.aliases || [])
            ]);
            for (const staleKey of staleKeys) {
                afkMap.delete(staleKey);
            }
            saveAfkState();
            continue;
        }
        return entry;
    }
    return null;
}

function setAfk(userIds, reason, displayReason = '') {
    const ids = Array.isArray(userIds) ? userIds : [userIds];
    const keys = collectNormalizedKeys(ids);
    if (!keys.length) return null;

    // Prefer @s.whatsapp.net over anything else
    const primaryUserId = ids.find(id => String(id).endsWith('@s.whatsapp.net')) || ids.find(Boolean) || '';

    const entry = {
        userId: primaryUserId,
        aliases: keys,
        reason: normalizeReason(reason),
        displayReason: normalizeReason(displayReason || reason),
        timestamp: Date.now()
    };

    for (const key of keys) {
        afkMap.set(key, entry);
    }
    saveAfkState();
    
    if (process.env.DEBUG_AFK === '1') {
        console.log(`[AFK] Set for ${primaryUserId}. Aliases: ${keys.join(', ')}. Reason: ${entry.reason}`);
    }
    return entry;
}

function getAfk(userIds) {
    const ids = Array.isArray(userIds) ? userIds : [userIds];
    return getAfkByIds(ids);
}

function removeAfk(userIds) {
    const ids = Array.isArray(userIds) ? userIds : [userIds];
    const existing = getAfkByIds(ids);
    if (!existing) return null;

    const keys = new Set([
        ...collectNormalizedKeys(ids),
        ...collectNormalizedKeys(existing.aliases || []),
        normalizeUserKey(existing.userId)
    ]);

    for (const key of keys) {
        afkMap.delete(key);
    }
    saveAfkState();
    return existing;
}

function getMessageContextInfo(message) {
    if (!message?.message) return null;

    const queue = [message.message];
    while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== 'object') continue;

        if (current.contextInfo) return current.contextInfo;

        for (const value of Object.values(current)) {
            if (value && typeof value === 'object') {
                queue.push(value);
            }
        }
    }

    return null;
}

function getMentionedJids(message) {
    const contextInfo = getMessageContextInfo(message);
    const mentioned = Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid : [];
    return [...new Set(mentioned.filter(Boolean))];
}

function isReplyMessage(message) {
    const contextInfo = getMessageContextInfo(message);
    return Boolean(contextInfo?.stanzaId || contextInfo?.quotedMessage || contextInfo?.participant);
}

function isUserActionMessage(message) {
    if (!message?.message) return false;
    const type = Object.keys(message.message)[0];
    // Ignore system/protocol messages and reactions/polls for AFK return
    if ([
        'protocolMessage', 
        'senderKeyDistributionMessage', 
        'reactionMessage', 
        'pollUpdateMessage',
        'editedMessage',
        'appendMessage'
    ].includes(type)) return false;
    return true;
}

async function resolveName(sock, chatId, userId) {
    const number = normalizeUserKey(userId);
    let name = null;
    
    if (chatId && chatId.endsWith('@g.us')) {
        try {
            const meta = await sock.groupMetadata(chatId);
            const targetAny = normalizeAnyUserKey(userId);
            const participant = meta?.participants?.find(p => {
                const candidates = [p.id, p.jid, p.lid, p.phoneNumber].map(normalizeAnyUserKey).filter(Boolean);
                return candidates.includes(targetAny) || candidates.includes(number);
            });
            name = participant?.notify || participant?.name || null;
        } catch (e) {}
    }
    
    if (!name) {
        try {
            name = await sock.getName(userId);
            if (name && name.replace(/[^\d]/g, '') === number) name = null;
            if (name && normalizeAnyUserKey(name) === normalizeAnyUserKey(userId)) name = null;
        } catch (e) {}
    }
    
    if (name) return name;
    if (String(userId || '').endsWith('@lid')) return 'user';
    return number || 'user';
}

async function sendAfkMessage(sock, chatId, message, text, mentions = []) {
    if (!sock?.sendMessage || !chatId) {
        console.warn('[AFK] Skipping AFK reply because sendMessage is unavailable');
        return null;
    }

    try {
        const uniqueMentions = [...new Set(mentions.filter(Boolean))];
        let finalText = text;
        for (const jid of uniqueMentions) {
            const num = jid.split('@')[0].split(':')[0];
        }
        return await sock.sendMessage(chatId, {
            text: finalText,
            mentions: uniqueMentions
        }, { quoted: message });
    } catch (error) {
        console.error('[AFK] Send failed:', error);
    }
}

async function afkCommand(sock, chatId, message, reason) {
    const senderIds = collectActorIds(message, message?.key?.participant || message?.key?.remoteJid);
    const senderId = senderIds[0];
    if (!senderId) return;
    const actorIds = senderIds; // Always the sender

    // Extract raw reason text from the message, then strip only the sender's own leading @mention
    let rawReason = extractRawAfkReason(message) || reason || '';
    
    // Only strip leading mentions that belong to the sender themselves
    // (WhatsApp sometimes auto-injects the sender's mention). Keep other people's mentions.
    const senderNumber = normalizeUserKey(senderId);
    let stripped = rawReason.trim();
    while (true) {
        const mentionMatch = stripped.match(/^@(?:\+?[\d\s\-]+|[\w\d\.~]+)\b/);
        if (!mentionMatch) break;
        const mentionedDigits = mentionMatch[0].replace(/[^\d]/g, '');
        // Only strip if this mention is the sender's own number
        if (mentionedDigits && mentionedDigits === senderNumber) {
            stripped = stripped.slice(mentionMatch[0].length).trim();
        } else {
            break;
        }
    }
    const cleanReason = stripped || 'No reason';

    // Normalize @number mentions inside the reason for storage
    let normalizedReason = cleanReason;
    const mentionedJids = getMentionedJids(message);
    if (mentionedJids.length > 0) {
        normalizedReason = normalizedReason.replace(/@\+?([0-9]+(?:[\s\-]+[0-9]+)*)/g, (match, p1) => {
            const digits = p1.replace(/[^\d]/g, '');
            const isMentioned = mentionedJids.some(jid => normalizeUserKey(jid) === digits);
            if (isMentioned) return `@${digits}`;
            return match;
        });
    }

    const { text: displayText, mentions: displayMentions } = await resolveDisplayReason(sock, chatId, normalizedReason);
    const entry = setAfk(actorIds, normalizedReason, displayText);
    if (!entry) return;

    const name = await resolveName(sock, chatId, entry.userId);
    const text = `🌙 @${name} 𝖠𝖥𝖪 now\nreason: ${entry.displayReason}`;

    await sendAfkMessage(sock, chatId, message, text, [entry.userId, ...extractAllJids(entry.reason), ...displayMentions]);
}

async function handleAfkMentions(sock, chatId, message, senderId, precomputedMentionedJids = null) {
    if (message?.key?.fromMe) return;

    // Enhanced deduplication across multiple bot instances/processes
    const msgId = String(message?.key?.id || '');
    if (!msgId) return;

    const lockFile = path.join(DATA_DIR, `afk_lock_${msgId}.tmp`);
    
    try {
        // Atomic write with 'wx' flag fails if file already exists (preventing doubles)
        fs.writeFileSync(lockFile, String(Date.now()), { flag: 'wx' });
        
        // Auto-cleanup lock after 15 seconds
        setTimeout(() => {
            try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch(e) {}
        }, 15000);
    } catch (e) {
        // If write fails, someone else already handled it OR disk error
        if (e.code === 'EEXIST') return; 
        
        // Memory fallback for environments with locked file systems
        const dedupKey = `afk_mention:${msgId}`;
        if (global[dedupKey]) return;
        global[dedupKey] = true;
        setTimeout(() => { delete global[dedupKey]; }, 15000);
    }

    const text = message?.message?.conversation || message?.message?.extendedTextMessage?.text || '';
    const mentionedFromText = extractAllJids(text);
    const rawMentioned = [...new Set([...(precomputedMentionedJids || getMentionedJids(message)), ...mentionedFromText])];
    
    if (!rawMentioned.length) return;

    // Deduplicate by normalized key to avoid dual text (e.g. 123@s.whatsapp.net vs 123:1@s.whatsapp.net)
    const seenKeys = new Set();
    const uniqueMentioned = [];
    for (const jid of rawMentioned) {
        const key = normalizeUserKey(jid);
        if (key && !seenKeys.has(key)) {
            seenKeys.add(key);
            uniqueMentioned.push(jid);
        }
    }

    const afkResponses = [];
    const allMentions = [];

    for (const mentionedJid of uniqueMentioned) {
        if (!mentionedJid) continue;
        const normalizedMentioned = normalizeUserKey(mentionedJid);
        if (normalizedMentioned === normalizeUserKey(senderId)) continue;

        const afk = getAfk([mentionedJid]);
        if (!afk) continue;

        const { text: displayReason, mentions: displayMentions } = await resolveDisplayReason(sock, chatId, afk.reason);
        const name = await resolveName(sock, chatId, afk.userId);
        const awayTime = formatDuration(Date.now() - afk.timestamp);
        
        afkResponses.push(`📌 @${name} is currently 𝖠𝖥𝖪\nreason: ${displayReason}\naway for: ${awayTime}`);
        allMentions.push(afk.userId);
        allMentions.push(...extractAllJids(afk.reason));
        allMentions.push(...displayMentions);
    }

    if (afkResponses.length > 0) {
        await sendAfkMessage(sock, chatId, message, afkResponses.join('\n\n'), allMentions);
    }
}

async function handleAfkReturn(sock, chatId, message, senderId, rawText, botId = 'bot') {
    const actorIds = collectActorIds(message, senderId);
    const afk = getAfk(actorIds);
    if (!afk) return false;

    const lowered = String(rawText || '').trim().toLowerCase();
    if (lowered.startsWith('.afk')) return false;
    if (message.key.fromMe) return false; // Bot sending messages shouldn't trigger return
    if (!isUserActionMessage(message)) return false;

    const removed = removeAfk(actorIds);
    if (!removed) return false;

    if (process.env.DEBUG_AFK === '1') {
        console.log(`[AFK:${botId}] User ${senderId} returned. Stored JID: ${removed.userId}. Duration: ${Date.now() - removed.timestamp}ms`);
    }

    const duration = formatDuration(Date.now() - removed.timestamp);
    const { text: displayReason, mentions: displayMentions } = await resolveDisplayReason(sock, chatId, removed.reason);
    const name = await resolveName(sock, chatId, removed.userId);
    const text = `🟢 @${name} back\nreason: ${displayReason}\naway for: ${duration}`;

    await sendAfkMessage(sock, chatId, message, text, [removed.userId, ...extractAllJids(removed.reason), ...displayMentions]);
    return true;
}

module.exports = {
    name: 'afk',
    async execute(ctx) {
        const rawAfterCmd = String(ctx.rawText || ctx.userMessage || '').replace(/^\S+\s*/, '');
        return afkCommand(
            ctx.sock || null,
            ctx.chatId || null,
            ctx.message || null,
            rawAfterCmd
        );
    },
    afkCommand,
    getAfk,
    handleAfkMentions,
    handleAfkReturn
};

loadAfkState();
