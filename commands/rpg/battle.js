const fs = require('fs');
const path = require('path');
const { getRandomUserCard } = require('../../lib/cardClaimStore');
const { addBalance } = require('../../lib/economy');

const DATA_FILE = path.join(__dirname, '..', 'data', 'monsters_final.json');

const tierEmoji = {
    Common: '⚪',
    Rare: '🔵',
    Epic: '🟣',
    Legendary: '🌟',
    Mythic: '🔥'
};

function delay(ms) {
    return new Promise((res) => setTimeout(res, ms));
}

function pickMove(type = '') {
    const t = String(type || '').toUpperCase();
    const map = {
        POW: ['Claw Strike', 'Crush', 'Heavy Slam'],
        INT: ['Mind Pulse', 'Arc Wave', 'Focus Beam'],
        DGE: ['Slip Dash', 'Phantom Step', 'Quick Drift'],
        BLK: ['Iron Guard', 'Shield Press', 'Counter Wall'],
        SPE: ['Flame Bite', 'Final Burst', 'Chaos Edge'],
        ENV: ['Gust', 'Storm Shift', 'Sky Break']
    };
    const arr = map[t] || ['Strike', 'Crash', 'Burst'];
    return arr[Math.floor(Math.random() * arr.length)];
}

function damageRangeByTier(tier = 'Common') {
    const ranges = {
        Common: [8, 14],
        Rare: [12, 18],
        Epic: [16, 24],
        Legendary: [22, 32],
        Mythic: [28, 40]
    };
    return ranges[tier] || [8, 14];
}

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseOpponent(message) {
    const ctx = message?.message?.extendedTextMessage?.contextInfo || {};
    const mentioned = Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid.filter(Boolean) : [];
    if (mentioned.length) return mentioned[0];
    if (ctx.participant) return String(ctx.participant);
    return '';
}

function randomBotMonster() {
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const monsters = Array.isArray(data?.monsters) ? data.monsters : [];
        if (!monsters.length) return null;
        const m = monsters[Math.floor(Math.random() * monsters.length)];
        return {
            cardName: m.breed || 'Monster',
            tier: m.tier || 'Common',
            moveType: 'SPE'
        };
    } catch {
        return null;
    }
}

async function battleCommand(sock, chatId, message, senderId) {
    try {
        const p1 = getRandomUserCard(senderId);
        if (!p1) {
            await sock.sendMessage(chatId, {
                text: 'You need at least one captured card to battle. Claim cards from event drops first.'
            }, { quoted: message });
            return;
        }

        const opponentJid = parseOpponent(message);
        const p2 = opponentJid ? (getRandomUserCard(opponentJid) || randomBotMonster()) : randomBotMonster();
        if (!p2) {
            await sock.sendMessage(chatId, { text: 'No opponent card available.' }, { quoted: message });
            return;
        }

        const p1Name = p1.cardName || 'Unknown';
        const p2Name = p2.cardName || 'Unknown';
        const p1Tier = p1.tier || 'Common';
        const p2Tier = p2.tier || 'Common';
        const p1Emoji = tierEmoji[p1Tier] || '⚪';
        const p2Emoji = tierEmoji[p2Tier] || '⚪';

        let opponentName = 'Opponent';
        if (opponentJid) {
            try {
                opponentName = await sock.getName(opponentJid) || opponentJid.split('@')[0];
            } catch {
                opponentName = opponentJid.split('@')[0];
            }
        }

        await sock.sendMessage(chatId, {
            text:
`⚔️ *Battle*

You sent out *${p1Name}* (${p1Emoji})
${opponentName} sent out *${p2Name}* (${p2Emoji})`
        }, { quoted: message });

        await delay(2000);

        const [aMin, aMax] = damageRangeByTier(p1Tier);
        const [bMin, bMax] = damageRangeByTier(p2Tier);
        const dmg1 = randomBetween(aMin, aMax);
        const dmg2 = randomBetween(bMin, bMax);
        const move1 = pickMove(p1.moveType);
        const move2 = pickMove(p2.moveType);

        await sock.sendMessage(chatId, {
            text:
`${p1Name} used *${move1}*  
💨 ${p2Name} took *${dmg1}* damage

${p2Name} used *${move2}*  
🔥 ${p1Name} took *${dmg2}* damage`
        }, { quoted: message });

        await delay(2000);

        const p1Hp = 50 - dmg2;
        const p2Hp = 50 - dmg1;
        const p1Wins = p1Hp >= p2Hp;
        const winnerName = p1Wins ? 'You' : opponentName;
        const loserCard = p1Wins ? p2Name : p1Name;
        const reward = randomBetween(150, 260);

        if (p1Wins) {
            addBalance(senderId, reward);
        } else if (opponentJid) {
            addBalance(opponentJid, reward);
        }

        await sock.sendMessage(chatId, {
            text:
`*${loserCard} fainted*

Winner: *${winnerName}*  
₳ *+${reward}*`
        }, { quoted: message });
    } catch (error) {
        console.error('Error in battle command:', error);
        await sock.sendMessage(chatId, { text: 'Battle failed.' }, { quoted: message });
    }
}





module.exports = {
  name: 'battle',
  async execute(ctx) {
    return battleCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null);
  }
};
