const { getProposalByUser, normalizeJid } = require('../../lib/marriageStore');
const { acceptMarriageCommand } = require('../social/marriage');
const { getPendingForAccepter, loadState, acceptBetCommand } = require('../economy/bet');

async function acceptCommand(sock, chatId, message, senderId, isGroup) {
    // 1. Check for marriage proposal
    const proposal = await getProposalByUser(senderId);
    const normalizedSender = normalizeJid(senderId);
    if (proposal && proposal.to === normalizedSender) {
        return await acceptMarriageCommand(sock, chatId, message, senderId, isGroup);
    }

    // 2. Check for bet duel
    const betState = loadState();
    const duel = getPendingForAccepter(betState, chatId, senderId);
    if (duel) {
        return await acceptBetCommand(sock, chatId, message, senderId);
    }

    // 3. No pending actions
    await sock.sendMessage(chatId, { 
        text: '❌ You have no pending marriage proposals or bet duels to accept.' 
    }, { quoted: message });
}

module.exports = {
    name: 'accept',
    execute: acceptCommand
};
