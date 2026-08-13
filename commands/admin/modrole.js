const settings = require('../../settings');
const { addStaffRole, normalizeJid, removeStaffRole } = require('../../lib/staffRoles');

function extractTargetJid(message, rawText = '') {
    const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentioned.length > 0) return normalizeJid(mentioned[0]);

    const match = String(rawText).match(/\b(\d{7,20})\b/);
    if (match) return normalizeJid(match[1]);

    return '';
}

function isRealOwner(message, senderId) {
    const ownerNumber = String(settings.ownerNumber || '').trim();
    if (!ownerNumber) return false;
    if (message?.key?.fromMe) return true;

    const normalizedSender = normalizeJid(senderId);
    const ownerJid = normalizeJid(ownerNumber);
    if (!normalizedSender || !ownerJid) return false;
    if (normalizedSender === ownerJid) return true;

    const senderDigits = normalizedSender.split('@')[0].split(':')[0];
    return senderDigits === ownerNumber;
}

async function modRoleCommand(sock, chatId, message, senderId, rawText) {
    if (!isRealOwner(message, senderId)) {
        await sock.sendMessage(chatId, {
            text: 'Only the real owner can add or remove mods.'
        }, { quoted: message });
        return;
    }

    const parts = String(rawText || '').trim().split(/\s+/);
    const action = (parts[0] || '').toLowerCase();
    const roleWord = (parts[1] || '').toLowerCase();

    if (!['.add', '.del', '.remove'].includes(action) || roleWord !== 'mod') {
        await sock.sendMessage(chatId, {
            text: 'Usage:\n.add mod @user\n.del mod @user'
        }, { quoted: message });
        return;
    }

    const targetJid = extractTargetJid(message, rawText);
    if (!targetJid) {
        await sock.sendMessage(chatId, {
            text: 'Mention a user or give a number.'
        }, { quoted: message });
        return;
    }

    const ownerJid = normalizeJid(settings.ownerNumber);
    if (targetJid === ownerJid) {
        await sock.sendMessage(chatId, {
            text: 'Owner is already above mod.'
        }, { quoted: message });
        return;
    }

    if (action === '.add') {
        addStaffRole('mods', targetJid);
        await sock.sendMessage(chatId, {
            text: `Added mod: @${targetJid.split('@')[0]}`,
            mentions: [targetJid]
        }, { quoted: message });
        return;
    }

    const removed = removeStaffRole('mods', targetJid);
    await sock.sendMessage(chatId, {
        text: removed ? `Removed mod: @${targetJid.split('@')[0]}` : 'That user is not in mods.',
        mentions: [targetJid]
    }, { quoted: message });
}





module.exports = {
  name: 'modrole',
  permissionLevel: 'owner', // FIXED: central owner permission
  async execute(ctx) {
    return modRoleCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.rawText || null);
  }
};
