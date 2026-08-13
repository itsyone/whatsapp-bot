const https = require('https');
const fs = require('fs');
const path = require('path');
const { getBalance, addBalanceAtomic } = require('../../lib/economy');

const THUMB_URL = 'https://i.ibb.co/dwn64Vx5/image.jpg';
const STATE_PATH = path.join(process.cwd(), 'data', 'work.json'); // FIXED: absolute work state path
const COOLDOWN_MS = 5 * 60 * 1000;
const MIN_REWARD = 50;
const MAX_REWARD = 300;
const FAIL_CHANCE = 0.1;

const JOBS = [
    'coded a bot',
    'worked at a cafe',
    'delivered packages',
    'edited an anime clip',
    'fixed a server',
    'helped a customer',
    'cleaned the streets',
    'managed a shop',
    'worked overtime',
    'designed a UI'
];

const EMOJIS = ['🧑‍💻', '☕', '🚚', '🎬', '🛠️', '🧹', '🏪', '📦'];

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

function loadState() {
    if (!fs.existsSync(STATE_PATH)) {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(STATE_PATH, '{}', 'utf8');
    }
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function getUserState(state, jid) {
    if (!state.users) state.users = {};
    if (!state.users[jid]) {
        state.users[jid] = { lastWorkAt: 0 };
    }
    return state.users[jid];
}

function formatRemaining(ms) {
    const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0 && seconds > 0) return `${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
}

function randomItem(list) {
    return list[Math.floor(Math.random() * list.length)];
}

function randomReward() {
    return Math.floor(Math.random() * (MAX_REWARD - MIN_REWARD + 1)) + MIN_REWARD;
}

function buildPayload(text, thumb) {
    return {
        text,
        contextInfo: {
            externalAdReply: {
                title: 'WORK',
                body: 'daily hustle',
                sourceUrl: THUMB_URL,
                mediaType: 1,
                renderLargerThumbnail: false,
                showAdAttribution: false,
                thumbnailUrl: THUMB_URL,
                ...(thumb && { jpegThumbnail: thumb })
            }
        }
    };
}

async function workCommand(sock, chatId, message, senderId) {
    try {
        const state = loadState();
        const userState = getUserState(state, senderId);
        const now = Date.now();
        const remaining = Number(userState.lastWorkAt || 0) + COOLDOWN_MS - now;

        if (remaining > 0) {
            await sock.sendMessage(
                chatId,
                { text: `⏳ cooldown active\n> try again in ${formatRemaining(remaining)}` },
                { quoted: message }
            );
            return;
        }

        userState.lastWorkAt = now;
        saveState(state);

        const thumb = await getThumb();
        const fail = Math.random() < FAIL_CHANCE;

        if (fail) {
            await sock.sendMessage(
                chatId,
                buildPayload(`💼 *WORK* 💼\n──────────────\n❌ task failed\n😵 no earnings`, thumb),
                { quoted: message }
            );
            return;
        }

        const amount = randomReward();
        const job = randomItem(JOBS);
        const emoji = randomItem(EMOJIS);
        await addBalanceAtomic(senderId, amount, {
            force: true,
            source: 'work_reward',
            category: 'economy',
            actorJid: senderId
        });

        await sock.sendMessage(
            chatId,
            buildPayload(`💼 *WORK* 💼\n──────────────\n${emoji} ${job}\n💰 +$${amount}`, thumb),
            { quoted: message }
        );
    } catch (error) {
        console.error('[work] error:', error?.message || error);
        await sock.sendMessage(
            chatId,
            { text: 'Work failed. Try again in a moment.' },
            { quoted: message }
        );
    }
}





module.exports = {
  name: 'work',
  permissionLevel: 'sudo', // FIXED: central sudo permission
  async execute(ctx) {
    return workCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null);
  }
};
