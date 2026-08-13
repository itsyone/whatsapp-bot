const axios = require('axios');
const fs = require('fs');
const sharp = require('sharp');
const path = require('path');
const { writeExifImg, writeExifVid, writeExif } = require('../../lib/exif');
const { createSession, deleteSession, getSession } = require('../../lib/gameSessions');
const settings = require('../../settings');

const cheerio = require('cheerio');

// getstickerpack.com Scraper Logic (Optimized for Wistoria)
class GetStickerPack {
    async search(query) {
        try {
            if (!query) throw new Error('Query is required.');
            const { data } = await axios.get(`https://getstickerpack.com/stickers?query=${encodeURIComponent(query)}`);
            const $ = cheerio.load(data);
            const results = [];
            
            $('#stickerPacks > div > div:nth-child(3) > div > a').each((i, el) => {
                const url = $(el).attr('href');
                const name = $(el).find('h5').text().trim() || url.split('/').pop().replace(/-/g, ' ');
                const badge = $(el).find('.badge').text().trim();
                const isAnimated = badge === 'ANIMATED' || badge.toLowerCase().includes('animated');
                const stickerCount = $(el).find('.sticker-count').text().trim() || '?';
                
                results.push({ 
                    name, 
                    url, 
                    author: 'Community',
                    stickerCount, 
                    isAnimated 
                });
            });

            console.log(`[GetStickerPack] Found ${results.length} packs for "${query}"`);
            return results;
        } catch (error) {
            console.error('[GetStickerPack] Search error:', error.message);
            return [];
        }
    }

    async detail(url) {
        try {
            const { data } = await axios.get(url);
            const $ = cheerio.load(data);
            const stickers = [];
            
            $('#stickerPack > div > div.row > div > img').each((i, el) => {
                const src = $(el).attr('src');
                if (src) {
                    // Detect if sticker is animated by checking file extension or data URL
                    const isAnimated = src.includes('.gif') || src.includes('tgs') || src.includes('animated');
                    stickers.push({
                        imageUrl: src.split('&d=')[0],
                        isAnimated 
                    });
                }
            });

            return {
                name: $('#intro > div > div > h1').text().trim(),
                author: $('#intro > div > div > h5 > a').text().trim() || 'Unknown',
                stickers
            };
        } catch (error) {
            throw new Error(`Failed to fetch pack details: ${error.message}`);
        }
    }
}

const stickerScraper = new GetStickerPack();

