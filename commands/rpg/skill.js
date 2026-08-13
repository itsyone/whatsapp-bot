const { getEconomySnapshot, getUserRank } = require('../../lib/economy');
const {
    getRegisteredProfile,
    getXpTarget,
    getBagTierInfo,
    countInventorySlotsUsed,
    getUnlockedNetworks
} = require('../../lib/registrationStore');
const { generateSkillCard, clampStat } = require('../../lib/skillCardCanvas');

function getTargetJid(message, fallback) {
    const contextInfo = message?.message?.extendedTextMessage?.contextInfo
        || message?.message?.imageMessage?.contextInfo
        || message?.message?.videoMessage?.contextInfo
        || {};
    const mentioned = Array.isArray(contextInfo.mentionedJid) ? contextInfo.mentionedJid : [];
    if (mentioned[0]) return mentioned[0];
    if (contextInfo.participant) return contextInfo.participant;
    return fallback;
}

function rankFromPct(pct) {
    if (pct >= 90) return { label: 'S', color: '#e74c3c' };
    if (pct >= 75) return { label: 'A', color: '#9b59b6' };
    if (pct >= 55) return { label: 'B', color: '#2980b9' };
    if (pct >= 35) return { label: 'C', color: '#27ae60' };
    return { label: 'D', color: '#8B6914' };
}

function compactXp(value) {
    const num = Math.max(0, Number(value || 0));
    if (num >= 1000) {
        const short = Math.round((num / 100)) / 10;
        return `${short % 1 === 0 ? short.toFixed(0) : short.toFixed(1)}K`;
    }
    return String(num);
}

