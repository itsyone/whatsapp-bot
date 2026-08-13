const { PinterestHarvester } = require('../../lib/scrapers');
const axios = require('axios');
const fs = require('fs');
const sharp = require('sharp');
const { writeExifImg, writeExifVid } = require('../../lib/exif');
const settings = require('../../settings');

const CONFIG = {
    DEFAULT_COUNT: 5,
    MAX_COUNT: 15,
    MIN_COUNT: 1,
    PACK_COUNT: 50,
    PACK_ANIMATED_COUNT: 10,
    PACK_STATIC_COUNT: 40,
    PACK_IMAGE_WINDOW: 90,
    PACK_GIF_WINDOW: 60,
    PACK_CONCURRENCY: 10,
    PACK_ANIMATED_CONCURRENCY: 4,
    PACK_MAX_STICKER_BYTES: 900 * 1024,
    SEARCH_TIMEOUT: 15000,
    DOWNLOAD_TIMEOUT: 20000,
    TENOR_TIMEOUT: 12000,
    MAX_QUERY_LENGTH: 120,
    MAX_CAPTION_LENGTH: 60,
    SEND_DELAY: 350
};

const TENOR_API_KEY = 'AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ';
const processedMessages = new Set();

function getStickerMeta() {
    return {
        packname: String(settings.packname || settings.botName || 'Sticker').trim() || 'Sticker',
        author: String(settings.author || 'Eclipse').trim() || 'Eclipse'
    };
}

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function normalizeQuery(query) {
    return String(query || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, CONFIG.MAX_QUERY_LENGTH);
}

function parseArgs(rawText) {
    const text = String(rawText || '').trim();
    const parts = text.split(/\s+/);
    const args = parts.slice(1);
    const packMode = args.includes('-pack');
    const nameIndex = args.findIndex((arg) => arg === '-name');

    let packName = getStickerMeta().packname;
    let workingArgs = [...args];

    if (nameIndex !== -1) {
        const rawName = workingArgs.slice(nameIndex + 1).join(' ').trim();
        if (rawName) {
            packName = rawName.slice(0, 60);
        }
        workingArgs = workingArgs.slice(0, nameIndex);
    }

    const filteredArgs = workingArgs.filter((arg) => arg !== '-pack');

    let count = CONFIG.DEFAULT_COUNT;
    let queryArgs = [...filteredArgs];

    const lastArg = filteredArgs[filteredArgs.length - 1];
    if (/^\d+$/.test(lastArg || '')) {
        count = parseInt(lastArg, 10);
        queryArgs = filteredArgs.slice(0, -1);
    }

    count = packMode
        ? CONFIG.PACK_COUNT
        : Math.max(CONFIG.MIN_COUNT, Math.min(CONFIG.MAX_COUNT, count));

    return {
        query: normalizeQuery(queryArgs.join(' ')),
        count,
        packMode,
        packName
    };
}

function dedupeBy(items, keyFn) {
    const seen = new Set();
    const out = [];

    for (const item of items) {
        const key = keyFn(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }

    return out;
}

async function fetchPinterest(query) {
    try {
        const results = await PinterestHarvester.search(query, CONFIG.PACK_IMAGE_WINDOW);
        return results.map(item => ({
            image: item.image,
            caption: String(item.title || query).replace(/\s+/g, ' ').trim().slice(0, CONFIG.MAX_CAPTION_LENGTH)
        }));
    } catch (error) {
        console.error('Pinterest search in pint-s failed:', error.message);
        return [];
    }
}


async function downloadImageBuffer(url) {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: CONFIG.DOWNLOAD_TIMEOUT,
        maxContentLength: 8 * 1024 * 1024,
        validateStatus: (status) => status >= 200 && status < 400,
        headers: {
            'User-Agent': pickUA(),
            Referer: 'https://www.pinterest.com/',
            Origin: 'https://www.pinterest.com',
            Accept: 'image/webp,image/apng,image/*,*/*;q=0.8'
        }
    });

    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('image/')) {
        throw new Error(`Non-image response from ${url}`);
    }
    if (contentType.includes('heic') || contentType.includes('heif') || contentType.includes('avif')) {
        throw new Error(`Unsupported source format (${contentType})`);
    }

    const buffer = Buffer.from(response.data);
    if (!buffer.length) {
        throw new Error('Empty image buffer');
    }

    return buffer;
}

async function convertStaticToSticker(buffer) {
    const img = sharp(buffer, { limitInputPixels: false });
    const meta = await img.metadata();

    if (!meta.width || !meta.height) {
        throw new Error('Invalid image metadata');
    }

    try {
        const size = Math.min(meta.width, meta.height);
        const left = Math.max(0, Math.floor((meta.width - size) / 2));
        const top = Math.max(0, Math.floor((meta.height - size) / 2));

        return await sharp(buffer, { limitInputPixels: false })
            .extract({ left, top, width: size, height: size })
            .resize(512, 512, { fit: 'cover', kernel: sharp.kernel.lanczos2 })
            .webp({ quality: 60, effort: 4 })
            .toBuffer();
    } catch {
        return await sharp(buffer, { limitInputPixels: false })
            .resize(512, 512, {
                fit: 'contain',
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            })
            .webp({ quality: 55, effort: 4 })
            .toBuffer();
    }
}

