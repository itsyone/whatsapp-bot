const { getEconomySnapshot } = require('../../lib/economy');
const { generateProfileCard } = require('../../lib/y2kProfileCardCanvas');
const { generateAnimatedProfileCard } = require('../../lib/y2kProfileCardGif');
const { getRegisteredProfile, getXpTarget, resolveRegisteredJid } = require('../../lib/registrationStore');
const PROFILE_LOOKUP_TTL_MS = 5 * 60 * 1000;
const displayNameCache = new Map();
const avatarUrlCache = new Map();

function resolveTarget(message, senderId) {
    const contextInfo = message?.message?.extendedTextMessage?.contextInfo || {};
    const mentioned = Array.isArray(contextInfo.mentionedJid) ? contextInfo.mentionedJid : [];
    const rawTarget = mentioned[0] || contextInfo.participant || senderId;
    return resolveRegisteredJid(rawTarget) || rawTarget;
}

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

function buildSubtitle(totalAssets) {
    const balance = Math.max(0, Number(totalAssets || 0));
    if (balance >= 50000) return 'Elite Collector';
    if (balance >= 10000) return 'High Roller';
    if (balance >= 2500) return 'Verified User';
    return 'Rising Player';
}

async function getDisplayName(sock, jid, fallbackName) {
    const cacheKey = String(jid || '').trim();
    const preferred = String(fallbackName || '').trim();
    if (preferred) return preferred;
    const cached = displayNameCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) < PROFILE_LOOKUP_TTL_MS) {
        return cached.value; // FIXED: cache profile display-name lookups
    }
    try {
        const name = await sock.getName(jid);
        if (name) {
            const value = String(name).trim();
            displayNameCache.set(cacheKey, { value, at: Date.now() }); // FIXED: cache resolved display name
            return value;
        }
    } catch {}
    const value = preferred || jid.split('@')[0];
    displayNameCache.set(cacheKey, { value, at: Date.now() }); // FIXED: cache display-name fallback
    return value;
}

async function getAvatarUrl(sock, jid) {
    const cacheKey = String(jid || '').trim();
    const cached = avatarUrlCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) < PROFILE_LOOKUP_TTL_MS) {
        return cached.value; // FIXED: cache profile avatar lookups
    }
    try {
        const value = await sock.profilePictureUrl(jid, 'image');
        avatarUrlCache.set(cacheKey, { value, at: Date.now() }); // FIXED: cache resolved avatar URL
        return value;
    } catch {
        avatarUrlCache.set(cacheKey, { value: null, at: Date.now() }); // FIXED: cache missing avatar results
        return null;
    }
}

async function profileCommand(sock, chatId, message, senderId, rawText = '') {
    try {
        const targetJid = resolveTarget(message, senderId);
        const isSelf = targetJid === senderId;
        console.log(`[profile] Looking up profile for targetJid: ${targetJid}, senderId: ${senderId}`);
        const snapshot = getEconomySnapshot(targetJid);
        const walletBalance = snapshot.wallet;
        const bankBalance = snapshot.bankBalance;
        const registered = getRegisteredProfile(targetJid);
        console.log(`[profile] Registered profile found: ${registered ? 'yes' : 'no'} for ${targetJid}`);
        if (!registered) {
            await sock.sendMessage(chatId, {
                text: 'Register first with `.register` to use your profile.'
            }, { quoted: message });
            return;
        }

        const level = Math.max(0, Number(registered.level || 0));
        const xpCurrent = Math.max(0, Number(registered.xp || 0));
        const xpTotal = getXpTarget(level);
        const totalXpEarned = Math.max(0, Number(registered.totalXpEarned || 0));
        const username = registered?.name || await getDisplayName(sock, targetJid, isSelf ? message?.pushName : '');
        const avatarUrl = await getAvatarUrl(sock, targetJid);
        const rankLabel = pickRankLabel(level, totalXpEarned);
        const subtitle = registered?.bio || buildSubtitle(snapshot.totalAssets);
        const userIdLabel = registered?.userId || `#${targetJid.split('@')[0].replace(/\D/g, '').slice(-6) || '000001'}`;
        const cardType = registered?.card || 'starter';
        const networkName = snapshot.activeNetwork || registered?.network || 'Wistoria';

        const wantsGif = /\b(?:gif|anim|animated)\b/i.test(String(rawText || ''));
        const cardData = {
            username,
            userId: userIdLabel,
            subtitle,
            bankBalance,
            walletBalance,
            rank: rankLabel,
            level,
            xpCurrent,
            xpTotal,
            cardType,
            network: networkName,
            status: 'Active',
            avatarUrl,
            gender: registered?.gender || 'male', // FIXED: profile theme gender
            theme: registered?.gender === 'female' ? 'pink' : 'blue' // FIXED: profile theme selection
        };

        const caption = [
            '┃ ✦ *𝐄𝐂𝐋𝐈𝐏𝐒𝐄 𝐏𝐑𝐎𝐅𝐈𝐋𝐄*',
            '┃ ━━━━━━━',
            `┃ ୨୧ *${username}* ▸ ${userIdLabel}`,
            `┃ 💭 "${subtitle}"`,
            '┃ ━━━━━━━',
            '┃ ✦ *CORE STATUS*',
            `┃ ⟡ Rank : ${rankLabel} (Lv. ${level})`,
            `┃ ⟡ XP   : ${xpCurrent.toLocaleString()} / ${xpTotal.toLocaleString()}`,
            ...(registered?.age ? ['┃ ⟡ Age  : ' + registered.age] : []),
            '┃ ━━━━━━━',
            '┃ ✦ *SYSTEM INFO*',
            `┃ ⌁ Net  : ${networkName}`,
            `┃ ⌁ Card : ${cardType}`,
            '┃ ━━━━━━━',
            '> 🟢 *ACTIVE* ︱ *Signal: Stable*'
        ].join('\n');

        if (wantsGif) {
            const gifVideo = await generateAnimatedProfileCard(cardData);
            await sock.sendMessage(chatId, {
                video: gifVideo,
                mimetype: 'video/mp4',
                gifPlayback: true,
                caption: `${caption}\n\n> animated test render`
            }, { quoted: message });
            return;
        }

        const image = await generateProfileCard(cardData);
        await sock.sendMessage(chatId, {
            image,
            mimetype: 'image/png',
            caption,
            mentions: [targetJid]
        }, { quoted: message });
    } catch (error) {
        console.error('Error in profile command:', error);
        await sock.sendMessage(chatId, {
            text: 'Failed to generate profile card.'
        }, { quoted: message });
    }
}



module.exports.profileCommand = profileCommand;
module.exports.default = profileCommand;


module.exports = {
  name: 'profile',
  async execute(ctx) {
    return profileCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.rawText || null);
  }
};
