const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const { downloadContentFromMessage, downloadMediaMessage } = require('../../lib/baileys');
const { quoteCommand } = require('../utility/quote');
const { writeExif } = require('../../lib/exif');
const settings = require('../../settings');

const execPromise = util.promisify(exec);
const fsp = fs.promises;
let sharp;
try {
    sharp = require('sharp');
} catch {
    sharp = null;
}
const TEMP_DIR = path.join(process.cwd(), 'temp_stickers');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function getStickerMeta() {
    return {
        packname: String(settings.packname || settings.botName || 'Sticker').trim() || 'Sticker',
        author: String(settings.author || 'Eclipse').trim() || 'Eclipse'
    };
}

async function stickerCommand(sock, chatId, message, options = {}) {
    try {
        const rawText = String(
            message?.message?.conversation ||
            message?.message?.extendedTextMessage?.text ||
            message?.message?.imageMessage?.caption ||
            message?.message?.videoMessage?.caption ||
            ''
        ).trim().toLowerCase();
        const invokedAsShort = rawText.startsWith('.s') && !rawText.startsWith('.sticker');
        const crop = options.crop !== undefined ? Boolean(options.crop) : invokedAsShort;
        const quotedInfo = quoteCommand.getContextInfo
            ? quoteCommand.getContextInfo(message)
            : message.message?.extendedTextMessage?.contextInfo;
        const quotedMessage = quotedInfo?.quotedMessage;
        const quotedText = String(
            quoteCommand.getQuotedText
                ? quoteCommand.getQuotedText(message)
                : (
                    quotedMessage?.conversation ||
                    quotedMessage?.extendedTextMessage?.text ||
                    quotedMessage?.imageMessage?.caption ||
                    quotedMessage?.videoMessage?.caption ||
                    ''
                )
        ).trim();

        const { mediaMsg, mediaType } = getMedia(message);

        if (!mediaMsg && quotedMessage && quotedText) {
            await quoteCommand(sock, chatId, message);
            return;
        }

        if (!mediaMsg) {
            await sock.sendMessage(chatId, {
                text: 'Reply to image/video/gif, or send media with .sticker as caption.'
            }, { quoted: message });
            return;
        }

        if (mediaType === 'sticker') {
            await sock.sendMessage(chatId, {
                text: 'That is already a sticker.'
            }, { quoted: message });
            return;
        }

        const buffer = await download(sock, message, mediaMsg, mediaType);
        if (!buffer) {
            await sock.sendMessage(chatId, { text: 'Download failed.' }, { quoted: message });
            return;
        }

        const sizeMB = buffer.length / (1024 * 1024);
        const isGif = await detectGif(buffer, mediaMsg);
        const actualType = isGif ? 'gif' : mediaType;

        let stickerBuf;

        if (actualType === 'image') {
            stickerBuf = await imageToWebp(buffer, { crop });
        } else {
            const duration = Number(mediaMsg.seconds || 5);
            if (duration > 10) {
                await sock.sendMessage(chatId, {
                    text: `Video is too long (${duration.toFixed(1)}s). Max is 10s.`
                }, { quoted: message });
                return;
            }

            stickerBuf = await videoToWebp(buffer, duration, sizeMB);
        }

        if (!stickerBuf) {
            await sock.sendMessage(chatId, {
                text: 'Conversion failed. Try another media file.'
            }, { quoted: message });
            return;
        }

        let stickerPath = null;
        try {
            stickerPath = await writeExif({
                mimetype: 'image/webp',
                data: stickerBuf
            }, getStickerMeta());

            if (!stickerPath) {
                throw new Error('Failed to write sticker metadata.');
            }

            await sock.sendMessage(chatId, { sticker: { url: stickerPath } }, { quoted: message });
        } finally {
            if (stickerPath) {
                try {
                    await fsp.unlink(stickerPath);
                } catch {}
            }
        }
    } catch (err) {
        console.error('[Sticker] Error:', err);
        await sock.sendMessage(chatId, {
            text: `Sticker error: ${err.message}`
        }, { quoted: message });
    }
}

