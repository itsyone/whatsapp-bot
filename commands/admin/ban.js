const fs = require('fs');
const isAdmin = require('../../lib/isAdmin');
const { isSudo } = require('../../lib/index');
const isOwnerOrSudo = require('../../lib/isOwner');
const { hasStaffRole } = require('../../lib/staffRoles');

async function banCommand(sock, chatId, message) {
    const isGroup = chatId.endsWith('@g.us');
    const senderId = message.key.participant || message.key.remoteJid;
    const senderCanBan = Boolean(
        message?.key?.fromMe ||
        hasStaffRole(senderId, ['mods']) ||
        await isOwnerOrSudo(senderId).catch(() => false)
    );

    if (isGroup) {
        const { isBotAdmin } = await isAdmin(sock, chatId, senderId);
        if (!isBotAdmin) {
            return sock.sendMessage(chatId, { text: 'Please make the bot an admin first.' }, { quoted: message });
        }
        if (!senderCanBan) {
            return sock.sendMessage(chatId, { text: 'Only owner or mods can use .ban.' }, { quoted: message });
        }
    } else {
        const senderIsSudo = await isSudo(senderId);
        if (!message.key.fromMe && !senderIsSudo && !hasStaffRole(senderId, ['mods'])) {
            return sock.sendMessage(chatId, { text: 'Only owner or mods can use .ban in private chat.' }, { quoted: message });
        }
    }

    const userToBan =
        message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
        message.message?.extendedTextMessage?.contextInfo?.participant ||
        null;

    if (!userToBan) {
        return sock.sendMessage(chatId, { text: 'Please mention a user or reply to their message.' }, { quoted: message });
    }

    try {
        const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        if (userToBan === botId || userToBan === botId.replace('@s.whatsapp.net', '@lid')) {
            return sock.sendMessage(chatId, { text: 'You cannot ban the bot.' }, { quoted: message });
        }
    } catch {}

    try {
        const bannedUsers = JSON.parse(fs.readFileSync('./data/banned.json'));

        if (bannedUsers.includes(userToBan)) {
            return sock.sendMessage(chatId, {
                text: `@${userToBan.split('@')[0]} is already banned.`,
                mentions: [userToBan]
            }, { quoted: message });
        }

        bannedUsers.push(userToBan);
        fs.writeFileSync('./data/banned.json', JSON.stringify(bannedUsers, null, 2));

        await sock.sendMessage(chatId, {
            text: `Banned @${userToBan.split('@')[0]}.`,
            mentions: [userToBan]
        }, { quoted: message });
    } catch (error) {
        console.error('Error in ban command:', error);
        await sock.sendMessage(chatId, { text: 'Failed to ban user.' }, { quoted: message });
    }
}





module.exports = {
  name: 'ban',
  permissionLevel: 'sudo', // FIXED: central sudo permission
  async execute(ctx) {
    return banCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
