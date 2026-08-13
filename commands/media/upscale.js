const NodeFormData = require('form-data');
const sharp = require('sharp');
const fetch = require('node-fetch');
const { getQuotedOrOwnImageBuffer, sendReaction } = require('../../lib/messageUtils');
const { uploadImage } = require('../../lib/uploadImage');

async function remini(imageBuffer, mode) {
    try {
        // Step 1: Try a modern 4k Upscale API first (Itzpire)
        try {
            const imageUrl = await uploadImage(imageBuffer).catch(() => null);
            if (imageUrl) {
                const apiRes = await fetch(`https://api.itzpire.com/ai/upscale?url=${encodeURIComponent(imageUrl)}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                const apiJson = await apiRes.json().catch(() => ({}));
                if (apiJson.status === 'success' && apiJson.result) {
                    const enhancedBuffer = await fetch(apiJson.result).then(r => r.buffer()).catch(() => null);
                    if (enhancedBuffer && enhancedBuffer.length > 1000) {
                        console.log('[upscale] Success using Itzpire 4k API');
                        return enhancedBuffer;
                    }
                }
            }
        } catch (apiError) {
            console.warn('[upscale] Itzpire API failed:', apiError.message);
        }

        // Step 2: Try legacy Vyro API fallback
        const validModes = ['enhance', 'recolor', 'dehaze'];
        if (!validModes.includes(mode)) mode = validModes[0];
        const form = new NodeFormData();
        form.append('model_version', 1, {
            'Content-Transfer-Encoding': 'binary',
            contentType: 'multipart/form-data; charset=utf-8'
        });
        form.append('image', Buffer.from(imageBuffer), {
            filename: 'enhance_image_body.jpg',
            contentType: 'image/jpeg'
        });

        const vyroResult = await new Promise((resolve) => {
            form.submit({
                url: `https://inferenceengine.vyro.ai/${mode}`,
                host: 'inferenceengine.vyro.ai',
                path: `/${mode}`,
                protocol: 'https:',
                headers: {
                    'User-Agent': 'okhttp/4.9.3',
                    Connection: 'Keep-Alive',
                    'Accept-Encoding': 'gzip'
                }
            }, (err, response) => {
                if (err || !response.headers['content-type']?.toLowerCase().includes('image')) return resolve(null);
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk)).on('end', () => resolve(Buffer.concat(chunks))).on('error', () => resolve(null));
            });
        });

        if (vyroResult && vyroResult.length > 1000) {
            console.log('[upscale] Success using Vyro API');
            return vyroResult;
        }
    } catch (err) {
        console.error('[upscale] API attempts failed:', err?.message || err);
    }

    throw new Error('All upscaling APIs failed. Please try again later.');
}

async function normalizeOutputImage(buffer) {
    if (!buffer?.length) throw new Error('Upscale generated an empty buffer');
    return sharp(Buffer.from(buffer), { limitInputPixels: false })
        .rotate()
        .jpeg({ quality: 95, mozjpeg: true })
        .toBuffer();
}

async function upscaleCommand(sock, chatId, message) {
    try {
        await sendReaction(sock, chatId, message, '🔄');
        const buffer = await getQuotedOrOwnImageBuffer(message);
        if (!buffer?.length) {
            await sendReaction(sock, chatId, message, '❌');
            await sock.sendMessage(chatId, { text: '❌ Reply to an image with `.upscale`' }, { quoted: message });
            return;
        }

        const image = await remini(buffer, 'enhance');
        const normalized = await normalizeOutputImage(image);

        await sock.sendMessage(chatId, { image: normalized }, { quoted: message });
        await sendReaction(sock, chatId, message, '✅');
    } catch (error) {
        console.error('[upscale] error:', error?.message || error);
        await sendReaction(sock, chatId, message, '❌');
        await sock.sendMessage(chatId, { text: `❌ Failed: ${error?.message || error}` }, { quoted: message });
    }
}

module.exports = {
    name: 'upscale',
    remini,
    upscaleCommand,
    async execute(ctx) {
        return upscaleCommand(ctx.sock, ctx.chatId, ctx.message);
    }
};
