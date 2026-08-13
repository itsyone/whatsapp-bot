const https = require('https');

const IMAGE_URL = 'https://files.catbox.moe/daqzsy.png';
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
    if (!thumbCache) thumbCache = await fetchBuffer(IMAGE_URL).catch(() => null);
    return thumbCache;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendProbe(sock, chatId, message, label, payload) {
    await sock.sendMessage(chatId, payload, { quoted: message });
    await delay(350);
    return label;
}

async function thumbtestCommand(sock, chatId, message) {
    try {
        const thumb = await getThumb();
        if (!thumb) {
            await sock.sendMessage(chatId, { text: 'thumbtest failed to load image buffer' }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, {
            text: [
                '*THUMB PROBE START*',
                'You should receive 4 replies after this.',
                'Reply with which numbers showed on phone.'
            ].join('\n')
        }, { quoted: message });

        const delivered = [];

        delivered.push(await sendProbe(sock, chatId, message, '1', {
            text: 'thumb probe 1\nnested contextInfo.externalAdReply',
            contextInfo: {
                externalAdReply: {
                    title: 'PROBE 1',
                    body: 'nested contextInfo',
                    mediaType: 1,
                    showAdAttribution: false,
                    renderLargerThumbnail: false,
                    thumbnail: thumb
                }
            }
        }));

        delivered.push(await sendProbe(sock, chatId, message, '2', {
            text: 'thumb probe 2\ntop-level externalAdReply',
            externalAdReply: {
                title: 'PROBE 2',
                body: 'top-level externalAdReply',
                mediaType: 1,
                showAdAttribution: false,
                largeThumbnail: false,
                thumbnail: thumb
            }
        }));

        delivered.push(await sendProbe(sock, chatId, message, '3', {
            text: 'thumb probe 3\nnested with thumbnailUrl fallback',
            contextInfo: {
                externalAdReply: {
                    title: 'PROBE 3',
                    body: 'nested with thumbnailUrl',
                    mediaType: 1,
                    showAdAttribution: false,
                    renderLargerThumbnail: false,
                    thumbnail,
                    thumbnailUrl: IMAGE_URL
                }
            }
        }));

        delivered.push(await sendProbe(sock, chatId, message, '4', {
            image: thumb,
            caption: 'thumb probe 4\nplain image sanity check'
        }));

        await sock.sendMessage(chatId, {
            text: `thumb probe sent: ${delivered.join(', ')}\nReply with what appeared on phone.`
        }, { quoted: message });
    } catch (error) {
        console.error('[thumbtest] error:', error?.message || error);
        await sock.sendMessage(chatId, { text: 'thumbtest failed' }, { quoted: message });
    }
}

module.exports = {
    name: 'thumbtest',
    alias: ['thumbprobe', 'tprobe'],
    async execute(ctx) {
        return thumbtestCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
    }
};
