const { clearAllTempBans } = require('../../lib/tempBan');
const isOwnerOrSudo = require('../../lib/isOwner');

/**
 * ClearBans Command
 * Removes all temporary bans from all users.
 * Logic: Resets the tempBans.json store to empty.
 */

async function clearBansCommand(sock, chatId, message, senderId) {
    try {
        const isSudo = await isOwnerOrSudo(senderId);
        if (!isSudo) {
            return await sock.sendMessage(chatId, { text: 'Only the bot owner or sudo users can use this command.' }, { quoted: message });
        }

        clearAllTempBans();
        
        await sock.sendMessage(chatId, { 
            text: '✅ All temporary bans have been cleared. Every user can now use commands again!' 
        }, { quoted: message });

    } catch (error) {
        console.error('Error in clearbans command:', error);
        await sock.sendMessage(chatId, { text: 'Failed to clear temporary bans.' }, { quoted: message });
    }
}

module.exports = {
    name: 'clearbans',
    alias: ['unbanall', 'resetbans'],
    permissionLevel: 'sudo', // FIXED: central sudo permission
    async execute({ sock, chatId, message, senderId }) {
        await clearBansCommand(sock, chatId, message, senderId);
    }
};
