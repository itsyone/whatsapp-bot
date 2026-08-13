const axios = require('axios');
const sharp = require('sharp');
const { PinterestHarvester } = require('../../lib/scrapers');
const { writeExifImg } = require('../../lib/exif');
const settings = require('../../settings');

function parsePintArgs(rawText = '') {
    const text = String(rawText || '').trim();
    const parts = text.split(/\s+/).filter(Boolean);
    const args = parts.slice(1);
    const stickerMode = args.includes('--sticker');
    const cleanArgs = args.filter((arg) => arg !== '--sticker');

    let count = 5;
    const last = cleanArgs[cleanArgs.length - 1];
    if (/^\d+$/.test(last || '')) {
        count = Math.max(1, Math.min(10, Number(last)));
        cleanArgs.pop();
    }

    return {
        query: cleanArgs.join(' ').trim(),
        count,
        stickerMode
    };
}

async function fetchBuffer(url) {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxContentLength: 8 * 1024 * 1024,
        headers: {
            'User-Agent': 'Mozilla/5.0',
            Referer: 'https://www.pinterest.com/'
        }
    });
    return Buffer.from(response.data);
}

async function imageToStickerBuffer(imageBuffer) {
    return sharp(imageBuffer, { limitInputPixels: false })
        .resize(512, 512, {
            fit: 'contain',
            background: { r: 255, g: 255, b: 255, alpha: 1 }
        })
        .webp({ quality: 70, effort: 4 })
        .toBuffer();
}

async function sendStickerResult(sock, chatId, message, imageUrl) {
    const imageBuffer = await fetchBuffer(imageUrl);
    const webpBuffer = await imageToStickerBuffer(imageBuffer);
    const stickerPath = await writeExifImg(webpBuffer, {
        packname: String(settings.packname || settings.botName || 'Sticker').trim() || 'Sticker',
        author: String(settings.author || 'Eclipse').trim() || 'Eclipse'
    });

    await sock.sendMessage(chatId, { sticker: { url: stickerPath } }, { quoted: message }); // FIXED: stable Pinterest sticker flow
}

async function sendPinterestAlbum(sock, chatId, message, pins = []) {
    const album = pins
        .map((pin) => pin?.image ? { image: { url: pin.image } } : null)
        .filter(Boolean);

    if (album.length >= 2) {
        await sock.sendMessage(chatId, { album }, { quoted: message });
        return;
    }

    if (album.length === 1) {
        await sock.sendMessage(chatId, album[0], { quoted: message });
    }
}

async function pintCommand(sock, chatId, message, overrideText = '') {
    const rawText = overrideText ||
        message?.message?.conversation ||
        message?.message?.extendedTextMessage?.text ||
        '';

    const { query, count, stickerMode } = parsePintArgs(rawText);

    if (!query) {
        await sock.sendMessage(chatId, {
            text: 'Usage: .pint <query> [count]\nUsage: .pint <query> --sticker'
        }, { quoted: message });
        return;
    }

    try {
        const results = await PinterestHarvester.search(query, stickerMode ? 1 : count);
        if (!Array.isArray(results) || results.length === 0) {
            await sock.sendMessage(chatId, { text: `No Pinterest results found for: ${query}` }, { quoted: message });
            return;
        }

        if (stickerMode) {
            await sendStickerResult(sock, chatId, message, results[0].image);
            return;
        }

        await sendPinterestAlbum(sock, chatId, message, results.slice(0, count));
    } catch (error) {
        console.error('[pint] command failed:', error?.message || error);
        await sock.sendMessage(chatId, { text: 'Failed to fetch Pinterest results.' }, { quoted: message });
    }
}

async function handlePinterestCarouselResponse() {
    return false; // FIXED: preserve expected export shape without broken carousel state
}

module.exports = {
    name: 'pint',
    execute: async (ctx) => pintCommand(ctx.sock, ctx.chatId, ctx.message, ctx.rawText),
    pintCommand,
    handlePinterestCarouselResponse
};
