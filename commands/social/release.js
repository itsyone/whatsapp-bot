const { removeUserCard } = require('../../lib/cardClaimStore');

async function releaseCommand(sock, chatId, message, userMessage = '') {
    try {
        const senderId = message?.key?.participant || message?.key?.remoteJid || '';
        const query = String(userMessage || '').trim().split(/\s+/).slice(1).join(' ');
        const res = removeUserCard(senderId, query);

        if (!res.ok) {
            await sock.sendMessage(chatId, {
                text: 'No card found to release. Use `.release <cardNo|name|claimId>` or just `.release`.'
            }, { quoted: message });
            return;
        }

        const c = res.card || {};
        await sock.sendMessage(chatId, {
            text:
`🗑️ *Released*

🎴 *${c.cardName || 'Unknown'}*  
🆔 *${c.cardNo || 'N/A'}*

Removed from inventory!`
        }, { quoted: message });
    } catch (error) {
        console.error('Error in release command:', error);
        await sock.sendMessage(chatId, { text: 'Release failed.' }, { quoted: message });
    }
}





module.exports = {
  name: 'release',
  async execute(ctx) {
    return releaseCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.userMessage || null);
  }
};
