const https = require('https');
const { addBalanceAtomic } = require('../../lib/economy');
const {
    getRegisteredProfile,
    consumeInventoryItem,
    activateDropMagnet,
    activateXpBoost,
    grantTempNetworkUnlock,
    awardRegistrationProgress,
    getUnlockedNetworks,
    grantNetworkUnlock,
    accessItemKeyFromNetwork
} = require('../../lib/registrationStore');
const { normalizeNetwork } = require('../../lib/bankSystem');

const ITEM_THUMBS = {
    xpBoost: 'https://files.catbox.moe/8s56yi.png',
    dropMagnet: 'https://files.catbox.moe/gh9gmw.png',
    network: 'https://files.catbox.moe/ivw4cy.png'
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

async function getThumb(itemKey) {
    const url = ITEM_THUMBS[itemKey];
    if (!url) return null;
    if (!thumbCache.has(url)) {
        thumbCache.set(url, await fetchBuffer(url).catch(() => null));
    }
    return thumbCache.get(url) || null;
}

function withThumb(text, thumb, title, body) {
    if (!thumb) return { text };
    return {
        text,
        contextInfo: {
            externalAdReply: {
                title,
                body,
                mediaType: 1,
                mediaUrl: '',
                renderLargerThumbnail: false,
                showAdAttribution: false,
                sourceUrl: '',
                thumbnail: thumb
            }
        }
    };
}

function parseItem(raw = '') {
    const text = String(raw || '').trim().toLowerCase();
    if (['magnet', 'dropmagnet', 'drop-magnet'].includes(text)) return 'dropMagnet';
    if (['xp', 'xpboost', 'boost', 'xp-boost'].includes(text)) return 'xpBoost';
    if (['token', 'unlocktoken', 'unlock-token'].includes(text)) return 'unlockToken';
    if (['key', 'vaultkey', 'vault-key'].includes(text)) return 'vaultKey';
    if (['neon', 'neonaccess', 'neon-access'].includes(text)) return 'neonAccess';
    if (['vortex', 'vortexaccess', 'vortex-access'].includes(text)) return 'vortexAccess';
    if (['titan', 'titanaccess', 'titan-access'].includes(text)) return 'titanAccess';
    if (['glitch', 'glitchaccess', 'glitch-access'].includes(text)) return 'glitchAccess';
    return '';
}

function errorText(message) {
    return `❌ ${message}`;
}

async function useCommand(sock, chatId, message, senderId, rawText = '') {
    try {
        const profile = getRegisteredProfile(senderId);
        if (!profile) {
            await sock.sendMessage(chatId, {
                text: 'Register first with `.register`.'
            }, { quoted: message });
            return;
        }

        const parts = String(rawText || '').trim().split(/\s+/);
        const itemKey = parseItem(parts[1]);
        if (!itemKey) {
            await sock.sendMessage(chatId, {
                text: 'Use `.use magnet`, `.use boost`, `.use token vortex`, `.use titan`, or `.use key`.'
            }, { quoted: message });
            return;
        }

        if (itemKey === 'dropMagnet') {
            const consume = consumeInventoryItem(senderId, 'dropMagnet', 1);
            if (!consume?.ok) {
                await sock.sendMessage(chatId, { text: errorText('item not found') }, { quoted: message });
                return;
            }
            activateDropMagnet(senderId);
            const thumb = await getThumb('dropMagnet');
            await sock.sendMessage(chatId, withThumb(
                '🧲 *MAGNET USED*\n\n> next drop boosted',
                thumb,
                'MAGNET USED',
                'next drop boosted'
            ), { quoted: message });
            return;
        }

        if (itemKey === 'xpBoost') {
            const consume = consumeInventoryItem(senderId, 'xpBoost', 1);
            if (!consume?.ok) {
                await sock.sendMessage(chatId, { text: errorText('item not found') }, { quoted: message });
                return;
            }
            activateXpBoost(senderId, 10 * 60 * 1000);
            const thumb = await getThumb('xpBoost');
            await sock.sendMessage(chatId, withThumb(
                '⚡ *XP BOOST ACTIVE*\n\n> x2 XP for 10m',
                thumb,
                'XP BOOST ACTIVE',
                'x2 XP for 10m'
            ), { quoted: message });
            return;
        }

        if (itemKey === 'unlockToken') {
            const target = normalizeNetwork(parts[2]);
            if (!target) {
                await sock.sendMessage(chatId, {
                    text: 'Use `.use token vortex`.'
                }, { quoted: message });
                return;
            }

            const unlocked = getUnlockedNetworks(profile);
            if (unlocked.includes(target)) {
                await sock.sendMessage(chatId, {
                    text: errorText(`${target} already unlocked`)
                }, { quoted: message });
                return;
            }

            const consume = consumeInventoryItem(senderId, 'unlockToken', 1);
            if (!consume?.ok) {
                await sock.sendMessage(chatId, { text: errorText('item not found') }, { quoted: message });
                return;
            }

            grantTempNetworkUnlock(senderId, target, 30 * 60 * 1000);
            const thumb = await getThumb('network');
            await sock.sendMessage(chatId, withThumb(
                `🔓 *UNLOCK TOKEN*\n\n> ${target} access granted`,
                thumb,
                'UNLOCK TOKEN',
                `${target} access granted`
            ), { quoted: message });
            return;
        }

        if (itemKey === 'vaultKey') {
            const consume = consumeInventoryItem(senderId, 'vaultKey', 1);
            if (!consume?.ok) {
                await sock.sendMessage(chatId, { text: errorText('item not found') }, { quoted: message });
                return;
            }

            const cash = 4000 + Math.floor(Math.random() * 9001);
            const xp = 250 + Math.floor(Math.random() * 951);
            await addBalanceAtomic(senderId, cash, {
                awardXp: false,
                force: true,
                source: 'use_vault_key',
                category: 'economy',
                actorJid: senderId
            });
            awardRegistrationProgress(senderId, xp);

            await sock.sendMessage(chatId, {
                text: `🗝 *VAULT OPENED*\n\n> +$${cash.toLocaleString()} 💰\n> +${xp.toLocaleString()} XP ⚡`
            }, { quoted: message });
            return;
        }

        if (itemKey.endsWith('Access')) {
            const targetNetwork = normalizeNetwork(itemKey.replace(/access$/i, ''));
            if (!targetNetwork) {
                await sock.sendMessage(chatId, { text: errorText('invalid access item') }, { quoted: message });
                return;
            }

            const unlocked = getUnlockedNetworks(getRegisteredProfile(senderId));
            if (unlocked.includes(targetNetwork)) {
                await sock.sendMessage(chatId, {
                    text: errorText(`${targetNetwork} already unlocked`)
                }, { quoted: message });
                return;
            }

            const inventoryKey = accessItemKeyFromNetwork(targetNetwork);
            const consume = consumeInventoryItem(senderId, inventoryKey, 1);
            if (!consume?.ok) {
                await sock.sendMessage(chatId, { text: errorText('item not found') }, { quoted: message });
                return;
            }

            grantNetworkUnlock(senderId, targetNetwork);
            const thumb = await getThumb('network');
            await sock.sendMessage(chatId, withThumb(
                `🌐 *ACCESS UNLOCKED*\n\n> ${targetNetwork} is now unlocked`,
                thumb,
                'ACCESS UNLOCKED',
                `${targetNetwork} unlocked`
            ), { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, { text: errorText('item not found') }, { quoted: message });
    } catch (error) {
        console.error('[use] error:', error.message);
        await sock.sendMessage(chatId, {
            text: 'Failed to use item.'
        }, { quoted: message });
    }
}





module.exports = {
  name: 'use',
  async execute(ctx) {
    return useCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.rawText || null);
  }
};