async function buildStaticPackEntry(buffer, customPackName) {
    const meta = getStickerMeta();
    const webpPath = await writeExifImg(buffer, {
        packname: customPackName || meta.packname,
        author: meta.author
    });

    const size = fs.statSync(webpPath).size;
    if (size > CONFIG.PACK_MAX_STICKER_BYTES) {
        try {
            fs.unlinkSync(webpPath);
        } catch {}
        return null;
    }

    return {
        data: { url: webpPath }
    };
}

async function buildAnimatedPackEntry(buffer, customPackName) {
    const meta = getStickerMeta();
    const webpPath = await writeExifVid(buffer, {
        packname: customPackName || meta.packname,
        author: meta.author
    });

    const size = fs.statSync(webpPath).size;
    if (size > CONFIG.PACK_MAX_STICKER_BYTES) {
        try {
            fs.unlinkSync(webpPath);
        } catch {}
        return null;
    }

    return {
        data: { url: webpPath }
    };
}

class TenorScraper {
    extractMedia(items, limit) {
        const results = [];

        for (const item of items) {
            if (results.length >= limit) break;

            const media = item?.media_formats || item?.media || {};
            const url = media.mp4?.url || media.gif?.url || media.tinygif?.url || media.mediumgif?.url || media.nanogif?.url;

            if (!url) continue;

            results.push({
                url: url.startsWith('http') ? url : `https:${url}`,
                type: url.includes('.mp4') ? 'mp4' : 'gif'
            });
        }

        return results;
    }

    async scrapeApi(query, limit) {
        const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&key=${TENOR_API_KEY}&limit=${limit + 5}&media_filter=gif,mp4`;
        const { data } = await axios.get(url, {
            timeout: CONFIG.TENOR_TIMEOUT,
            headers: { 'User-Agent': pickUA() }
        });

        return this.extractMedia(data?.results || [], limit);
    }

    async scrapeNextData(query, limit) {
        const url = `https://tenor.com/search/${encodeURIComponent(query).replace(/%20/g, '-')}-gifs`;
        const { data } = await axios.get(url, {
            timeout: CONFIG.TENOR_TIMEOUT,
            headers: {
                'User-Agent': pickUA(),
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });

        const match = data.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s);
        if (!match) return [];

        const json = JSON.parse(match[1]);
        const results = json?.props?.pageProps?.results || json?.props?.pageProps?.searchResults || [];
        return this.extractMedia(results, limit);
    }

    async scrapeMobile(query, limit) {
        const url = `https://tenor.com/search/${encodeURIComponent(query)}-gifs`;
        const { data } = await axios.get(url, {
            timeout: CONFIG.TENOR_TIMEOUT,
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15'
            }
        });

        const matches = data.match(/https:\/\/media\.tenor\.com\/[^"'\s]+?\.(gif|mp4)/gi) || [];
        const unique = [...new Set(matches)];

        return unique.slice(0, limit).map((url) => ({
            url,
            type: url.endsWith('.mp4') ? 'mp4' : 'gif'
        }));
    }

    async search(query, limit = 5) {
        const methods = [
            () => this.scrapeApi(query, limit),
            () => this.scrapeNextData(query, limit),
            () => this.scrapeMobile(query, limit)
        ];

        for (const method of methods) {
            try {
                const results = await method();
                if (results?.length) return results;
            } catch {}
        }

        return [];
    }

    async download(url) {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'arraybuffer',
            timeout: CONFIG.DOWNLOAD_TIMEOUT,
            maxContentLength: 15 * 1024 * 1024,
            maxBodyLength: 15 * 1024 * 1024,
            validateStatus: (status) => status >= 200 && status < 400,
            headers: {
                'User-Agent': pickUA(),
                Accept: '*/*'
            }
        });

        const buffer = Buffer.from(response.data);
        if (!buffer.length) {
            throw new Error('Empty animated buffer');
        }

        return buffer;
    }
}

const tenorScraper = new TenorScraper();

async function collectStaticPackEntries(items, wanted, packName, startIndex = 0) {
    const targets = items.slice(startIndex, startIndex + CONFIG.PACK_IMAGE_WINDOW);
    const packEntries = [];
    const tempFiles = [];

    for (let i = 0; i < targets.length && packEntries.length < wanted; i += CONFIG.PACK_CONCURRENCY) {
        const batch = targets.slice(i, i + CONFIG.PACK_CONCURRENCY);
        const built = await Promise.all(batch.map(async (item) => {
            try {
                const image = await downloadImageBuffer(item.image);
                const sticker = await convertStaticToSticker(image);
                return await buildStaticPackEntry(sticker, packName);
            } catch (error) {
                console.warn('[pint-s] static build failed:', error?.message || error);
                return null;
            }
        }));

        for (const entry of built) {
            if (!entry) continue;
            packEntries.push(entry);
            tempFiles.push(entry.data.url);
            if (packEntries.length >= wanted) break;
        }
    }

    return {
        packEntries,
        tempFiles,
        nextIndex: startIndex + targets.length
    };
}

