const { PERMISSION_LEVELS, addOwner, isOwner, loadPermissions } = require('../../lib/permissionMiddleware');

/**
 * Add a user to the owner list
 */
async function addownerCommand(sock, chatId, message, args) {
    const senderId = message?.key?.participant || message?.key?.remoteJid;
    
    // Only existing owners can add new owners
    const isSenderOwner = isOwner(senderId);
    if (!isSenderOwner) {
        await sock.sendMessage(chatId, { text: '❌ Only existing owners can add new owners.' }, { quoted: message });
        return;
    }

    const targetJid = args?.trim();
    if (!targetJid) {
        await sock.sendMessage(chatId, { text: 'Usage: .addowner <jid or phone number>\nExample: .addowner 584164385530 or .addowner 584164385530@s.whatsapp.net' }, { quoted: message });
        return;
    }

    const added = addOwner(targetJid);
    if (added) {
        await sock.sendMessage(chatId, { text: `✅ Added ${targetJid} to owner list.` }, { quoted: message });
    } else {
        await sock.sendMessage(chatId, { text: `❌ ${targetJid} is already an owner or invalid.` }, { quoted: message });
    }
}

module.exports = {
    addownerCommand,
    permission: PERMISSION_LEVELS.OWNER // Only owners can add owners
};
