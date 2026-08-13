const { removeUserCard } = require('../../lib/cardClaimStore');
const { addBalanceAtomic } = require('../../lib/economy');
const { getRegisteredProfile, consumeInventoryItem } = require('../../lib/registrationStore');
const { getItemInfo, parseSellTarget } = require('../../lib/gathering');

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

function randomHuntSellValue() {
    return Math.floor(Math.random() * 901) + 100;
}

async function sellCommand(sock, chatId, message, userMessage = '') {
    try {
        const senderId = message?.key?.participant || message?.key?.participantAlt || message?.key?.remoteJid || '';
        const resourceProfile = getRegisteredProfile(senderId);
        const { itemKey, amount } = parseSellTarget(userMessage);
        const wantsAll = /\ball\b/i.test(String(userMessage || ''));

        if (resourceProfile && itemKey) {
            const itemInfo = getItemInfo(itemKey);
            const owned = Math.max(0, Number(resourceProfile.inventory?.[itemKey] || 0));
            const finalAmount = wantsAll ? owned : amount;

            if (finalAmount <= 0) {
                await sock.sendMessage(chatId, {
                    text: `You do not have any ${itemInfo.label.toLowerCase()} to sell.`
                }, { quoted: message });
                return;
            }

            if (owned < finalAmount) {
                await sock.sendMessage(chatId, {
                    text: `You do not have enough ${itemInfo.label.toLowerCase()}.\n> Owned: ${owned}`
                }, { quoted: message });
                return;
            }

            const consumed = consumeInventoryItem(senderId, itemKey, finalAmount);
            if (!consumed?.ok) {
                await sock.sendMessage(chatId, { text: 'Sell failed.' }, { quoted: message });
                return;
            }

            const earned = ['meat', 'hide'].includes(itemKey)
                ? Array.from({ length: finalAmount }).reduce((sum) => sum + randomHuntSellValue(), 0)
                : Math.max(0, Number(itemInfo.sellPrice || 0) * finalAmount);
            await addBalanceAtomic(senderId, earned, {
                awardXp: false,
                force: true,
                source: 'sell_inventory',
                category: 'economy',
                actorJid: senderId
            });

            await sock.sendMessage(chatId, {
                text: `💰 Selling...\n> You sold: ${itemInfo.label} ${itemInfo.emoji} x${finalAmount}\n> Earned: +¥${earned.toLocaleString()} 💴`
            }, { quoted: message });
            return;
        }

        const query = String(userMessage || '').trim().split(/\s+/).slice(1).join(' ');
        const res = removeUserCard(senderId, query);

        if (!res.ok) {
            await sock.sendMessage(chatId, {
                text: 'No card found to sell. Use `.sell <cardNo|name|claimId>` or `.sell meat all`.'
            }, { quoted: message });
            return;
        }

        const c = res.card || {};
        const value = Number(c.value || 0) || 0;
        await addBalanceAtomic(senderId, value, {
            force: true,
            source: 'sell_card',
            category: 'economy',
            actorJid: senderId
        });

        const t = c.tier || 'Common';
        const tIcon = tierEmoji[t] || '⚪';
        await sock.sendMessage(chatId, {
            text:
`💰 *Sold*

🎴 *${c.cardName || 'Unknown'}*
${tIcon} *${t}* • ${typeBadge(c.moveType)}

₳ *+${value}*

Balance updated`
        }, { quoted: message });
    } catch (error) {
        console.error('Error in sell command:', error);
        await sock.sendMessage(chatId, { text: 'Sell failed.' }, { quoted: message });
    }
}





module.exports = {
  name: 'sell',
  async execute(ctx) {
    return sellCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.userMessage || null);
  }
};
