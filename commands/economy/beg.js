const https = require('https');
const { addBalanceAtomic } = require('../../lib/economy');
const { getRegisteredProfile } = require('../../lib/registrationStore');
const { formatCooldown, getRemainingCooldown, setCooldown } = require('../../lib/gathering');

const THUMB_URL = 'https://files.catbox.moe/pxeuwu.png';
const COOLDOWN_MS = 10 * 60 * 1000;
let thumbCache = null;

const OUTCOMES = [
    { label: 'fail', min: 0, max: 0, weight: 20 },
    { label: 'low', min: 20, max: 80, weight: 28 },
    { label: 'normal', min: 100, max: 200, weight: 28 },
    { label: 'good', min: 200, max: 300, weight: 16 },
    { label: 'rare', min: 400, max: 600, weight: 8 }
];

const SUCCESS_TEXTS = [
    '🙏 You tried asking for spare change...\n\n> A kind stranger gave you a little\n> +{amount} ¥ 💴',
    '🙏 You held your hand out quietly...\n\n> Someone dropped a few yen in it\n> +{amount} ¥ 💴',
    '🙏 You asked around for a little help...\n\n> A passerby showed some kindness\n> +{amount} ¥ 💴',
    '🙏 You looked a little down on luck...\n\n> Somebody decided to help out\n> +{amount} ¥ 💴',
    '🙏 You begged with your last bit of pride...\n\n> A stranger spared some yen\n> +{amount} ¥ 💴'
];

const FAIL_TEXTS = [
    '🙏 You tried asking for spare change...\n\n> Nobody stopped this time\n> +0 ¥ 💴',
    '🙏 You asked around for help...\n\n> The street stayed cold today\n> +0 ¥ 💴',
    '🙏 You reached out for a little kindness...\n\n> No one gave you anything\n> +0 ¥ 💴'
];

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

function pickWeightedOutcome() {
    const total = OUTCOMES.reduce((sum, item) => sum + item.weight, 0);
    let roll = Math.random() * total;
    for (const item of OUTCOMES) {
        roll -= item.weight;
        if (roll <= 0) return item;
    }
    return OUTCOMES[0];
}

function randomAmount(outcome) {
    if (!outcome || outcome.max <= outcome.min) return Number(outcome?.min || 0);
    return outcome.min + Math.floor(Math.random() * (outcome.max - outcome.min + 1));
}

function payload(text, thumb) {
    return {
        text,
        contextInfo: {
            externalAdReply: {
                title: 'BEG',
                body: 'spare change',
                mediaType: 1,
                mediaUrl: '',
                renderLargerThumbnail: false,
                showAdAttribution: false,
                sourceUrl: '',
                ...(thumb ? { thumbnail: thumb } : { thumbnailUrl: THUMB_URL })
            }
        }
    };
}

async function begCommand(sock, chatId, message, senderId) {
    if (!getRegisteredProfile(senderId)) {
        await sock.sendMessage(chatId, { text: 'Register first with `.register`.' }, { quoted: message });
        return;
    }

    const remaining = getRemainingCooldown(senderId, 'beg', COOLDOWN_MS);
    if (remaining > 0) {
        await sock.sendMessage(chatId, {
            text: `⏳ Beg cooldown active\n\n> Try again in ${formatCooldown(remaining)}`
        }, { quoted: message });
        return;
    }

    const outcome = pickWeightedOutcome();
    const amount = randomAmount(outcome);
    if (amount > 0) {
        await addBalanceAtomic(senderId, amount, {
            awardXp: false,
            force: true,
            source: 'beg_reward',
            category: 'economy',
            actorJid: senderId
        });
    }
    setCooldown(senderId, 'beg', Date.now());

    const source = amount > 0 ? SUCCESS_TEXTS : FAIL_TEXTS;
    const template = source[Math.floor(Math.random() * source.length)];
    const text = template.replace('{amount}', amount.toLocaleString());
    const thumb = await getThumb();

    await sock.sendMessage(chatId, payload(text, thumb), { quoted: message });
}





module.exports = {
  name: 'beg',
  async execute(ctx) {
    return begCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null);
  }
};
