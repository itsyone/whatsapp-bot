const isAdmin = require('../../lib/isAdmin');
const { readMuteState, writeMuteState } = require('./mute');
const { hasAdminBypass } = require('../../lib/adminBypass');

function getContextInfo(message) {
    return (
        message?.message?.extendedTextMessage?.contextInfo ||
        message?.message?.imageMessage?.contextInfo ||
        message?.message?.videoMessage?.contextInfo ||
        {}
    );
}

function normalizeJid(jid = '') {
    return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '').trim();
}

function digitsOnly(jid = '') {
    return String(jid || '').replace(/\D/g, '');
}

function toMentionJid(jid = '') {
    const raw = String(jid || '').trim();
    if (!raw) return '';
    if (raw.includes('@')) return raw;
    return `${normalizeJid(raw)}@s.whatsapp.net`;
}

function mentionLabel(jid = '') {
    const raw = String(jid || '');
    return `@${normalizeJid(raw) || 'user'}`;
}


function parseTarget(message) {
    const ctx = getContextInfo(message);
    const mentioned = Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid : [];
    const target = mentioned[0] || ctx.participant || '';
    return {
        targetJid: normalizeJid(target),
        mentionJid: toMentionJid(target)
    };
}

async function unmuteCommand(sock, chatId, senderId, message) {
    if (!chatId.endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: 'This command only works in groups.' }, { quoted: message });
        return;
    }

    const bypass = await hasAdminBypass(message, senderId);
    const { isSenderAdmin } = await isAdmin(sock, chatId, senderId);
    if (!isSenderAdmin && !bypass) {
        await sock.sendMessage(chatId, { text: 'Only group admins can use `.unmute`.' }, { quoted: message });
        return;
    }

    const { targetJid, mentionJid } = parseTarget(message);
    if (!targetJid) {
        await sock.sendMessage(chatId, { text: 'Mention or reply to a muted user.\nExample: `.unmute @user`' }, { quoted: message });
        return;
    }

    const state = readMuteState();
    const groupMutes = state.groups?.[chatId] || {};
    const targetDigits = digitsOnly(targetJid);
    // Find actual stored key by flex match (digits only comparison)
    const storedKey = Object.keys(groupMutes).find(k => digitsOnly(k) === targetDigits);
    
    console.log(`[UNMUTE] chatId=${chatId}, targetJid=${targetJid}, targetDigits=${targetDigits}`);
    console.log(`[UNMUTE] stored keys=${JSON.stringify(Object.keys(groupMutes))}, found=${storedKey}`);
    
    if (!storedKey) {
        await sock.sendMessage(chatId, { text: 'That user is not muted in this group.' }, { quoted: message });
        return;
    }

    delete state.groups[chatId][storedKey];
    writeMuteState(state);

    await sock.sendMessage(chatId, {
        text: `Unmuted ${mentionLabel(mentionJid || targetJid)}.`,
        mentions: [mentionJid || `${targetJid}@s.whatsapp.net`]
    }, { quoted: message });
}





module.exports = {
  name: 'unmute',
  permissionLevel: 'admin', // FIXED: central admin permission
  async execute(ctx) {
    return unmuteCommand(ctx.sock || null, ctx.chatId || null, ctx.senderId || null, ctx.message || null);
  }
};
