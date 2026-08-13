const { getProposalByUser, normalizeJid } = require('../../lib/marriageStore');
const { rejectMarriageCommand } = require('../social/marriage');

async function rejectCommand(sock, chatId, message, senderId, isGroup) {
    // 1. Check for marriage proposal
    const proposal = await getProposalByUser(senderId);
    const normalizedSender = normalizeJid(senderId);
    if (proposal && proposal.to === normalizedSender) {
        return await rejectMarriageCommand(sock, chatId, message, senderId, isGroup);
    }

    // 2. No pending actions
    await sock.sendMessage(chatId, { 
        text: '❌ You have no pending requests to reject.' 
    }, { quoted: message });
}

module.exports = {
    name: 'reject',
    execute: rejectCommand
};
