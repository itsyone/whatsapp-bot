const { hasAdminBypass } = require('../../lib/adminBypass');

async function resetlinkCommand(sock, chatId, senderId) {
    try {
        const bypass = await hasAdminBypass(null, senderId);
        const groupMetadata = await sock.groupMetadata(chatId);
        const adminIds = (groupMetadata.participants || [])
            .filter((participant) => participant.admin)
            .map((participant) => participant.id);

        const isAdmin = adminIds.includes(senderId);
        const botId = `${sock.user.id.split(':')[0]}@s.whatsapp.net`;
        const isBotAdmin = adminIds.includes(botId);

        if (!isAdmin && !bypass) {
            await sock.sendMessage(chatId, { text: 'Only admins can use this command.' });
            return;
        }

        if (!isBotAdmin) {
            await sock.sendMessage(chatId, { text: 'Bot must be admin to reset the group link.' });
            return;
        }

        const newCode = await sock.groupRevokeInvite(chatId);
        await sock.sendMessage(chatId, {
            text: `Group link reset.\n\nhttps://chat.whatsapp.com/${newCode}`
        });
    } catch (error) {
        console.error('Error in resetlink command:', error);
        await sock.sendMessage(chatId, { text: 'Failed to reset group link.' });
    }
}





module.exports = {
  name: 'resetlink',
  async execute(ctx) {
    return resetlinkCommand(ctx.sock || null, ctx.chatId || null, ctx.senderId || null);
  }
};
