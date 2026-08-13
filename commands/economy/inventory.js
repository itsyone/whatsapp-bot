const https = require('https');
const {
    getRegisteredProfile,
    getBagTierInfo,
    getNextBagTierInfo,
    countInventorySlotsUsed,
    setBagTier
} = require('../../lib/registrationStore');
const { getBalance, addBalance } = require('../../lib/economy');

const INVENTORY_THUMBS = {
    starter: 'https://files.catbox.moe/1kjmct.png',
    1: 'https://files.catbox.moe/mv68z8.png',
    2: 'https://files.catbox.moe/s781kg.png',
    3: 'https://files.catbox.moe/mj2462.png',
    4: 'https://files.catbox.moe/pj7xay.png'
};

const NETWORK_EMOJI = {
    Wistoria: '⚪',
    Neon: '🔵',
    Vortex: '🟣',
    Titan: '🟡',
    Glitch: '🔴'
};

const thumbCache = new Map();

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchBuffer(res.headers.location).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function getInventoryThumb(profile) {
    const bagTier = Math.max(0, Number(profile?.bagTier || 0));
    const url = INVENTORY_THUMBS[bagTier] || INVENTORY_THUMBS.starter || INVENTORY_THUMBS[1];
    if (!thumbCache.has(url)) {
        thumbCache.set(url, await fetchBuffer(url).catch(() => null));
    }

    return thumbCache.get(url) || null;
}

function formatDuration(ms) {
    const totalSeconds = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    if (mins < 1) return `${secs}s`;
    return secs ? `${mins}m ${secs}s` : `${mins}m`;
}

function buildInventoryLines(profile, rawText = '') {
    const now = Date.now();
    const inventory = profile.inventory || {};
    const effects = profile.effects || {};
    const input = String(rawText || '').trim().toLowerCase();
    const wantsBagTitle = /^\.bag(?:\s|$)/i.test(input);
    const wantsBackTitle = /^\.back(?:\s|$)/i.test(input);
    const title = wantsBagTitle ? '🎒 *BAG*' : wantsBackTitle ? '🎒 *BACKPACK*' : '🎒 *INVENTORY*';
    const bagTier = getBagTierInfo(profile.bagTier);
    const nextBagTier = getNextBagTierInfo(profile.bagTier);
    const usedSlots = countInventorySlotsUsed(inventory);
    const lines = [title, ''];
    const isBagView = wantsBagTitle || wantsBackTitle;
    const isFull = usedSlots >= bagTier.slots;

    if (isBagView) {
        lines.push(`> ${bagTier.icon} Tier ${bagTier.level} ${bagTier.name}`);
        lines.push(`> Slots: ${usedSlots}/${bagTier.slots}`);
        if (nextBagTier) {
            lines.push(`> Next: ${nextBagTier.name} (¥${nextBagTier.price.toLocaleString()})`);
            lines.push('> Upgrade: .bag upgrade');
        } else {
            lines.push('> Next: max tier reached');
        }
        lines.push('');
    }

    if (Number(inventory.dropMagnet || 0) > 0) lines.push(`> 🧲 drop magnet ×${inventory.dropMagnet}`);
    if (Number(inventory.xpBoost || 0) > 0) lines.push(`> ⚡ xp boost ×${inventory.xpBoost}`);
    if (Number(profile.glitchFragments || 0) > 0) lines.push(`> 🧩 glitch fragment ×${profile.glitchFragments}`);
    if (Number(inventory.unlockToken || 0) > 0) lines.push(`> 🔓 unlock token ×${inventory.unlockToken}`);
    if (Number(inventory.vaultKey || 0) > 0) lines.push(`> 🗝 vault key ×${inventory.vaultKey}`);
    if (Number(inventory.neonAccess || 0) > 0) lines.push(`> ${NETWORK_EMOJI.Neon} Neon access ×${inventory.neonAccess}`);
    if (Number(inventory.vortexAccess || 0) > 0) lines.push(`> ${NETWORK_EMOJI.Vortex} Vortex access ×${inventory.vortexAccess}`);
    if (Number(inventory.titanAccess || 0) > 0) lines.push(`> ${NETWORK_EMOJI.Titan} Titan access ×${inventory.titanAccess}`);
    if (Number(inventory.glitchAccess || 0) > 0) lines.push(`> ${NETWORK_EMOJI.Glitch} Glitch access ×${inventory.glitchAccess}`);
    if (Number(inventory.pistol || 0) > 0) lines.push(`> 🔫 pistol ×${inventory.pistol}`);
    if (Number(inventory.pickaxe || 0) > 0) lines.push(`> ⛏ pickaxe ×${inventory.pickaxe}`);
    if (Number(inventory.meat || 0) > 0) lines.push(`> 🍖 meat ×${inventory.meat}`);
    if (Number(inventory.hide || 0) > 0) lines.push(`> 🧥 hide ×${inventory.hide}`);
    if (Number(inventory.iron || 0) > 0) lines.push(`> 🪨 iron ×${inventory.iron}`);
    if (Number(inventory.coal || 0) > 0) lines.push(`> ⚫ coal ×${inventory.coal}`);
    if (Number(inventory.goldOre || 0) > 0) lines.push(`> 🪙 gold ore ×${inventory.goldOre}`);
    if (Number(inventory.emerald || 0) > 0) lines.push(`> 💚 emerald ×${inventory.emerald}`);
    if (Number(inventory.diamond || 0) > 0) lines.push(`> 💎 diamond ×${inventory.diamond}`);

    for (const [network, until] of Object.entries(effects.tempUnlockedNetworks || {})) {
        if (Number(until || 0) > now) {
            lines.push(`> ${NETWORK_EMOJI[network] || '⚪'} ${network} temp (${formatDuration(until - now)})`);
        }
    }

    if (Number(effects.xpBoostUntil || 0) > now) lines.push(`> ⚡ x2 XP (${formatDuration(effects.xpBoostUntil - now)})`);
    if (effects.dropMagnetReady) lines.push('> 🧲 magnet ready (next drop)');

    const itemStartIndex = isBagView ? 7 : 2;
    if (lines.length === itemStartIndex) lines.push('> empty');

    if (isFull && !isBagView) {
        lines.push('');
        lines.push(`> Slots full: ${usedSlots}/${bagTier.slots}`);
        if (nextBagTier) lines.push('> Upgrade: .bag upgrade');
    }

    return { lines, bagTier, nextBagTier, usedSlots, wantsBagTitle, wantsBackTitle };
}

