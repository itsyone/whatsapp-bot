const isAdmin = require('../../lib/isAdmin');
const { hasAdminBypass } = require('../../lib/adminBypass');

async function tagAllCommand(sock, chatId, senderId, message) {
    try {
        await sock.sendMessage(chatId, {
            react: {
                text: '📢',
                key: message.key
            }
        });

        const bypass = await hasAdminBypass(message, senderId);
        const { isSenderAdmin, isBotAdmin } = await isAdmin(sock, chatId, senderId);

        if (!isBotAdmin) {
            await sock.sendMessage(chatId, { 
                text: 'Error: Make bot admin first'
            }, { quoted: message });
            return;
        }

        if (!isSenderAdmin && !bypass) {
            await sock.sendMessage(chatId, { 
                text: 'Error: Only admins can use this'
            }, { quoted: message });
            return;
        }

        const groupMetadata = await sock.groupMetadata(chatId);
        const participants = groupMetadata.participants;

        if (!participants || participants.length === 0) {
            await sock.sendMessage(chatId, { 
                text: 'Error: No participants found'
            });
            return;
        }

        let messageText = '';
        participants.forEach((participant) => {
            const number = participant.id.split('@')[0];
            messageText += `@${number}\n`;
        });

        await sock.sendMessage(chatId, {
            text: messageText,
            mentions: participants.map(p => p.id)
        });

    } catch (error) {
        console.error('Error in tagall command:', error);
        await sock.sendMessage(chatId, { 
            text: 'Error: Failed to tag members'
        });
    }
}





module.exports = {
  name: 'tagall',
  permissionLevel: 'admin', // FIXED: central admin permission
  async execute(ctx) {
    return tagAllCommand(ctx.sock || null, ctx.chatId || null, ctx.senderId || null, ctx.message || null);
  }
};
