const fs = require('fs');
const path = require('path');
const isAdmin = require('../../lib/isAdmin');
const { hasAdminBypass } = require('../../lib/adminBypass');
const { resolveRegisteredJid } = require('../../lib/registrationStore');
const { isMod } = require('../../lib/permissionMiddleware');

const STATE_PATH = path.join(process.cwd(), 'data', 'groupUserMutes.json');

function ensureState() {
    if (!fs.existsSync(STATE_PATH)) {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(STATE_PATH, JSON.stringify({ groups: {} }, null, 2), 'utf8');
    }
}

function readState() {
    ensureState();
    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        if (!parsed.groups || typeof parsed.groups !== 'object') parsed.groups = {};
        return parsed;
    } catch {
        return { groups: {} };
    }
}

function writeState(state) {
    ensureState();
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function normalizeJid(jid = '') {
    if (!jid) return '';
    return String(jid).split('@')[0].split(':')[0].replace(/\D/g, '').trim();
}

function toMentionJid(jid = '') {
    const raw = String(jid || '').trim();
    if (!raw) return '';
    if (raw.includes('@')) return raw;
    return `${normalizeJid(raw)}@s.whatsapp.net`;
}

function mentionLabel(jid = '') {
    const raw = String(jid || '');
    const id = normalizeJid(raw);
    return `@${id || 'user'}`;
}

function getContextInfo(message) {
    return (
        message?.message?.extendedTextMessage?.contextInfo ||
        message?.message?.imageMessage?.contextInfo ||
        message?.message?.videoMessage?.contextInfo ||
        {}
    );
}

function parseDurationToken(text = '') {
    const matches = String(text || '').match(/(\d+)([smhd])/gi);
    if (!matches) return 0;
    let total = 0;
    for (const token of matches) {
        const match = token.match(/(\d+)([smhd])/i);
        if (!match) continue;
        const value = Number(match[1]);
        const unit = match[2].toLowerCase();
        if (unit === 's') total += value * 1000;
        if (unit === 'm') total += value * 60 * 1000;
        if (unit === 'h') total += value * 60 * 60 * 1000;
        if (unit === 'd') total += value * 24 * 60 * 60 * 1000;
    }
    return total;
}

function formatDuration(ms) {
    const totalSeconds = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

function parseMuteArgs(message, rawText = '') {
    const ctx = getContextInfo(message);
    const mentioned = Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid : [];
    const rawTargetJid = mentioned[0] || ctx.participant || '';
    // Bridge LID → Phone JID so mute key is always a phone number
    const resolvedJid = resolveRegisteredJid([rawTargetJid]) || rawTargetJid;
    const durationMs = parseDurationToken(rawText);
    return {
        targetJid: normalizeJid(resolvedJid),
        mentionJid: toMentionJid(resolvedJid),
        durationMs
    };
}

function ensureGroup(state, chatId) {
    if (!state.groups[chatId] || typeof state.groups[chatId] !== 'object') {
        state.groups[chatId] = {};
    }
    return state.groups[chatId];
}

function setMutedUser(chatId, targetJid, data, extraAliases = []) {
    const state = readState();
    const group = ensureGroup(state, chatId);
    const keys = new Set();
    const primaryKey = normalizeJid(targetJid);
    if (primaryKey) keys.add(primaryKey);
    for (const alias of extraAliases) {
        const k = normalizeJid(alias);
        if (k) keys.add(k);
    }
    for (const key of keys) {
        group[key] = data;
    }
    if (process.env.DEBUG_MUTE === '1') {
        console.log(`[MUTE-SET] chatId=${chatId}, keys=${JSON.stringify([...keys])}`);
    }
    writeState(state);
}

async function muteCommand(sock, chatId, senderId, message, rawText = '') {
    if (!chatId.endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: 'This command only works in groups.' }, { quoted: message });
        return;
    }

    const bypass = await hasAdminBypass(message, senderId);
    const { isSenderAdmin, isBotAdmin } = await isAdmin(sock, chatId, senderId);
    if (!isSenderAdmin && !bypass) {
        await sock.sendMessage(chatId, { text: 'Only group admins can use `.mute`.' }, { quoted: message });
        return;
    }
    if (!isBotAdmin) {
        await sock.sendMessage(chatId, { text: 'Make the bot admin so it can delete muted messages.' }, { quoted: message });
        return;
    }

    const { targetJid, mentionJid, durationMs: parsedDuration } = parseMuteArgs(message, rawText);
    const durationMs = parsedDuration || (30 * 60 * 1000); // Default to 30m

    if (!targetJid) {
        await sock.sendMessage(chatId, { text: 'Mention or reply to a user.\nExample: `.mute @user 10m`' }, { quoted: message });
        return;
    }
    
    if (targetJid === senderId) {
        await sock.sendMessage(chatId, { text: 'You cannot mute yourself.' }, { quoted: message });
        return;
    }

    if (isMod(targetJid)) {
        await sock.sendMessage(chatId, { text: 'You cannot mute sudo members.' }, { quoted: message });
        return;
    }

    const now = Date.now();
    
    // Gather aliases (LID + phone) from group metadata so mute matches in both forms
    const aliases = [];
    try {
        const meta = await sock.groupMetadata(chatId);
        const targetDigits = normalizeJid(targetJid);
        for (const p of (meta?.participants || [])) {
            const candidates = [p.id, p.jid, p.lid].filter(Boolean);
            const candidateDigits = candidates.map(c => normalizeJid(c));
            if (candidateDigits.includes(targetDigits)) {
                aliases.push(...candidates);
                break;
            }
        }
    } catch {}
    
    setMutedUser(chatId, targetJid, {
        mutedBy: senderId,
        mutedAt: now,
        expiresAt: now + durationMs
    }, aliases);

    await sock.sendMessage(chatId, {
        text: `Muted ${mentionLabel(mentionJid || targetJid)} for ${formatDuration(durationMs)}`,
        mentions: [mentionJid || `${targetJid}@s.whatsapp.net`]
    }, { quoted: message });
}

module.exports.formatMuteDuration = formatDuration;

module.exports = {
  name: 'mute',
  permissionLevel: 'admin', // FIXED: central admin permission
  readMuteState: readState,
  writeMuteState: writeState,
  formatMuteDuration: formatDuration,
  async execute(ctx) {
    return muteCommand(ctx.sock || null, ctx.chatId || null, ctx.senderId || null, ctx.message || null, ctx.rawText || null);
  }
};