async function inventoryCommand(sock, chatId, message, senderId, rawText = '') {
    try {
        const profile = getRegisteredProfile(senderId);
        if (!profile) {
            await sock.sendMessage(chatId, { text: 'Register first with `.register`.' }, { quoted: message });
            return;
        }

        const input = String(rawText || '').trim().toLowerCase();
        if (/^\.(?:bag|back|inventory)\s+upgrade$/i.test(input)) {
            const nextBagTier = getNextBagTierInfo(profile.bagTier);
            if (!nextBagTier) {
                await sock.sendMessage(chatId, { text: '🎒 Bag is already maxed out.' }, { quoted: message });
                return;
            }

            const balance = getBalance(senderId);
            if (balance < nextBagTier.price) {
                await sock.sendMessage(chatId, {
                    text: [
                        '🎒 Upgrade locked',
                        '',
                        `> Need: ¥${nextBagTier.price.toLocaleString()}`,
                        `> Wallet: ¥${balance.toLocaleString()}`
                    ].join('\n')
                }, { quoted: message });
                return;
            }

            addBalance(senderId, -nextBagTier.price, { awardXp: false });
            setBagTier(senderId, nextBagTier.level);
            await sock.sendMessage(chatId, {
                text: [
                    '🎒 *BAG UPGRADED*',
                    '',
                    `> ${nextBagTier.icon} Tier ${nextBagTier.level} ${nextBagTier.name}`,
                    `> Slots: ${nextBagTier.slots}`,
                    `> Cost: ¥${nextBagTier.price.toLocaleString()}`
                ].join('\n')
            }, { quoted: message });
            return;
        }

        const { lines, bagTier, usedSlots, wantsBagTitle, wantsBackTitle } = buildInventoryLines(profile, rawText);
        const thumb = await getInventoryThumb(profile);

        await sock.sendMessage(chatId, {
            text: lines.join('\n'),
            contextInfo: {
                externalAdReply: {
                    title: wantsBagTitle ? 'BAG' : wantsBackTitle ? 'BACKPACK' : 'INVENTORY',
                    body: `${bagTier.name} • ${usedSlots}/${bagTier.slots} slots`,
                    mediaType: 1,
                    mediaUrl: '',
                    renderLargerThumbnail: false,
                    showAdAttribution: false,
                    sourceUrl: '',
                    ...(thumb ? { thumbnail: thumb } : {})
                }
            }
        }, { quoted: message });
    } catch (error) {
        console.error('[inventory] error:', error.message);
        await sock.sendMessage(chatId, { text: 'Failed to open inventory.' }, { quoted: message });
    }
}





module.exports = {
  name: 'inventory',
  async execute(ctx) {
    return inventoryCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.rawText || null);
  }
};
