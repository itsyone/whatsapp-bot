const isAdmin = require('../../lib/isAdmin');

async function tagNotAdminCommand(sock, chatId, senderId, message) {
    try {
        const { isBotAdmin } = await isAdmin(sock, chatId, senderId);

        if (!isBotAdmin) {
            await sock.sendMessage(chatId, { text: 'Please make the bot an admin first.' }, { quoted: message });
            return;
        }

        const groupMetadata = await sock.groupMetadata(chatId);
        const participants = groupMetadata.participants || [];

        const nonAdmins = participants.filter(p => !p.admin).map(p => p.id);
        if (nonAdmins.length === 0) {
            await sock.sendMessage(chatId, { text: 'No non-admin members to tag.' }, { quoted: message });
            return;
        }

        let text = '🔊 *Hello Everyone:*\n\n';
        nonAdmins.forEach(jid => {
            text += `@${jid.split('@')[0]}\n`;
        });

        await sock.sendMessage(chatId, { text, mentions: nonAdmins }, { quoted: message });
    } catch (error) {
        console.error('Error in tagnotadmin command:', error);
        await sock.sendMessage(chatId, { text: 'Failed to tag non-admin members.' }, { quoted: message });
    }
}







module.exports = {
  name: 'tagnotadmin',
  permissionLevel: 'admin', // FIXED: central admin permission
  async execute(ctx) {
    return tagNotAdminCommand(ctx.sock || null, ctx.chatId || null, ctx.senderId || null, ctx.message || null);
  }
};