const CONFIG = {
    SESSION_TIMEOUT: 120000,
    MAX_PACK_LIMIT: 200,
    DOWNLOAD_TIMEOUT: 30000,
    CONCURRENCY: 10,
    SEND_DELAY: 350,
    MAX_STICKER_BYTES: 900 * 1024,
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const Crypto = require('crypto');
const webp = require('node-webpmux');

async function downloadAndProcessSticker(stick, meta) {
    const PROJECT_TMP = path.join(process.cwd(), 'tmp');
    try {
        if (!fs.existsSync(PROJECT_TMP)) {
            fs.mkdirSync(PROJECT_TMP, { recursive: true, mode: 0o777 });
        } else {
            fs.chmodSync(PROJECT_TMP, 0o777); // Ensure it's writable
        }
    } catch {}

    const getTmpPath = (ext = '') => path.join(PROJECT_TMP, `${Crypto.randomBytes(4).readUIntLE(0, 4).toString(36)}${ext}`);

    try {
        const response = await axios.get(stick.imageUrl, {
            responseType: 'arraybuffer',
            timeout: CONFIG.DOWNLOAD_TIMEOUT,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const buffer = Buffer.from(response.data);

        if (!stick.isAnimated) {
            const stickerBuffer = await sharp(buffer, { limitInputPixels: false })
                .resize(512, 512, {
                    fit: 'contain',
                    background: { r: 0, g: 0, b: 0, alpha: 0 }
                })
                .webp({ quality: 78, effort: 4 })
                .toBuffer();
            const webpPath = await writeExifImg(stickerBuffer, {
                packname: meta.packname || 'Wistoria',
                author: meta.author || 'Wistoria'
            });
            
            // Check size limit
            const size = fs.statSync(webpPath).size;
            if (size > CONFIG.MAX_STICKER_BYTES) {
                try {
                    fs.unlinkSync(webpPath);
                } catch {}
                console.error(`[sticker-search] Sticker exceeds size limit: ${size} bytes`);
                return null;
            }
            
            return webpPath;
        }

        const tmpFileIn = getTmpPath(stick.isAnimated ? '.mp4' : '.png');
        const tmpFileOut = getTmpPath('.webp');
        const finalFile = getTmpPath('.webp');
        
        fs.writeFileSync(tmpFileIn, buffer);

        const ffmpegStatic = require('ffmpeg-static');
        const ff = require('fluent-ffmpeg');
        ff.setFfmpegPath(ffmpegStatic);

        await new Promise((resolve, reject) => {
            let cmd = ff(tmpFileIn)
                .on('start', (cmdLine) => console.log('[FFMPEG CMD]', cmdLine))
                .on('error', (err) => {
                    console.error('[FFMPEG DEBUG]', err.message);
                    reject(err);
                })
                .on('end', () => resolve(true));

            if (stick.isAnimated) {
                cmd.outputOptions([
                    "-vcodec", "libwebp",
                    "-vf", "scale=320:320:force_original_aspect_ratio=increase,crop=320:320",
                    "-loop", "0",
                    "-preset", "default",
                    "-an"
                ]);
            } else {
                cmd.outputOptions([
                    "-vcodec", "libwebp",
                    "-vf", "scale='min(320,iw)':min(320,ih):force_original_aspect_ratio=decrease,pad=320:320:(320-iw)/2:(320-ih)/2:color=white@0.0"
                ]);
            }
            cmd.toFormat('webp').save(tmpFileOut);
        });

        // Write EXIF
        const img = new webp.Image();
        const json = { 
            "sticker-pack-id": "wistoria-pack", 
            "sticker-pack-name": meta.packname || "Wistoria", 
            "sticker-pack-publisher": meta.author || "Wistoria" 
        };
        const exifAttr = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
        const jsonBuff = Buffer.from(JSON.stringify(json), "utf-8");
        const exif = Buffer.concat([exifAttr, jsonBuff]);
        exif.writeUIntLE(jsonBuff.length, 14, 4);
        
        await img.load(tmpFileOut);
        img.exif = exif;
        await img.save(finalFile);

        // Check size limit
        const size = fs.statSync(finalFile).size;
        if (size > CONFIG.MAX_STICKER_BYTES) {
            try {
                fs.unlinkSync(finalFile);
            } catch {}
            console.error(`[sticker-search] Animated sticker exceeds size limit: ${size} bytes`);
            return null;
        }

        // Cleanup intermediate files
        [tmpFileIn, tmpFileOut].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });

        return finalFile;
    } catch (err) {
        console.error('[sticker-search] item error:', err.message);
        return null;
    }
}

function getBotMetadata(profile) {
    const name = String(profile?.botName || profile?.name || '').toLowerCase();
    if (name.includes('haimiya') || name.includes('hamiya') || name.includes('haumiya')) {
        return { packname: 'haimiya-senpai', author: 'wistoria' };
    } else if (name.includes('ryo')) {
        return { packname: 'ryo yamada', author: 'wistoria' };
    }
    return {
        packname: settings.packname || 'Wistoria Stickers',
        author: settings.author || 'Wistoria'
    };
}

module.exports = {
    name: 'sticker-search',
    alias: ['stickersearch', 'sticker-s'],
    async execute(ctx) {
        const { sock, chatId, message, args, profile } = ctx;
        const query = args?.join(' ') || '';

        if (!query) {
            return sock.sendMessage(chatId, { text: 'Please provide a search query.\nExample: .sticker-search uma musume' }, { quoted: message });
        }

        const existing = getSession(chatId);
        if (existing && existing.type === 'sticker-search') {
            return sock.sendMessage(chatId, { text: 'Please complete your current search or wait for it to expire.' }, { quoted: message });
        }

        try {
            const results = await stickerScraper.search(query);
            if (!results.length) {
                return sock.sendMessage(chatId, { text: 'No sticker packs found for that query.' }, { quoted: message });
            }

            const options = results.slice(0, 100);
            const emojis = ['🎨', '🌟', '✨', '💫', '🎭', '🎪', '🎬', '🎯', '🎲', '🎁'];
            let responseText = `✨ *Sticker Search: ${query}*\n\n`;
            options.forEach((pack, i) => {
                const emoji = emojis[i % emojis.length];
                const type = pack.isAnimated ? '🎬 Animated' : '🖼️ Static';
                responseText += `${emoji}  *${pack.name}*\n   ${type} • ${pack.stickerCount} stickers\n\n`;
            });
            responseText += `💡 Reply with the emoji to get the pack!`;

            const session = {
                type: 'sticker-search',
                query,
                options,
                meta: getBotMetadata(profile),
                startTime: Date.now(),
                async onMessage(sock, msg, senderId, textInput) {
                    const emojis = ['🎨', '🌟', '✨', '💫', '🎭', '🎪', '🎬', '🎯', '🎲', '🎁'];
                    const input = textInput.trim();
                    
                    // Check for emoji input
                    let choice = emojis.indexOf(input);
                    if (choice === -1) {
                        // Fallback to number input
                        choice = parseInt(input) - 1;
                    }
                    
                    if (isNaN(choice) || choice < 0 || choice >= options.length) return false;

                    // Delete the list message as requested
                    if (this.listMsgKey) {
                        await sock.sendMessage(chatId, { delete: this.listMsgKey }).catch(() => null);
                    }

                    const selectedPack = options[choice];
                    const fetchMsg = await sock.sendMessage(chatId, { text: `📦 *Fetching "${selectedPack.name}"...*\nThis might take a moment, so go ahead and drink some water while you wait..` }, { quoted: msg });

                    try {
                        const detail = await stickerScraper.detail(selectedPack.url);
                        const toProcess = detail.stickers.slice(0, CONFIG.MAX_PACK_LIMIT);
                        const tempFiles = [];
                        const finalStickers = [];

                        try {
                            // Process in batches for performance
                            for (let i = 0; i < toProcess.length; i += CONFIG.CONCURRENCY) {
                                const batch = toProcess.slice(i, i + CONFIG.CONCURRENCY);
                                const results = await Promise.all(batch.map(s => downloadAndProcessSticker(s, session.meta)));

                                results.forEach(p => {
                                    if (p) {
                                        tempFiles.push(p);
                                        finalStickers.push({ data: { url: p } });
                                    }
                                });
                            }

                            if (finalStickers.length > 0) {
                                if (finalStickers.length <= 60) {
                                    // Small packs can be sent as a single "pack" message (WhatsApp limit is 60)
                                    await sock.sendMessage(chatId, {
                                        cover: finalStickers[0].data,
                                        stickers: finalStickers,
                                        name: session.meta.packname,
                                        publisher: session.meta.author,
                                        description: detail.name
                                    }, { quoted: msg });
                                } else {
                                    // Large packs must be sent individually to bypass limits
                                    await sock.sendMessage(chatId, { text: `🚀 Sending ${finalStickers.length} stickers individually to bypass the 60-sticker limit...` }).catch(() => null);
                                    for (const sticker of finalStickers) {
                                        await sock.sendMessage(chatId, { sticker: { url: sticker.data.url } }, { quoted: msg });
                                        await sleep(CONFIG.SEND_DELAY);
                                    }
                                }
                            } else {
                                throw new Error('Failed to process any stickers.');
                            }

                            await sock.sendMessage(chatId, { text: 'i fetched, hehe..', edit: fetchMsg.key }).catch(() => null);
                        } finally {
                            // Cleanup ALWAYS runs
                            tempFiles.forEach(f => {
                                try {
                                    if (fs.existsSync(f)) fs.unlinkSync(f);
                                } catch (e) {
                                    console.error('[sticker-search] cleanup error for', f, e.message);
                                }
                            });
                        }
                    } catch (err) {
                        console.error('[sticker-search] detail error:', err);
                        await sock.sendMessage(chatId, { text: `❌ Error: ${err.message}` }, { quoted: msg });
                    }

                    deleteSession(chatId);
                    return true;
                }
            };

            const listMsg = await sock.sendMessage(chatId, { text: responseText }, { quoted: message });
            session.listMsgKey = listMsg.key;
            createSession(chatId, session);

            setTimeout(() => {
                if (getSession(chatId)?.startTime === session.startTime) deleteSession(chatId);
            }, CONFIG.SESSION_TIMEOUT);

        } catch (error) {
            console.error('[sticker-search] fatal error:', error);
            await sock.sendMessage(chatId, { text: 'An error occurred during the search.' }, { quoted: message });
        }
    },
    async handleStickerSearchReply(sock, chatId, message, senderId, text) {
        const session = getSession(chatId);
        if (!session || session.type !== 'sticker-search' || typeof session.onMessage !== 'function') {
            return false;
        }

        const input = String(text || '').trim();
        if (!/^\d+$/.test(input)) return false;

        return session.onMessage(sock, message, senderId, input);
    }
};
