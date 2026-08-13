const isOwnerOrSudo = require('../../lib/isOwner');
const { hasStaffRole } = require('../../lib/staffRoles');

function extractInviteLink(text = '') {
    const match = String(text || '').match(/https?:\/\/chat\.whatsapp\.com\/([A-Za-z0-9]+)/i);
    return match ? match[1] : '';
}

async function joinCommand(sock, chatId, message, senderId, rawText) {
    const inviteCode = extractInviteLink(rawText);

    if (!inviteCode) {
        // If no link, we might be here from a failed game join or just bad usage
        await sock.sendMessage(chatId, {
            text: 'ℹ️ No active game to join. Use `.join <whatsapp link>` to join a group.'
        }, { quoted: message });
        return false; 
    }

    // Permission check: Mods or Sudo/Owner only
    const senderIsSudo = await isOwnerOrSudo(senderId);
    const senderIsMod = hasStaffRole(senderId, ['mods']);

    if (!senderIsSudo && !senderIsMod) {
        await sock.sendMessage(chatId, {
            text: '❌ Only *Mods* can use the join command for groups.'
        }, { quoted: message });
        return true;
    }

    try {
        const joined = await sock.groupAcceptInvite(inviteCode);
        await sock.sendMessage(chatId, {
            text: joined
                ? `✅ Joined group successfully.\nID: ${joined}`
                : '✅ Joined group successfully.'
        }, { quoted: message });
        return true;
    } catch (error) {
        console.error('[join] error:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: '❌ Failed to join the group. The link might be expired or the bot might be banned.'
        }, { quoted: message });
        return true;
    }
}

module.exports = {
    name: 'join',
    async execute({ sock, chatId, message, senderId, rawText }) {
        return joinCommand(sock, chatId, message, senderId, rawText);
    },
    joinCommand // Export for direct use in main.js
};
