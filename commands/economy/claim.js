const { claimCard } = require('../../lib/cardClaimStore');
const { claimGroupDrop, buildRevealText, getOpenedRewardImage, buildDropCard } = require('../../lib/dropSystem');

const tierEmoji = {
    Common: '⚪',
    Rare: '🔵',
    Epic: '🟣',
    Legendary: '🌟',
    Mythic: '🔥'
};

function typeBadge(moveType) {
    const t = String(moveType || '').toUpperCase();
    if (t === 'ENV') return '🌪 Air';
    if (t === 'POW') return '⚔️ Power';
    if (t === 'INT') return '🧠 Intelligence';
    if (t === 'DGE') return '💨 Dodge';
    if (t === 'BLK') return '🛡 Block';
    if (t === 'SPE') return '✨ Special';
    return '🌀 Unknown';
}

async function claimCommand(sock, chatId, message, userMessage = '') {
    try {
        const parts = String(userMessage || '').trim().split(/\s+/);
        const claimId = parts[1] ? parts[1].toLowerCase() : '';
        const senderId = message?.key?.participant || message?.key?.remoteJid || '';

        if (!claimId) {
            if (!String(chatId || '').endsWith('@g.us')) {
                await sock.sendMessage(chatId, {
                    text: 'Use: .claim <id>\nExample: .claim 03f77'
                }, { quoted: message });
                return;
            }

            const result = claimGroupDrop(chatId, senderId);
            if (!result.ok) {
                const text = result.reason === 'claimed'
                    ? '❌ *MISSED DROP*\n\n> already claimed'
                    : result.reason === 'expired'
                        ? '❌ *MISSED DROP*\n\n> drop expired after 6 minutes'
                        : '❌ *MISSED DROP*\n\n> no active drop right now';
                await sock.sendMessage(chatId, { text }, { quoted: message });
                return;
            }

            const text = buildRevealText(result, senderId);
            const thumb = await getOpenedRewardImage(result.rarity);
            const payload = buildDropCard(text, thumb, result.rarity);
            await sock.sendMessage(chatId, payload, { quoted: message });
            return;
        }

        const result = claimCard(claimId, senderId);
        if (!result.ok) {
            await sock.sendMessage(chatId, {
                text: 'Claim ID not found or already claimed.'
            }, { quoted: message });
            return;
        }

        const c = result.card || {};
        const t = c.tier || 'Common';
        const tIcon = tierEmoji[t] || '⚪';

        await sock.sendMessage(chatId, {
            text:
`🎯 *Captured*

🎴 *${c.cardName || 'Unknown'}*  
${tIcon} *${t}* • ${typeBadge(c.moveType)}

🆔 *${c.cardNo || 'N/A'}*  
₳ *+${c.value || 'N/A'}*

Added to inventory`
        }, { quoted: message });
    } catch (error) {
        console.error('Error in claim command:', error);
        await sock.sendMessage(chatId, { text: 'Claim failed.' }, { quoted: message });
    }
}





module.exports = {
  name: 'claim',
  async execute(ctx) {
    return claimCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.userMessage || null);
  }
};
