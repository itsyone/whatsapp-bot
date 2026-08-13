const https = require('https');
const { addInventoryItem, getRegisteredProfile } = require('../../lib/registrationStore');
const { formatCooldown, getRemainingCooldown, setCooldown } = require('../../lib/gathering');

const COOLDOWN_MS = 5 * 60 * 1000;
const THUMB_URL = 'https://files.catbox.moe/0kccw1.png';

const OUTCOMES = [
    {
        weight: 24,
        rewards: [{ key: 'meat', amount: 1 }],
        text: '🏹 Hunting...\n> You caught: Rabbit 🐇 + Meat 🍖'
    },
    {
        weight: 24,
        rewards: [{ key: 'meat', amount: 2 }],
        text: '🏹 Hunting...\n> You tracked: Deer 🦌\n> Reward: Meat 🍖 x2'
    },
    {
        weight: 20,
        rewards: [{ key: 'meat', amount: 1 }, { key: 'hide', amount: 1 }],
        text: '🏹 Hunting...\n> You found: Wild Boar 🐗\n> Loot: Meat 🍖 + Hide 🧥'
    },
    {
        weight: 22,
        rewards: [],
        text: '🏹 Hunting...\n> Missed your shot... ❌'
    },
    {
        weight: 10,
        rewards: [{ key: 'meat', amount: 1 }, { key: 'hide', amount: 1 }],
        text: '🏹 Hunting...\n> Critical hit! 🎯\n> You caught: Rare Fox 🦊'
    }
];

let thumbCache = null;

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

async function getThumb() {
    if (!thumbCache) thumbCache = await fetchBuffer(THUMB_URL).catch(() => null);
    return thumbCache;
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

module.exports = async function huntCommand(sock, chatId, message, senderId) {
    const profile = getRegisteredProfile(senderId);
    if (!profile) {
        await sock.sendMessage(chatId, { text: 'Register first with `.register`.' }, { quoted: message });
        return;
    }

    const remaining = getRemainingCooldown(senderId, 'hunt', COOLDOWN_MS);
    if (remaining > 0) {
        await sock.sendMessage(chatId, { text: `⏳ Hunting cooldown active\n\n> Try again in ${formatCooldown(remaining)}` }, { quoted: message });
        return;
    }

    const outcome = pickOutcome();
    for (const reward of outcome.rewards) {
        addInventoryItem(senderId, reward.key, reward.amount);
    }
    setCooldown(senderId, 'hunt', Date.now());
    const thumb = await getThumb();

    await sock.sendMessage(chatId, {
        text: outcome.text,
        contextInfo: {
            externalAdReply: {
                title: 'HUNT',
                body: 'wild rewards',
                mediaType: 1,
                mediaUrl: '',
                renderLargerThumbnail: false,
                showAdAttribution: false,
                sourceUrl: '',
                ...(thumb ? { thumbnail: thumb } : { thumbnailUrl: THUMB_URL })
            }
        }
    }, { quoted: message });
};
