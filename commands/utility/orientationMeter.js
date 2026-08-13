const https = require('https');

const THUMBS = {
    gay: 'https://i.ibb.co/twWw54sp/Taesung-y-Haebom.jpg',
    lesbian: 'https://i.ibb.co/LzQC1Q22/Miku-Transbian-PFP.jpg',
    lesbo: 'https://i.ibb.co/LzQC1Q22/Miku-Transbian-PFP.jpg',
    horny: 'https://i.ibb.co/twWw54sp/Taesung-y-Haebom.jpg'
};

const cache = new Map();

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchBuffer(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to fetch image: ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
    });
}

async function getThumb(kind) {
    const key = THUMBS[kind] ? kind : 'lesbian';
    const url = THUMBS[key];
    if (cache.has(url)) return cache.get(url);
    try {
        const buffer = await fetchBuffer(url);
        cache.set(url, buffer);
        return buffer;
    } catch (e) {
        console.error(`[OrientationMeter] Thumb fetch failed for ${key}:`, e.message);
        return null;
    }
}

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function makeBar(percent) {
    const fill = Math.max(0, Math.min(10, Math.floor(percent / 10)));
    return `${'▰'.repeat(fill)}${'▱'.repeat(10 - fill)}`;
}

function getTargetJid(message) {
    const actor = message?.key?.participant || message?.key?.remoteJid || '';
    const ctx = message?.message?.extendedTextMessage?.contextInfo;
    const quoted = ctx?.participant || '';
    const mentions = Array.isArray(ctx?.mentionedJid) ? ctx.mentionedJid : [];
    const mention = mentions.find((j) => j && j !== actor) || '';
    return quoted || mention || actor;
}

function buildText(kind, targetTag, percent) {
    const bar = makeBar(percent);

    if (kind === 'gay' || kind === 'horny') {
        const vibes = kind === 'horny'
            ? ['down bad aura', 'thirst detected', 'no horny jail yet', 'playful chaos', 'bold spark']
            : ['fruity energy', 'rainbow aura', 'prism vibe', 'playful chaos', 'bold spark'];
        const label = kind === 'horny' ? 'HORNY TESTER' : 'GAY METER';
        const icon = kind === 'horny' ? '🔥' : '🌈';

        return `╭── ${icon} ${label} ──╮\n│ 👤 ${targetTag}\n│ 📊 scanning...\n│\n│ ${bar} • ${percent}% ${icon}\n│\n│ 💭 vibe: ${pick(vibes)}\n╰────────────────╯`;
    }

    const vibes = [
        'soft energy',
        'moonlight aura',
        'gentle chaos',
        'sweet spark',
        'calm vibe'
    ];

    return `╭── 🏳️‍🌈 LESBIAN METER ──╮\n│ 👤 ${targetTag}\n│ 📊 orientation scan...\n│\n│ ${bar} • ${percent}% 🏳️‍🌈\n│\n│ 💭 vibe: ${pick(vibes)}\n╰────────────────╯`;
}

function card(text, thumb, mentions = [], title = '', body = '') {
    const payload = {
        text,
        mentions
    };

    if (thumb) {
        payload.contextInfo = {
            externalAdReply: {
                title,
                body,
                mediaType: 1,
                renderLargerThumbnail: false,
                showAdAttribution: false,
                thumbnail: thumb
            }
        };
    }

    return payload;
}

async function orientationMeterCommand(sock, chatId, message, name = '') {
    try {
        const cmd = String(name || '').trim().toLowerCase().replace(/^\./, '');
        if (!['gay', 'lesbian', 'lesbo', 'horny'].includes(cmd)) return;

        console.log(`[OrientationMeter] Processing ${cmd}`);
        const target = getTargetJid(message);
        const targetTag = `@${String(target).split('@')[0]}`;
        const percent = Math.floor(Math.random() * 101);

        const text = buildText(cmd, targetTag, percent);
        const thumb = await getThumb(cmd);

        const title = cmd === 'gay' ? '🌈 ɢᴀʏ ᴍᴇᴛᴇʀ' : '🏳️‍🌈 ʟᴇꜱʙɪᴀɴ ᴍᴇᴛᴇʀ';
        const body = `Orientation scan for ${targetTag.replace('@', '')}`;

        await sock.sendMessage(chatId, card(text, thumb, [target], title, body), { quoted: message });
    } catch (err) {
        console.error('[OrientationMeter] Command error:', err);
    }
}

module.exports = {
    name: 'gay',
    alias: ['lesbian', 'lesbo', 'horny'],
    async execute(ctx) {
        const name = String(ctx.userMessage || '').split(/\s+/).shift() || 'gay';
        return orientationMeterCommand(ctx.sock, ctx.chatId, ctx.message, name);
    }
};
