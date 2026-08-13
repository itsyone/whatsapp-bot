const { getTopBalances } = require('../../lib/economy');
const { getRegisteredProfile, countInventorySlotsUsed, resolveRegisteredJid } = require('../../lib/registrationStore');

function pickRankLabel(level, totalXpEarned) {
    const safeLevel = Math.max(0, Number(level || 0));
    const safeTotalXp = Math.max(0, Number(totalXpEarned || 0));
    const score = (safeLevel * 1000) + safeTotalXp;
    if (score >= 32000) return 'Challenger';
    if (score >= 24000) return 'Grandmaster';
    if (score >= 17000) return 'Master';
    if (score >= 11000) return 'Diamond';
    if (score >= 7000) return 'Platinum';
    if (score >= 4000) return 'Gold';
    if (score >= 1800) return 'Silver';
    if (score >= 600) return 'Bronze';
    return 'Iron';
}

function pickLootGrade(rankLabel = 'Iron') {
    const key = String(rankLabel || '').toLowerCase();
    if (key === 'challenger') return 'SSR';
    if (key === 'grandmaster' || key === 'master') return 'SR';
    if (key === 'diamond') return 'S';
    if (key === 'platinum' || key === 'gold') return 'A';
    return 'R';
}

function mentionTag(jid) {
    const id = String(jid || '').split('@')[0].split(':')[0];
    return `@${id}`;
}

function isValidJid(jid) {
    const value = String(jid || '').trim();
    return value.includes('@') && value.length > 3;
}

function getDisplayLabel(jid, fallback = '@user') {
    if (isValidJid(jid)) return mentionTag(jid);
    const raw = String(jid || '').trim();
    if (raw) return `@${raw.split('@')[0].split(':')[0]}`;
    return fallback;
}

function getMentionJid(jid) {
    const canonical = resolveRegisteredJid([jid]);
    if (canonical) return canonical;
    return String(jid || '').trim(); // FIXED: prefer canonical registered JID for leaderboard mentions
}

async function topCommand(sock, chatId, message, senderId) {
    try {
        const allRows = getTopBalances(1000).filter((row) => {
            if (!isValidJid(row.jid)) return false;
            const profile = getRegisteredProfile(row.jid);
            return Boolean(profile);
        });
        const top = allRows.slice(0, 5);
        const yourIndex = allRows.findIndex((row) => row.jid === senderId);
        const lines = ['🏆 *Top Players* 🏆', ''];
        const mentions = [];

        let index = 1;
        for (const row of top) {
            const mentionJid = getMentionJid(row.jid);
            const profile = getRegisteredProfile(mentionJid || row.jid);
            const inventoryCount = countInventorySlotsUsed(profile?.inventory || {});
            const rankLabel = pickRankLabel(profile?.level || 0, profile?.totalXpEarned || 0);
            const grade = pickLootGrade(rankLabel);
            const label = getDisplayLabel(mentionJid || row.jid, `@user${index}`);

            lines.push(`${index}. ${label}`);
            lines.push(`> 💰 ¥${row.balance.toLocaleString()}`);
            lines.push(`> 👜 ${inventoryCount} items [${grade}]`);
            lines.push(`> ⚡ Level ${Math.max(0, Number(profile?.level || 0))}`);
            lines.push(`> 🛡 Rank: ${rankLabel}`);
            lines.push('');
            mentions.push(mentionJid || row.jid);
            index += 1;
        }

        if (lines[lines.length - 1] === '') lines.pop();

        const yourProfile = getRegisteredProfile(senderId);
        if (yourIndex >= 0 && (!top.some((row) => row.jid === senderId))) {
            const yourRankLabel = pickRankLabel(yourProfile?.level || 0, yourProfile?.totalXpEarned || 0);
            const yourGrade = pickLootGrade(yourRankLabel);
            lines.push('');
            lines.push(`You: ${getDisplayLabel(senderId)} • #${yourIndex + 1}`);
            lines.push(`> 💰 ¥${(allRows[yourIndex]?.balance || 0).toLocaleString()}`);
            lines.push(`> 👜 ${countInventorySlotsUsed(yourProfile?.inventory || {})} items [${yourGrade}]`);
            lines.push(`> ⚡ Level ${Math.max(0, Number(yourProfile?.level || 0))}`);
            lines.push(`> 🛡 Rank: ${yourRankLabel}`);
            mentions.push(getMentionJid(senderId) || senderId);
        }

        const text = lines.join('\n');
        const uniqueMentions = [...new Set(mentions)];

        try {
            await sock.sendMessage(chatId, {
                text,
                mentions: uniqueMentions
            }, { quoted: message });
            return;
        } catch (sendError) {
            console.error('[top] mention send failed, retrying plain text:', sendError?.message || sendError);
        }

        await sock.sendMessage(chatId, { text }, { quoted: message });
    } catch (error) {
        console.error('Error in top command:', error);
        await sock.sendMessage(chatId, { text: 'Failed to load leaderboard.' }, { quoted: message });
    }
}





module.exports = {
  name: 'top',
  async execute(ctx) {
    return topCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null);
  }
};
