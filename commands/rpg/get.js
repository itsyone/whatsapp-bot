const { claimCard } = require('../../lib/cardClaimStore');

const rarityEmoji = {
    'C': '⚪',
    'R': '⭐',
    'SR': '🌟',
    'SSR': '💎',
    'UR': '🔥',
    'EX': '👑'
};

const rarityNames = {
    'C': 'Common',
    'R': 'Rare',
    'SR': 'Super Rare',
    'SSR': 'Specially Super Rare',
    'UR': 'Ultra Rare',
    'EX': 'Exclusive'
};

async function getCommand(sock, chatId, message, userMessage = '') {
    try {
        const parts = String(userMessage || '').trim().split(/\s+/);
        // Supports both .get <id> and .get (if quoted or single word)
        let claimId = parts[1] ? parts[1].replace('#', '').trim().toLowerCase() : '';
        const senderId = message?.key?.participant || message?.key?.remoteJid || '';

        if (!claimId) {
            await sock.sendMessage(chatId, {
                text: '❌ *Invalid Claim*\n\n> Please specify the ID.\nExample: `.get A91K`'
            }, { quoted: message });
            return;
        }

        const result = claimCard(claimId, senderId);
        if (!result.ok) {
            await sock.sendMessage(chatId, {
                text: '❌ *Claim Failed*\n\n> ID not found or already claimed.'
            }, { quoted: message });
            return;
        }

        const card = result.card || {};
        const rarity = card.tier || 'C';
        const rarityIcon = rarityEmoji[rarity] || '⚪';
        const rarityName = rarityNames[rarity] || 'Common';

        const text = `*🎉 You claimed a card!*
*🆔 ID:* \`#${claimId.toUpperCase()}\`  
*👤 Name:* \`${card.name}\`  
*🌐 Series:* \`${card.series || 'Unknown'}\`
*${rarityIcon} Rarity:* \`${rarityName}\`  

> *📦 Added to your collection!*`;

        await sock.sendMessage(chatId, { 
            text
        }, { quoted: message });


    } catch (error) {
        console.error('Error in get command:', error);
        await sock.sendMessage(chatId, { text: '❌ An error occurred while claiming the card.' }, { quoted: message });
    }
}

module.exports = {
    name: 'get',
    async execute(ctx) {
        return getCommand(sock = ctx.sock, chatId = ctx.chatId, message = ctx.message, userMessage = ctx.userMessage);
    }
};
