async function hideCommand(sock, chatId, message, args) {
    await sock.sendMessage(chatId, { text: 'Hide command has been removed.' }, { quoted: message });
}

function isHideEnabled() {
    return false;
}

function getOwnerJid() {
    const settings = require('../../settings');
    return settings.ownerNumber + '@s.whatsapp.net';
}

// Helper to wrap sock.sendMessage to check hide mode
function wrapSockForHide(sock, currentMessage) {
    return sock;
}

module.exports = { hideCommand, isHideEnabled, getOwnerJid, wrapSockForHide };
