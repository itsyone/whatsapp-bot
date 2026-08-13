const https = require('https');
const { getBalance, addBalance } = require('../../lib/economy');
const { getRegisteredProfile, addInventoryItem } = require('../../lib/registrationStore');

const PRICE = 50000;
const THUMB_URL = 'https://files.catbox.moe/yb977p.png';
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

module.exports = async function pickaxeCommand(sock, chatId, message, senderId) {
    const profile = getRegisteredProfile(senderId);
    if (!profile) {
        await sock.sendMessage(chatId, { text: 'Register first with `.register`.' }, { quoted: message });
        return;
    }

    const balance = getBalance(senderId);
    if (balance < PRICE) {
        await sock.sendMessage(chatId, {
            text: `⛏ Pickaxe locked\n\n> Need: ¥${PRICE.toLocaleString()}\n> Wallet: ¥${balance.toLocaleString()}`
        }, { quoted: message });
        return;
    }

    addBalance(senderId, -PRICE, { awardXp: false });
    addInventoryItem(senderId, 'pickaxe', 1);
    const thumb = await getThumb();

    await sock.sendMessage(chatId, {
        text: `⛏ Pickaxe purchased\n\n> Cost: ¥${PRICE.toLocaleString()} 💴\n> Added: Pickaxe ×1`,
        contextInfo: {
            externalAdReply: {
                title: 'PICKAXE',
                body: 'mining tool',
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
