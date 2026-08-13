const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');
const sharp = require('sharp');
const { Tools } = require('abot-scraper');
const { downloadContentFromMessage } = require('../../lib/baileys');
const { writeExifImg } = require('../../lib/exif');

const tools = new Tools();

function generateClientId(length = 40) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id = '';
    for (let i = 0; i < length; i += 1) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
}

async function downloadMessageBuffer(messageNode, mediaType) {
    const stream = await downloadContentFromMessage(messageNode, mediaType);
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function getQuotedMessage(message) {
    return message.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;
}

function extractTargetMedia(message) {
    const quoted = getQuotedMessage(message);
    const direct = message.message || {};

    if (quoted?.stickerMessage) return { node: quoted.stickerMessage, mediaType: 'sticker', output: 'sticker' };
    if (quoted?.imageMessage) return { node: quoted.imageMessage, mediaType: 'image', output: 'image' };
    if (direct?.stickerMessage) return { node: direct.stickerMessage, mediaType: 'sticker', output: 'sticker' };
    if (direct?.imageMessage) return { node: direct.imageMessage, mediaType: 'image', output: 'image' };
    return null;
}

async function normalizeForMagicStudio(buffer) {
    return sharp(buffer, { animated: false, limitInputPixels: false })
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();
}

async function callMagicStudio(buffer) {
    const dataUri = `data:image/jpeg;base64,${buffer.toString('base64')}`;
    const formData = new FormData();
    formData.append('image', dataUri);
    formData.append('output_type', 'image');
    formData.append('output_format', 'url');
    formData.append('auto_delete_data', 'true');
    formData.append('user_profile_id', 'null');
    formData.append('anonymous_user_id', crypto.randomUUID());
    formData.append('request_timestamp', (Date.now() / 1000).toFixed(3));
    formData.append('user_is_subscribed', 'false');
    formData.append('client_id', generateClientId());

    const response = await axios.request({
        method: 'POST',
        url: 'https://ai-api.magicstudio.com/api/remove-background',
        headers: {
            ...formData.getHeaders(),
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36',
            Accept: 'application/json, text/plain, */*',
            origin: 'https://magicstudio.com',
            referer: 'https://magicstudio.com/background-remover/editor/'
        },
        data: formData,
        timeout: 60000
    });

    const resultImageUrl = response.data?.results?.[0]?.image;
    if (!resultImageUrl) {
        throw new Error('Magic Studio did not return a result image');
    }

    const imageResponse = await axios.get(resultImageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000
    });

    return Buffer.from(imageResponse.data);
}

async function downloadBufferFromUrl(url) {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
            'User-Agent': 'Mozilla/5.0'
        }
    });

    return Buffer.from(response.data);
}

async function callSlazzer(buffer) {
    const formData = new FormData();
    formData.append('source_image_file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });

    const response = await axios.post('https://api.slazzer.com/v2.0/remove_background', formData, {
        headers: {
            ...formData.getHeaders(),
            'X-API-KEY': 'slazzer-free-key'  // Slazzer has a free tier
        },
        timeout: 60000
    });

    if (!response.data?.processed_image) {
        throw new Error('Slazzer did not return a processed image');
    }

    const imageResponse = await axios.get(response.data.processed_image, {
        responseType: 'arraybuffer',
        timeout: 30000
    });

    return Buffer.from(imageResponse.data);
}

async function callRebix(buffer) {
    return callSlazzer(buffer);
}

async function callEzRemove(buffer) {
    const result = await tools.removeBackground(buffer);
    const imageUrl = result?.result?.image_url || result?.image_url || result?.url ||
        (typeof result?.result === 'string' ? result.result : null) || '';
    if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.startsWith('http')) {
        throw new Error(`EZ Remove failed: ${JSON.stringify(result)}`);
    }
    return downloadBufferFromUrl(imageUrl);
}

module.exports = {
    name: 'removebg',
    alias: ['rmbg', 'nobg', 'bgrem', 'bg'],
    category: 'tools',
    desc: 'Remove background from replied image or sticker',

    async exec(sock, message, profile) {
        const chatId = message.key.remoteJid;
        let stickerPath = '';

        try {
            const target = extractTargetMedia(message);
            if (!target) {
                await sock.sendMessage(chatId, {
                    text: 'Reply to an image or sticker with `.removebg`, `.bgrem`, or `.bg`.'
                }, { quoted: message });
                return;
            }

            await sock.sendMessage(chatId, { text: 'Removing background...' }, { quoted: message });

            const sourceBuffer = await downloadMessageBuffer(target.node, target.mediaType);
            if (!sourceBuffer?.length) {
                throw new Error('Could not download the source media');
            }

            const normalizedBuffer = await normalizeForMagicStudio(sourceBuffer);
            let resultBuffer = null;
            let lastError = null;

            for (const [index, worker] of [callEzRemove, callMagicStudio, callRebix].entries()) {
                try {
                    console.log(`[removebg] Trying provider ${index === 0 ? 'EZ Remove' : index === 1 ? 'MagicStudio' : 'Rebix'}...`);
                    resultBuffer = await worker(normalizedBuffer);
                    if (resultBuffer?.length) {
                        console.log(`[removebg] Success with provider ${index === 0 ? 'EZ Remove' : index === 1 ? 'MagicStudio' : 'Rebix'}`);
                        break;
                    }
                } catch (error) {
                    lastError = error;
                    console.error(`[removebg] Provider ${index === 0 ? 'EZ Remove' : index === 1 ? 'MagicStudio' : 'Rebix'} failed:`, error.message);
                }
            }

            if (!resultBuffer?.length) {
                throw lastError || new Error('No background removal provider returned an image');
            }

            if (target.output === 'sticker') {
                stickerPath = await writeExifImg(resultBuffer, {
                    packname: profile?.packname || 'Bot Sticker',
                    author: profile?.author || 'Eclipse'
                });
                await sock.sendMessage(chatId, { sticker: { url: stickerPath } }, { quoted: message });
            } else {
                await sock.sendMessage(chatId, {
                    image: resultBuffer,
                    caption: 'Background removed successfully.'
                }, { quoted: message });
            }
        } catch (error) {
            console.error('removeBgCommand error:', error.response?.data || error.message || error);

            let text = 'Failed to remove background. Try again.';
            if (error.response?.status === 429) text = 'Rate limit hit. Try again in a moment.';
            else if (error.code === 'ECONNABORTED') text = 'Request timed out. Try again.';
            else if (error.message) text = `Failed to remove background: ${String(error.message).slice(0, 180)}`;

            await sock.sendMessage(chatId, { text }, { quoted: message });
        } finally {
            if (stickerPath) {
                try {
                    const fs = require('fs');
                    if (fs.existsSync(stickerPath)) fs.unlinkSync(stickerPath);
                } catch {}
            }
        }
    },

    async execute(ctx) {
        return module.exports.exec(ctx.sock || null, ctx.message || null, ctx.profile || null);
    }
};
