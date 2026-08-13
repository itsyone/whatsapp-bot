const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { writeExifImg, writeExifVid } = require('../../lib/exif');
const settings = require('../../settings');

const BOT_TOKEN = String(
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.TG_BOT_TOKEN ||
    '8365930587:AAEh3XhE2bYw_8Y9SQ5V6Xv5agqhQs-kfOQ'
).trim();
const MAX_PACK_STICKERS = 20;
const MAX_SEND = 10;
const MAX_STICKER_BYTES = 900 * 1024;
const TEMP_DIR = path.join(process.cwd(), 'temp_tg_pack');

function getStickerMeta() {
    return {
        packname: String(settings.packname || settings.botName || 'Sticker').trim() || 'Sticker',
        author: String(settings.author || 'Eclipse').trim() || 'Eclipse'
    };
}

function ensureTempDir() {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function getText(msg) {
    return (
        msg.message?.conversation?.trim() ||
        msg.message?.extendedTextMessage?.text?.trim() ||
        msg.message?.imageMessage?.caption?.trim() ||
        msg.message?.videoMessage?.caption?.trim() ||
        ''
    );
}

function extractPackName(input = '') {
    const source = String(input || '').trim();
    const match = source.match(/(?:https?:\/\/)?(?:t\.me|telegram\.me)\/addstickers\/([A-Za-z0-9_]+)/i);
    return String(match?.[1] || '').trim();
}

async function tgApi(pathname) {
    if (!BOT_TOKEN) throw new Error('Telegram bot token missing');

    const response = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/${pathname}`, {
        headers: {
            Accept: 'application/json',
            'User-Agent': 'Mozilla/5.0'
        }
    });

    const data = response.data;
    if (!data?.ok) {
        throw new Error(data?.description || `Telegram API error`);
    }

    return data.result;
}

async function downloadTelegramFile(filePath) {
    const response = await axios.get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        responseType: 'arraybuffer'
    });

    return Buffer.from(response.data);
}

async function buildPackEntry(sticker, tempFiles) {
    if (!sticker?.file_id || sticker?.is_animated) return null;

    const fileInfo = await tgApi(`getFile?file_id=${encodeURIComponent(sticker.file_id)}`);
    if (!fileInfo?.file_path) return null;

    const buffer = await downloadTelegramFile(fileInfo.file_path);
    const meta = getStickerMeta();
    const stickerPath = sticker?.is_video
        ? await writeExifVid(buffer, meta)
        : await writeExifImg(buffer, meta);

    // Check size limit
    const size = fs.statSync(stickerPath).size;
    if (size > MAX_STICKER_BYTES) {
        try {
            fs.unlinkSync(stickerPath);
        } catch {}
        console.warn(`[stickertelegram] Sticker exceeds size limit: ${size} bytes`);
        return null;
    }

    tempFiles.push(stickerPath);
    return { data: { url: stickerPath } };
}

async function stickerTelegramCommand(sock, chatId, msg) {
    const rawText = getText(msg);
    const packName = extractPackName(rawText);

    if (!BOT_TOKEN) {
        await sock.sendMessage(chatId, {
            text: 'Telegram sticker pack support is not configured yet.'
        }, { quoted: msg });
        return;
    }

    if (!packName) {
        await sock.sendMessage(chatId, {
            text: 'Send a Telegram sticker pack URL.\nExample: .tg https://t.me/addstickers/PackName'
        }, { quoted: msg });
        return;
    }

    ensureTempDir();

    try {
        await sock.sendMessage(chatId, {
            react: { text: '🔄', key: msg.key }
        });

        const stickerSet = await tgApi(`getStickerSet?name=${encodeURIComponent(packName)}`);
        const stickers = Array.isArray(stickerSet?.stickers) ? stickerSet.stickers.slice(0, MAX_PACK_STICKERS) : [];

        if (!stickers.length) {
            await sock.sendMessage(chatId, {
                text: 'That Telegram sticker pack is empty or unavailable.'
            }, { quoted: msg });
            return;
        }

        const tempFiles = [];
        const entries = [];

        for (const sticker of stickers) {
            try {
                const entry = await buildPackEntry(sticker, tempFiles);
                if (entry) entries.push(entry);
            } catch (error) {
                console.warn('[stickertelegram] item failed:', error?.message || error);
            }
        }

        if (!entries.length) {
            await sock.sendMessage(chatId, {
                text: 'Could not convert any stickers from that Telegram pack.'
            }, { quoted: msg });
            return;
        }

        // Send as a pack (matching pint-s.js format)
        const meta = getStickerMeta();
        await sock.sendMessage(chatId, {
            cover: entries[0].data,
            stickers: entries,
            name: meta.packname,
            publisher: meta.author,
            description: packName || 'Telegram Pack'
        }, { quoted: msg });

        for (const file of tempFiles) {
            try {
                fs.unlinkSync(file);
            } catch {}
        }

        await sock.sendMessage(chatId, {
            react: { text: '✅', key: msg.key }
        });
    } catch (error) {
        console.error('[stickertelegram] FATAL error:', error);
        await sock.sendMessage(chatId, {
            text: `Failed to fetch or send that Telegram sticker pack.\n\nError details: ${error.message || error}`
        }, { quoted: msg });
        try {
            await sock.sendMessage(chatId, {
                react: { text: '❌', key: msg.key }
            });
        } catch {}
    }
}

module.exports = {
    name: 'stickertelegram',
    async execute(ctx) {
        return stickerTelegramCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
    }
};