function makeBar(pct) {
    const filled = Math.max(0, Math.min(10, Math.round((Number(pct || 0)) * 10)));
    return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

function buildTitles(profile, snapshot, userRank, bagTier, unlockedCount, slotsUsed) {
    const titles = [];
    const totalAssets = Number(snapshot?.totalAssets || 0);
    const totalXp = Number(profile?.totalXpEarned || 0);
    const level = Number(profile?.level || 0);
    const fragments = Number(profile?.glitchFragments || 0);

    if (userRank?.rank && userRank.rank <= 3) titles.push('Leaderboard Elite');
    if (totalAssets >= 1000000) titles.push('Yen Tycoon');
    if (level >= 25) titles.push('High Level Vanguard');
    if (totalXp >= 12000) titles.push('Arcane Scholar');
    if (bagTier.level >= 4) titles.push('Pack Master');
    if (unlockedCount >= 3) titles.push('Network Breaker');
    if (slotsUsed >= 5) titles.push('Resource Hoarder');
    if (fragments >= 3) titles.push('Glitch Touched');
    if (profile?.card === 'black') titles.push('Black Card Bearer');

    if (!titles.length) titles.push('Rising Adventurer');
    return titles.slice(0, 4);
}

function buildSkillCaption(profile, derived) {
    const stats = derived.stats || [];
    const skills = derived.skills || [];
    const titles = derived.titles || [];
    const xpCurrent = Number(profile?.xp || 0);
    const xpTarget = getXpTarget(profile?.level || 0);

    const statMap = Object.fromEntries(stats.map((entry) => [entry.key, entry.value]));
    const skillLines = [];
    for (let i = 0; i < skills.length; i += 2) {
        const first = skills[i];
        const second = skills[i + 1];
        if (second) {
            skillLines.push(`\`${first.shortName}\` ⟮${first.rank}⟯ • \`${second.shortName}\` ⟮${second.rank}⟯`);
        } else {
            skillLines.push(`\`${first.shortName}\` ⟮${first.rank}⟯`);
        }
    }

    const titleLines = [];
    for (let i = 0; i < titles.length; i += 2) {
        const first = titles[i];
        const second = titles[i + 1];
        titleLines.push(second
            ? `> ◈ _${first}_  ◈ _${second}_`
            : `> ◈ _${first}_`);
    }

    return [
        `*✦ ${String(profile?.name || 'Unknown').toUpperCase()}* • *LV ${Math.max(0, Number(profile?.level || 0))}*`,
        `_${derived.className}_`,
        '',
        '*📊 STATS*',
        `⚔️ ${statMap.STR || 0} | 🧠 ${statMap.INT || 0} | 🛡️ ${statMap.DEF || 0} | ⚡ ${statMap.AGI || 0}`,
        '',
        '*⟢ SKILLS*',
        ...skillLines,
        '',
        `*⌬ XP:* \`${compactXp(xpCurrent)} / ${compactXp(xpTarget)}\` [${makeBar(derived.xpPct || 0)}]`,
        '',
        '*✧ TITLES*',
        ...titleLines
    ].join('\n');
}

function buildRealStats(profile, snapshot, userRank) {
    const unlocked = getUnlockedNetworks(profile);
    const bagTier = getBagTierInfo(profile?.bagTier);
    const slotsUsed = countInventorySlotsUsed(profile?.inventory || {});
    const xpTarget = getXpTarget(profile?.level || 0);
    const xpPct = xpTarget > 0 ? (Number(profile?.xp || 0) / xpTarget) : 0;
    const balance = Number(snapshot?.totalAssets || 0);

    const str = clampStat(28 + Math.log10(balance + 1) * 23 + (slotsUsed * 4));
    const int = clampStat(30 + ((profile?.level || 0) * 2.5) + (Number(profile?.totalXpEarned || 0) / 600));
    const def = clampStat(24 + (bagTier.level * 12) + (slotsUsed * 5));
    const agi = clampStat(26 + (unlocked.length * 11) + (xpPct * 42) + ((userRank?.rank ? Math.max(0, 30 - userRank.rank) : 0)));

    const skillData = [
        {
            iconType: 'fire',
            name: 'Wallet Surge',
            shortName: 'Wallet',
            pct: Math.max(18, Math.min(100, Math.round(Math.log10(balance + 10) * 22))),
            color: '#c0392b'
        },
        {
            iconType: 'bolt',
            name: 'XP Flow',
            shortName: 'XP Flow',
            pct: Math.max(12, Math.min(100, Math.round(xpPct * 100))),
            color: '#9b59b6'
        },
        {
            iconType: 'shield',
            name: 'Bag Guard',
            shortName: 'Bag Guard',
            pct: Math.max(15, Math.min(100, Math.round((bagTier.level / 5) * 100))),
            color: '#2980b9'
        },
        {
            iconType: 'boot',
            name: 'Network Drift',
            shortName: 'Network',
            pct: Math.max(10, Math.min(100, Math.round((unlocked.length / 5) * 100))),
            color: '#27ae60'
        },
        {
            iconType: 'eye',
            name: 'Drop Sense',
            shortName: 'Drops',
            pct: Math.max(8, Math.min(100, Math.round((Number(profile?.glitchFragments || 0) * 12) + (slotsUsed * 6)))),
            color: '#d4aa50'
        }
    ].map((entry) => {
        const rank = rankFromPct(entry.pct);
        return {
            ...entry,
            rank: rank.label,
            rankColor: rank.color
        };
    });

    const rankTitle = profile?.card === 'black'
        ? 'Glitch Sovereign'
        : unlocked.length >= 4
            ? 'Network Breaker'
            : unlocked.length >= 2
                ? 'Vault Raider'
                : 'Shadow Mage';

    const guildName = unlocked.length >= 3 ? 'Guild of Echoes' : `${snapshot?.activeNetwork || 'Wistoria'} Division`;
    const titles = buildTitles(profile, snapshot, userRank, bagTier, unlocked.length, slotsUsed);

    return {
        className: `${rankTitle} · ${guildName}`,
        level: Math.max(0, Number(profile?.level || 0)),
        stats: [
            { key: 'STR', value: str },
            { key: 'INT', value: int },
            { key: 'DEF', value: def },
            { key: 'AGI', value: agi }
        ],
        skills: skillData,
        xpPct,
        xpText: `${Number(profile?.xp || 0).toLocaleString()} / ${xpTarget.toLocaleString()} XP`,
        badges: titles,
        titles
    };
}

async function skillCommand(sock, chatId, message, senderId) {
    try {
        const targetJid = getTargetJid(message, senderId);
        const profile = getRegisteredProfile(targetJid);
        if (!profile) {
            await sock.sendMessage(chatId, {
                text: 'That user is not registered yet.'
            }, { quoted: message });
            return;
        }

        const snapshot = getEconomySnapshot(targetJid);
        const userRank = getUserRank(targetJid);
        const derived = buildRealStats(profile, snapshot, userRank);

        let avatarUrl = '';
        try {
            avatarUrl = await sock.profilePictureUrl(targetJid, 'image');
        } catch {}

        const buffer = await generateSkillCard({
            name: profile.name,
            avatarUrl,
            ...derived
        });

        await sock.sendMessage(chatId, {
            image: buffer,
            caption: buildSkillCaption(profile, derived)
        }, { quoted: message });
    } catch (error) {
        console.error('Error in skill command:', error);
        await sock.sendMessage(chatId, {
            text: 'Failed to build the skill card right now.'
        }, { quoted: message });
    }
}





module.exports = {
  name: 'skill',
  async execute(ctx) {
    return skillCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null);
  }
};
