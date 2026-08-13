const fs = require('fs');
const isAdmin = require('../../lib/isAdmin');
const { isSudo } = require('../../lib/index');
const isOwnerOrSudo = require('../../lib/isOwner');
const { hasStaffRole } = require('../../lib/staffRoles');

async function unbanCommand(sock, chatId, message) {
    const isGroup = chatId.endsWith('@g.us');
    const senderId = message.key.participant || message.key.remoteJid;
    const senderCanUnban = Boolean(
        message?.key?.fromMe ||
        hasStaffRole(senderId, ['mods']) ||
        await isOwnerOrSudo(senderId).catch(() => false)
    );
    if (isGroup) {
        const { isSenderAdmin, isBotAdmin } = await isAdmin(sock, chatId, senderId);
        if (!isBotAdmin) {
            await sock.sendMessage(chatId, { text: 'Please make the bot an admin first.' }, { quoted: message });
            return;
        }
        if (!isSenderAdmin && !senderCanUnban) {
            await sock.sendMessage(chatId, { text: 'Only group admins can use .unban.' }, { quoted: message });
            return;
        }
    } else {
        const senderIsSudo = await isSudo(senderId);
        if (!message.key.fromMe && !senderIsSudo && !hasStaffRole(senderId, ['mods'])) {
            await sock.sendMessage(chatId, { text: 'Only owner or mods can use .unban in private chat.' }, { quoted: message });
            return;
        }
    }

    const userToUnban =
        message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
        message.message?.extendedTextMessage?.contextInfo?.participant ||
        null;

    if (!userToUnban) {
        await sock.sendMessage(chatId, {
            text: 'Please mention a user or reply to their message.'
        }, { quoted: message });
        return;
    }

    try {
        const bannedUsers = JSON.parse(fs.readFileSync('./data/banned.json'));
        const index = bannedUsers.indexOf(userToUnban);
        if (index > -1) {
            bannedUsers.splice(index, 1);
            fs.writeFileSync('./data/banned.json', JSON.stringify(bannedUsers, null, 2));
            await sock.sendMessage(chatId, {
                text: `Unbanned @${userToUnban.split('@')[0]}.`,
                mentions: [userToUnban]
            }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, {
            text: `@${userToUnban.split('@')[0]} is not banned.`,
            mentions: [userToUnban]
        }, { quoted: message });
    } catch (error) {
        console.error('Error in unban command:', error);
        await sock.sendMessage(chatId, { text: 'Failed to unban user.' }, { quoted: message });
    }
}





module.exports = {
  name: 'unban',
  permissionLevel: 'sudo', // FIXED: central sudo permission
  async execute(ctx) {
    return unbanCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
