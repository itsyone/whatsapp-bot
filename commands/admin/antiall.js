const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeJsonSafe } = require('../../utils/jsonStore');
const isAdmin = require('../../lib/isAdmin');
const isOwnerOrSudo = require('../../lib/isOwner');

const DATA_FILE = path.join(process.cwd(), 'data', 'antiall.json');
let store = null;

function loadStore() {
    if (!store) store = readJsonSafe(DATA_FILE, {});
    return store;
}

function saveStore() {
    writeJsonSafe(DATA_FILE, store);
}

function isAntiAllEnabled(chatId) {
    return Boolean(loadStore()[chatId]);
}

function setAntiAll(chatId, enabled) {
    loadStore();
    store[chatId] = enabled;
    saveStore();
}

// Returns true if message contains a bulk @all mention attempt
function isBulkMentionAbuse(message, participantCount) {
    const text =
        message?.message?.conversation ||
        message?.message?.extendedTextMessage?.text ||
        message?.message?.imageMessage?.caption ||
        message?.message?.videoMessage?.caption ||
        '';

    // Check for @all text
    if (/@all\b/i.test(text)) return true;

    // Check if mentionedJid contains all/most group members (>= 70% or >= 10)
    const ctxInfo =
        message?.message?.extendedTextMessage?.contextInfo ||
        message?.message?.imageMessage?.contextInfo ||
        message?.message?.videoMessage?.contextInfo ||
        {};
    const mentioned = Array.isArray(ctxInfo?.mentionedJid) ? ctxInfo.mentionedJid : [];
    if (participantCount >= 5 && mentioned.length >= Math.max(10, Math.floor(participantCount * 0.7))) {
        return true;
    }

    return false;
}

async function handleAntiAll(sock, chatId, message, senderId, adminContext = {}) {
    console.log('[ANTIALL] Triggered for', chatId, senderId, 'enabled:', isAntiAllEnabled(chatId));

    if (!isAntiAllEnabled(chatId)) {
        console.log('[ANTIALL] Not enabled for this group');
        return false;
    }

    // Force fresh admin check to avoid stale cache after promotion
    const freshAdminStatus = await isAdmin(sock, chatId, senderId);
    const isSenderAdmin = Boolean(freshAdminStatus.isSenderAdmin);
    const isSudoOrMod = await isOwnerOrSudo(senderId);

    console.log('[ANTIALL] Sender admin:', isSenderAdmin, 'sudo/mod:', isSudoOrMod);
    if (isSenderAdmin || isSudoOrMod) {
        console.log('[ANTIALL] Sender has permission, skipping');
        return false;
    }

    let participantCount = 0;
    try {
        const meta = await sock.groupMetadata(chatId);
        participantCount = meta?.participants?.length || 0;
    } catch {}

    const isAbuse = isBulkMentionAbuse(message, participantCount);
    console.log('[ANTIALL] Bulk mention abuse detected:', isAbuse, 'participants:', participantCount);
    if (!isAbuse) return false;

    // Try to delete the message if bot is admin
    const isBotAdmin = Boolean(adminContext.isBotAdmin);
    console.log('[ANTIALL] Bot admin:', isBotAdmin);
    if (isBotAdmin) {
        try {
            await sock.sendMessage(chatId, {
                delete: {
                    remoteJid: chatId,
                    fromMe: false,
                    id: message.key.id,
                    participant: senderId
                }
            });
            console.log('[ANTIALL] Message deleted successfully');
        } catch (e) {
            console.error('[ANTIALL] Delete failed:', e.message);
        }
    } else {
        console.log('[ANTIALL] Bot is not admin, cannot delete');
    }

    const tag = `@${String(senderId || '').split('@')[0]}`;
    await sock.sendMessage(chatId, {
        text: `⚠️ ${tag} Only admins can mention everyone.`,
        mentions: [senderId]
    });

    return true;
}

module.exports = {
    name: 'antiall',
    alias: ['antieveryone'],
    async execute(ctx) {
        const { sock, chatId, message, senderId, args, isSenderAdmin: ctxIsSenderAdmin } = ctx;

        if (!chatId.endsWith('@g.us')) {
            return sock.sendMessage(chatId, { text: '❌ Group only.' }, { quoted: message });
        }

        // Check admin status with fallback
        let isSenderAdmin = Boolean(ctxIsSenderAdmin);
        if (!isSenderAdmin) {
            const freshAdminStatus = await isAdmin(sock, chatId, senderId);
            isSenderAdmin = Boolean(freshAdminStatus.isSenderAdmin);
        }

        // Also check sudo/mod
        const isSudoOrMod = await isOwnerOrSudo(senderId);

        if (!isSenderAdmin && !isSudoOrMod) {
            return sock.sendMessage(chatId, { text: '❌ Admins only.' }, { quoted: message });
        }

        const sub = (args[0] || '').toLowerCase();

        if (sub === 'on') {
            setAntiAll(chatId, true);
            return sock.sendMessage(chatId, { text: '✅ Anti-@all enabled. Non-admins cannot mention everyone.' }, { quoted: message });
        }
        if (sub === 'off') {
            setAntiAll(chatId, false);
            return sock.sendMessage(chatId, { text: '🔕 Anti-@all disabled.' }, { quoted: message });
        }

        const status = isAntiAllEnabled(chatId) ? 'enabled' : 'disabled';
        return sock.sendMessage(chatId, {
            text: `Anti-@all is currently *${status}*.\nUse *.antiall on* / *.antiall off*`
        }, { quoted: message });
    },
    handleAntiAll,
    isAntiAllEnabled
};
