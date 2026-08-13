const axios = require('axios');
const cheerio = require('cheerio');
const sharp = require('sharp');

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'application/json, image/*, */*'
};

const SEARCH_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const COMMANDS = {
    waifu: {
        label: 'waifu',
        providers: [
            async () => {
                const res = await axios.get('https://api.waifu.pics/sfw/waifu', {
                    timeout: 15000,
                    headers: COMMON_HEADERS
                });
                return res?.data?.url || '';
            },
            async () => {
                const res = await axios.get('https://nekos.best/api/v2/waifu', {
                    timeout: 15000,
                    headers: { 'User-Agent': 'MikuBot/1.0', Accept: 'application/json' }
                });
                return res?.data?.results?.[0]?.url || '';
            },
            async () => 'https://api-rebix.vercel.app/api/waifu'
        ]
    },
    neko: {
        label: 'neko',
        providers: [
            async () => {
                const res = await axios.get('https://api.waifu.pics/sfw/neko', {
                    timeout: 15000,
                    headers: COMMON_HEADERS
                });
                return res?.data?.url || '';
            },
            async () => {
                const res = await axios.get('https://nekos.best/api/v2/neko', {
                    timeout: 15000,
                    headers: { 'User-Agent': 'MikuBot/1.0', Accept: 'application/json' }
                });
                return res?.data?.results?.[0]?.url || '';
            },
            async () => 'https://api-rebix.vercel.app/api/waifu?type=neko'
        ]
    },
    maid: {
        label: 'maid',
        providers: [
            async () => searchBingImages('anime maid girl'),
            async () => searchBingImages('cute anime maid')
        ]
    },
    'raiden-shogun': {
        label: 'raiden-shogun',
        providers: [
            async () => searchBingImages('Raiden Shogun Genshin Impact anime'),
            async () => searchBingImages('Raiden Shogun official art')
        ]
    },
    selfies: {
        label: 'selfies',
        providers: [
            async () => searchBingImages('anime girl selfie'),
            async () => searchBingImages('anime selfie art')
        ]
    },
    uniform: {
        label: 'uniform',
        providers: [
            async () => searchBingImages('anime school uniform girl'),
            async () => searchBingImages('anime uniform art')
        ]
    },
    'kamisato-ayaka': {
        label: 'kamisato-ayaka',
        providers: [
            async () => searchBingImages('Kamisato Ayaka Genshin Impact anime'),
            async () => searchBingImages('Kamisato Ayaka official art')
        ]
    }
};

function extractCommandName(rawText) {
    const match = String(rawText || '').trim().toLowerCase().match(/^\.(\S+)/);
    return match?.[1] || '';
}

function isImageUrl(url) {
    const value = String(url || '').trim();
    if (!/^https?:\/\//i.test(value)) return false;
    if (/\.svg(?:$|\?)/i.test(value)) return false;
    if (/logo|icon|avatar|sprite/i.test(value)) return false;
    return true;
}

async function searchBingImages(query) {
    const response = await axios.get(
        `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC3&first=1`,
        {
            timeout: 15000,
            headers: SEARCH_HEADERS
        }
    );

    const $ = cheerio.load(response.data);
    const candidates = [];

    $('a.iusc').each((_, element) => {
        const raw = $(element).attr('m');
        if (!raw) return;

        try {
            const data = JSON.parse(raw);
            const directUrl = String(data.murl || '').trim();
            const title = String(data.t || data.tt || '').toLowerCase();
            if (!isImageUrl(directUrl)) return;
            if (/logo|icon|avatar|sprite/.test(title)) return;
            candidates.push(directUrl);
        } catch (_) {
            return;
        }
    });

    const unique = Array.from(new Set(candidates));
    if (!unique.length) {
        throw new Error(`No image results for query: ${query}`);
    }

    return unique.slice(0, 6);
}

async function normalizeImageBuffer(inputBuffer) {
    const meta = await sharp(inputBuffer, { limitInputPixels: false }).metadata();
    if (!meta.width || !meta.height) {
        throw new Error('Invalid image metadata');
    }

    return sharp(inputBuffer, { limitInputPixels: false })
        .resize({
            width: meta.width > 1600 ? 1600 : undefined,
            height: meta.height > 1600 ? 1600 : undefined,
            fit: 'inside',
            withoutEnlargement: true
        })
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer();
}

async function fetchImageBuffer(url) {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 20000,
        maxContentLength: MAX_IMAGE_BYTES,
        maxBodyLength: MAX_IMAGE_BYTES,
        headers: COMMON_HEADERS
    });

    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    if (contentType && !contentType.startsWith('image/')) {
        throw new Error('Remote URL is not an image');
    }

    const inputBuffer = Buffer.from(response.data);
    if (!inputBuffer.length) {
        throw new Error('Empty image buffer');
    }

    return normalizeImageBuffer(inputBuffer);
}

async function resolveImageBuffer(config) {
    const providers = Array.isArray(config?.providers) ? config.providers : [];
    let lastError = null;

    for (const provider of providers) {
        try {
            const result = await provider();
            const urls = Array.isArray(result) ? result : [result];

            for (const url of urls) {
                if (!url || !/^https?:\/\//i.test(String(url))) continue;
                try {
                    return await fetchImageBuffer(String(url));
                } catch (error) {
                    lastError = error;
                }
            }
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('No image URL resolved');
}

async function animeSfwCommand(sock, chatId, message, rawText) {
    const commandName = extractCommandName(rawText);
    const config = COMMANDS[commandName];

    if (!config) {
        await sock.sendMessage(
            chatId,
            { text: 'Available commands: .waifu, .neko, .maid, .raiden-shogun, .selfies, .uniform, .kamisato-ayaka' },
            { quoted: message }
        );
        return;
    }

    try {
        const imageBuffer = await resolveImageBuffer(config);
        await sock.sendMessage(
            chatId,
            {
                image: imageBuffer,
                caption: config.label
            },
            { quoted: message }
        );
    } catch (error) {
        console.error(`[anime-sfw] ${commandName} failed:`, error?.message || error);
        await sock.sendMessage(
            chatId,
            { text: `Failed to fetch ${config.label} image. Try again in a moment.` },
            { quoted: message }
        );
    }
}





module.exports = Object.keys(COMMANDS).map(name => ({
  name,
  async execute(ctx) {
    return animeSfwCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.rawText || null);
  }
}));
