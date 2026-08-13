const https = require('https');
const { addInventoryItem, getRegisteredProfile } = require('../../lib/registrationStore');
const { formatCooldown, getRemainingCooldown, setCooldown } = require('../../lib/gathering');

const COOLDOWN_MS = 5 * 60 * 1000;
const THUMBS = {
    gold: 'https://files.catbox.moe/yb977p.png',
    emerald: 'https://files.catbox.moe/uxyxdf.png',
    diamond: 'https://files.catbox.moe/plobgz.png',
    normal: 'https://files.catbox.moe/f0vgb8.png',
    coal: 'https://files.catbox.moe/oj5771.png'
};

const OUTCOMES = [
    {
        weight: 22,
        thumb: 'normal',
        rewards: [{ key: 'iron', amount: 1 }, { key: 'coal', amount: 1 }],
        text: '⛏️ Mining...\n> You found: Iron 🪨 + Coal ⚫'
    },
    {
        weight: 22,
        thumb: 'gold',
        rewards: [{ key: 'goldOre', amount: 1 }],
        text: '⛏️ Mining...\n> You discovered: Gold 🪙'
    },
    {
        weight: 10,
        thumb: 'diamond',
        rewards: [{ key: 'diamond', amount: 2 }],
        text: '⛏️ Mining...\n> Jackpot! 💎\n> You got: Diamond 💎 x2'
    },
    {
        weight: 28,
        thumb: 'normal',
        rewards: [],
        text: '⛏️ Mining...\n> Nothing found... ❌'
    },
    {
        weight: 18,
        thumb: 'emerald',
        rewards: [{ key: 'emerald', amount: 1 }, { key: 'goldOre', amount: 1 }],
        text: '⛏️ Mining...\n> You hit a rare vein!\n> Loot: Emerald 💚 + Gold 🪙'
    }
];

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

async function getThumb(key) {
    const url = THUMBS[key] || THUMBS.normal;
    if (!thumbCache.has(url)) {
        thumbCache.set(url, await fetchBuffer(url).catch(() => null));
    }
    return thumbCache.get(url) || null;
}

function pickOutcome() {
    const total = OUTCOMES.reduce((sum, item) => sum + item.weight, 0);
    let roll = Math.random() * total;
    for (const item of OUTCOMES) {
        roll -= item.weight;
        if (roll <= 0) return item;
    }
    return OUTCOMES[0];
}

module.exports = async function mineCommand(sock, chatId, message, senderId) {
    const profile = getRegisteredProfile(senderId);
    if (!profile) {
        await sock.sendMessage(chatId, { text: 'Register first with `.register`.' }, { quoted: message });
        return;
    }

    if (Number(profile?.inventory?.pickaxe || 0) < 1) {
        await sock.sendMessage(chatId, { text: '⛏ You need a pickaxe first.\n> Buy one with `.pickaxe` for ¥50,000.' }, { quoted: message });
        return;
    }

    const remaining = getRemainingCooldown(senderId, 'mine', COOLDOWN_MS);
    if (remaining > 0) {
        await sock.sendMessage(chatId, { text: `⏳ Mining cooldown active\n\n> Try again in ${formatCooldown(remaining)}` }, { quoted: message });
        return;
    }

    const outcome = pickOutcome();
    for (const reward of outcome.rewards) {
        addInventoryItem(senderId, reward.key, reward.amount);
    }
    setCooldown(senderId, 'mine', Date.now());
    const thumb = await getThumb(outcome.thumb);

    await sock.sendMessage(chatId, {
        text: outcome.text,
        contextInfo: {
            externalAdReply: {
                title: 'MINE',
                body: 'deep underground',
                mediaType: 1,
                mediaUrl: '',
                renderLargerThumbnail: false,
                showAdAttribution: false,
                sourceUrl: '',
                ...(thumb ? { thumbnail: thumb } : { thumbnailUrl: THUMBS[outcome.thumb] || THUMBS.normal })
            }
        }
    }, { quoted: message });
};
