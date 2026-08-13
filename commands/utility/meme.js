const { downloadContentFromMessage } = require('../../lib/baileys');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const ffmpegPath = require('ffmpeg-static');

let canvasPkg;
try {
    canvasPkg = require('canvas');
} catch (e) {
    console.error('Canvas failed to load for meme.js:', e.message);
}

const { createCanvas, loadImage } = canvasPkg || {};

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function wrapText(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let line = '';

    for (const word of words) {
        const testLine = line ? `${line} ${word}` : word;
        const width = ctx.measureText(testLine).width;

        if (width > maxWidth && line) {
            lines.push(line);
            line = word;
        } else {
            line = testLine;
        }
    }

    if (line) lines.push(line);
    return lines;
}

async function getQuotedMedia(message) {
    const quoted = message?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted) return null;

    if (quoted.stickerMessage) {
        const stream = await downloadContentFromMessage(quoted.stickerMessage, 'sticker');
        const buffer = await streamToBuffer(stream);
        return { buffer, type: 'sticker', isAnimated: Boolean(quoted.stickerMessage.isAnimated) };
    }

    if (quoted.imageMessage) {
        const stream = await downloadContentFromMessage(quoted.imageMessage, 'image');
        const buffer = await streamToBuffer(stream);
        return { buffer, type: 'image', isAnimated: false };
    }

    return null;
}

async function memeCommand(sock, chatId, message, text = '') {
    if (!canvasPkg) {
        return await sock.sendMessage(chatId, { 
            text: '❌ meme command is unavailable: the canvas module failed to load on this server.' 
        }, { quoted: message });
    }
    const TEMP_DIR = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

    try {
        if (!text.trim()) {
            return await sock.sendMessage(
                chatId,
                { text: 'Reply to a sticker or image with `.meme your text`' },
                { quoted: message }
            );
        }

        const media = await getQuotedMedia(message);

        if (!media || !media.buffer) {
            return await sock.sendMessage(
                chatId,
                { text: 'Reply to a sticker or image first.' },
                { quoted: message }
            );
        }

        const { buffer: mediaBuffer, isAnimated } = media;

        if (isAnimated) {
            const now = Date.now();
            const input = path.join(TEMP_DIR, `meme_in_${now}.webp`);
            const output = path.join(TEMP_DIR, `meme_out_${now}.webp`);
            // Use absolute path for font, ffmpeg can be picky
            const fontPath = path.resolve(process.cwd(), 'fonts', 'SFPRODISPLAYBOLD.OTF').replace(/\\/g, '/');
            
            await fs.promises.writeFile(input, mediaBuffer);

            const loading = await sock.sendMessage(chatId, { text: '⏳ *Processing animated meme...*' }, { quoted: message });

            // Escape text for ffmpeg drawtext filter
            const safeText = text.replace(/'/g, "'\\\\''").replace(/:/g, '\\:').replace(/%/g, '\\%');
            
            const metadata = await sharp(mediaBuffer).metadata();
            const w = metadata.width || 512;
            const h = metadata.height || 512;
            const padH = Math.max(80, Math.floor(h * 0.25));
            const fontSize = Math.max(22, Math.floor(w / 12));

            // Use ffmpeg with explicit fontfile and improved scaling. Use proper animated webp codec flags.
            const ffmpegCmd = `"${ffmpegPath}" -i "${input}" -vf "pad=iw:ih+${padH}:0:0:color=white,drawtext=fontfile='${fontPath}':text='${safeText}':x=(w-text_w)/2:y=h-(${padH}/2)-(text_h/2):fontsize=${fontSize}:fontcolor=black" -c:v libwebp -loop 0 -lossless 0 -qscale 75 -preset default -an -y "${output}"`;
            
            console.log('[Meme] Running FFmpeg:', ffmpegCmd);

            try {
                await execPromise(ffmpegCmd);
                const resultBuffer = await fs.promises.readFile(output);
                
                await sock.sendMessage(chatId, { sticker: resultBuffer }, { quoted: message });
            } catch (err) {
                console.error('FFmpeg animated meme error:', err);
                throw err;
            } finally {
                if (loading) await sock.sendMessage(chatId, { delete: loading.key });
                if (fs.existsSync(input)) await fs.promises.unlink(input).catch(() => {});
                if (fs.existsSync(output)) await fs.promises.unlink(output).catch(() => {});
            }
            return;
        }

        // Static image/sticker logic (existing)
        const pngBuffer = await sharp(mediaBuffer).png().toBuffer();
        const img = await loadImage(pngBuffer);

        const extraBottom = Math.max(100, Math.floor(img.height * 0.25));
        const canvas = createCanvas(img.width, img.height + extraBottom);
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, img.width, img.height);

        let fontSize = Math.max(28, Math.floor(canvas.width / 11));
        ctx.textAlign = 'center';
        ctx.fillStyle = 'black';
        ctx.strokeStyle = 'white';

        const maxWidth = canvas.width - 40;

        while (fontSize > 18) {
            ctx.font = `bold ${fontSize}px Sans`;
            const testLines = wrapText(ctx, text, maxWidth);
            const totalHeight = testLines.length * (fontSize + 8);
            if (totalHeight <= extraBottom - 20) break;
            fontSize -= 2;
        }

        ctx.font = `bold ${fontSize}px Sans`;
        ctx.lineWidth = Math.max(3, Math.floor(fontSize / 8));

        const lines = wrapText(ctx, text, maxWidth);
        const lineHeight = fontSize + 8;
        const blockHeight = lines.length * lineHeight;
        let y = img.height + ((extraBottom - blockHeight) / 2) + fontSize;

        for (const line of lines) {
            ctx.strokeText(line, canvas.width / 2, y);
            ctx.fillText(line, canvas.width / 2, y);
            y += lineHeight;
        }

        const finalPng = canvas.toBuffer('image/png');
        const webpSticker = await sharp(finalPng).webp({ quality: 90 }).toBuffer();

        await sock.sendMessage(
            chatId,
            { sticker: webpSticker },
            { quoted: message }
        );

    } catch (error) {
        console.error('memeCommand error:', error);
        await sock.sendMessage(
            chatId,
            { text: '❌ Failed to make meme sticker.' },
            { quoted: message }
        );
    }
}

module.exports = {
  name: 'meme',
  async execute(ctx) {
    return memeCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, (ctx.args || []).join(' '));
  }
};