function getMedia(message) {
    const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;

    if (quoted?.imageMessage) return { mediaMsg: quoted.imageMessage, mediaType: 'image' };
    if (quoted?.videoMessage) return { mediaMsg: quoted.videoMessage, mediaType: 'video' };
    if (quoted?.stickerMessage) return { mediaMsg: quoted.stickerMessage, mediaType: 'sticker' };

    if (message.message?.imageMessage) return { mediaMsg: message.message.imageMessage, mediaType: 'image' };
    if (message.message?.videoMessage) return { mediaMsg: message.message.videoMessage, mediaType: 'video' };

    return { mediaMsg: null, mediaType: null };
}

function getTargetMessage(message, chatId) {
    const quotedInfo = message.message?.extendedTextMessage?.contextInfo;
    if (!quotedInfo?.quotedMessage) return message;

    return {
        key: {
            remoteJid: chatId,
            id: quotedInfo.stanzaId,
            participant: quotedInfo.participant
        },
        message: quotedInfo.quotedMessage
    };
}

async function download(sock, message, mediaMsg, type) {
    try {
        const stream = await downloadContentFromMessage(mediaMsg, type === 'image' ? 'image' : 'video');
        let buffer = Buffer.from([]);

        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        if (buffer.length > 0) return buffer;
        throw new Error('Empty media buffer');
    } catch {
        try {
            const targetMessage = getTargetMessage(message, message.key.remoteJid);
            return await downloadMediaMessage(targetMessage, 'buffer', {}, {
                logger: undefined,
                reuploadRequest: sock.updateMediaMessage
            });
        } catch (e) {
            console.error('[Sticker] Download fallback failed:', e.message);
            return null;
        }
    }
}

async function detectGif(buffer, mediaMsg) {
    try {
        if (mediaMsg?.gifPlayback) return true;
        if (String(mediaMsg?.mimetype || '').toLowerCase().includes('gif')) return true;

        return buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46;
    } catch {
        return false;
    }
}

async function imageToWebp(buffer, options = {}) {
    try {
        const crop = Boolean(options.crop);
        if (!sharp) {
            const now = Date.now();
            const input = path.join(TEMP_DIR, `img_in_${now}.png`);
            const output = path.join(TEMP_DIR, `img_out_${now}.webp`);

            await fsp.writeFile(input, buffer);

            const cmd = [
                `ffmpeg -i "${input}"`,
                crop
                    ? '-vf "crop=min(iw\\,ih):min(iw\\,ih),scale=512:512:flags=lanczos"'
                    : '-vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000"',
                '-vcodec libwebp',
                '-lossless 0',
                '-compression_level 6',
                '-q:v 70',
                '-preset default',
                '-loop 0',
                '-an',
                '-vsync 0',
                `-y "${output}"`
            ].join(' ');

            await execPromise(cmd, { timeout: 30000 });
            const webpBuffer = await fsp.readFile(output);
            await cleanup([input, output]);
            return webpBuffer;
        }

        const meta = await sharp(buffer).metadata();
        const width = meta.width || 512;
        const height = meta.height || 512;

        if (crop) {
            const min = Math.min(width, height);
            const left = Math.floor((width - min) / 2);
            const top = Math.floor((height - min) / 2);

            return await sharp(buffer)
                .extract({ left, top, width: min, height: min })
                .resize(512, 512, { kernel: sharp.kernel.lanczos3 })
                .webp({ quality: 75, effort: 4 })
                .toBuffer();
        }

        return await sharp(buffer)
            .resize(512, 512, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 0 },
                kernel: sharp.kernel.lanczos3
            })
            .webp({ quality: 75, effort: 4 })
            .toBuffer();
    } catch (err) {
        console.error('[Sticker] Image conversion error:', err.message);
        return null;
    }
}