async function collectAnimatedPackEntries(query, wanted, packName) {
    const media = await tenorScraper.search(query, CONFIG.PACK_GIF_WINDOW);
    const targets = dedupeBy(media, (item) => item.url).slice(0, CONFIG.PACK_GIF_WINDOW);
    const packEntries = [];
    const tempFiles = [];

    for (let i = 0; i < targets.length && packEntries.length < wanted; i += CONFIG.PACK_ANIMATED_CONCURRENCY) {
        const batch = targets.slice(i, i + CONFIG.PACK_ANIMATED_CONCURRENCY);
        const built = await Promise.all(batch.map(async (item) => {
            try {
                const buffer = await tenorScraper.download(item.url);
                return await buildAnimatedPackEntry(buffer, packName);
            } catch (error) {
                console.warn('[pint-s] animated build failed:', error?.message || error);
                return null;
            }
        }));

        for (const entry of built) {
            if (!entry) continue;
            packEntries.push(entry);
            tempFiles.push(entry.data.url);
            if (packEntries.length >= wanted) break;
        }
    }

    return { packEntries, tempFiles };
}

async function pintStickerCommand(sock, chatId, message, rawText) {
    try {
        const messageId = message?.key?.id;
        if (messageId && processedMessages.has(messageId)) return;

        if (messageId) {
            processedMessages.add(messageId);
            setTimeout(() => processedMessages.delete(messageId), 5 * 60 * 1000);
        }

        const { query, count, packMode, packName } = parseArgs(rawText);

        if (!query) {
            await sock.sendMessage(chatId, {
                text: `Usage: .pint-s <query> [count]\n.pint-s <query> -pack`
            }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, {
            react: {
                text: '⏳',
                key: message.key
            }
        });

        if (packMode) {
            const staticItems = await fetchPinterest(query);
            const [animated, statics] = await Promise.all([
                collectAnimatedPackEntries(query, CONFIG.PACK_ANIMATED_COUNT, packName),
                collectStaticPackEntries(staticItems, CONFIG.PACK_STATIC_COUNT, packName)
            ]);

            let stickers = [...animated.packEntries, ...statics.packEntries].filter(Boolean);
            let tempFiles = [...animated.tempFiles, ...statics.tempFiles];

            if (stickers.length < CONFIG.PACK_COUNT && staticItems.length > statics.nextIndex) {
                const refill = await collectStaticPackEntries(
                    staticItems,
                    CONFIG.PACK_COUNT - stickers.length,
                    packName,
                    statics.nextIndex
                );
                stickers = [...stickers, ...refill.packEntries].filter(Boolean);
                tempFiles = [...tempFiles, ...refill.tempFiles];
            }

            if (!stickers.length) {
                await sock.sendMessage(chatId, {
                    text: 'Could not prepare the sticker pack.'
                }, { quoted: message });
                return;
            }

            try {
                const meta = getStickerMeta();
                await sock.sendMessage(chatId, {
                    cover: stickers[0].data,
                    stickers,
                    name: packName || meta.packname,
                    publisher: meta.author,
                    description: query
                }, { quoted: message });
            } finally {
                for (const file of tempFiles) {
                    try {
                        fs.unlinkSync(file);
                    } catch {}
                }
            }

            await sock.sendMessage(chatId, {
                react: {
                    text: "",
                    key: message.key
                }
            });
            return;
        }

        const items = await fetchPinterest(query);
        if (!items.length) {
            await sock.sendMessage(chatId, {
                text: 'No Pinterest images found.'
            }, { quoted: message });
            return;
        }

        const prepared = await Promise.all(
            items.slice(0, count * 2).map(async (item) => {
                try {
                    const image = await downloadImageBuffer(item.image);
                    return await convertStaticToSticker(image);
                } catch (error) {
                    console.warn('[pint-s] send failed:', error?.message || error);
                    return null;
                }
            })
        );

        let sent = 0;
        for (const sticker of prepared) {
            if (!sticker) continue;
            await sock.sendMessage(chatId, { sticker }, { quoted: message });
            sent += 1;
            if (sent >= count) break;
            await sleep(CONFIG.SEND_DELAY);
        }

        await sock.sendMessage(chatId, {
            react: {
                text: "",
                key: message.key
            }
        });
    } catch (error) {
        console.error('[pint-s] fatal error:', error?.message || error);

        try {
            await sock.sendMessage(chatId, {
                text: 'Something went wrong while making Pinterest stickers.'
            }, { quoted: message });

            await sock.sendMessage(chatId, {
                react: {
                    text: '❌',
                    key: message.key
                }
            });
        } catch {}
    }
}





module.exports = {
  name: 'pint-s',
  async execute(ctx) {
    return pintStickerCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.rawText || null);
  }
};