async function videoToWebp(buffer, duration, sizeMB) {
    const now = Date.now();
    const input = path.join(TEMP_DIR, `in_${now}.mp4`);
    const output = path.join(TEMP_DIR, `out_${now}.webp`);

    try {
        await fsp.writeFile(input, buffer);

        const info = await getVideoInfo(input);
        const settings = calculateSettings(duration, sizeMB, info.fps);

        const min = Math.min(info.width, info.height);
        const x = Math.floor((info.width - min) / 2);
        const y = Math.floor((info.height - min) / 2);

        const cmd = [
            `ffmpeg -i "${input}"`,
            `-vf "crop=${min}:${min}:${x}:${y},scale=512:512:flags=lanczos,fps=${settings.fps}"`,
            '-vcodec libwebp',
            '-lossless 0',
            '-compression_level 6',
            `-q:v ${settings.quality}`,
            '-preset default',
            '-loop 0',
            '-an',
            '-vsync 0',
            `-t ${Math.min(duration, 10)}`,
            `-y "${output}"`
        ].join(' ');

        await execPromise(cmd, { timeout: 60000 });

        if (!fs.existsSync(output)) {
            throw new Error('Output was not created');
        }

        let outputBuffer = await fsp.readFile(output);
        let sizeKB = outputBuffer.length / 1024;

        if (sizeKB > 800) {
            await fsp.unlink(output);

            // LOWER quality means LOWER file size in libwebp.
            // Original code was INCREASING quality which made it larger.
            const lowQuality = Math.max(30, settings.quality - 20);
            const lowFps = Math.max(8, Math.floor(settings.fps * 0.7));

            const retryCmd = [
                `ffmpeg -i "${input}"`,
                `-vf "crop=${min}:${min}:${x}:${y},scale=512:512:flags=lanczos,fps=${lowFps}"`,
                '-vcodec libwebp',
                '-lossless 0',
                '-compression_level 6',
                `-q:v ${lowQuality}`,
                '-preset default',
                '-loop 0',
                '-an',
                '-vsync 0',
                `-t ${Math.min(duration, 10)}`,
                `-y "${output}"`
            ].join(' ');

            await execPromise(retryCmd, { timeout: 60000 });
            outputBuffer = await fsp.readFile(output);
            sizeKB = outputBuffer.length / 1024;
        }

        if (sizeKB > 1000) {
            console.warn(`[Sticker] Sticker still large: ${sizeKB.toFixed(0)}KB`);
        }

        await cleanup([input, output]);
        return outputBuffer;
    } catch (err) {
        console.error('[Sticker] Video conversion error:', err.message);
        await cleanup([input, output]);
        return null;
    }
}

function calculateSettings(duration, sizeMB, sourceFps) {
    let fps;
    let quality;

    if (sizeMB < 1) {
        fps = Math.min(24, sourceFps);
        quality = 65;
    } else if (sizeMB < 5) {
        fps = Math.min(18, sourceFps);
        quality = 50;
    } else {
        fps = Math.min(12, sourceFps);
        quality = 40;
    }

    if (duration > 7) {
        fps = Math.max(10, Math.floor(fps * 0.75));
        quality = Math.max(30, quality - 10);
    }

    fps = Math.max(8, Math.min(30, fps));
    quality = Math.max(30, Math.min(80, quality));

    return { fps, quality };
}

async function getVideoInfo(file) {
    const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of json "${file}"`;
    const { stdout } = await execPromise(cmd, { timeout: 15000 });
    const parsed = JSON.parse(stdout || '{}');
    const v = Array.isArray(parsed.streams) ? parsed.streams[0] : null;

    if (!v) {
        throw new Error('No video stream');
    }

    let fps = 25;
    if (v.r_frame_rate && String(v.r_frame_rate).includes('/')) {
        const parts = String(v.r_frame_rate).split('/');
        const n = parseInt(parts[0], 10);
        const d = parseInt(parts[1], 10);
        if (Number.isFinite(n) && Number.isFinite(d) && d > 0) {
            fps = Math.round(n / d);
        }
    }

    return {
        width: v.width || 512,
        height: v.height || 512,
        fps: Math.min(60, Math.max(1, fps))
    };
}

async function cleanup(files) {
    for (const file of files) {
        try {
            if (fs.existsSync(file)) {
                await fsp.unlink(file);
            }
        } catch {
            // Ignore cleanup errors.
        }
    }
}

setInterval(() => {
    try {
        if (!fs.existsSync(TEMP_DIR)) return;
        const files = fs.readdirSync(TEMP_DIR);
        const hourAgo = Date.now() - 3600000;

        for (const file of files) {
            try {
                const fullPath = path.join(TEMP_DIR, file);
                if (fs.statSync(fullPath).mtimeMs < hourAgo) {
                    fs.unlinkSync(fullPath);
                }
            } catch {
                // Ignore per-file cleanup errors.
            }
        }
    } catch {
        // Ignore interval errors.
    }
}, 600000);





module.exports = {
  name: 'sticker',
  async execute(ctx) {
    return stickerCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.options || {});
  }
};
