const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { downloadContentFromMessage } = require('../../lib/baileys');

ffmpeg.setFfmpegPath(ffmpegPath);

const TEMP_DIR = path.join(process.cwd(), 'temp_convert');

function ensureTempDir() {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

async function downloadStickerBuffer(stickerMessage) {
    const stream = await downloadContentFromMessage(stickerMessage, 'sticker');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function getQuotedSticker(message) {
    return (
        message?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage ||
        message?.message?.stickerMessage ||
        null
    );
}

async function toImgCommand(sock, chatId, message) {
    const stickerMessage = getQuotedSticker(message);
    if (!stickerMessage) {
        await sock.sendMessage(chatId, { text: 'Reply to a sticker with `.toimg`.' }, { quoted: message });
        return;
    }

    try {
        const buffer = await downloadStickerBuffer(stickerMessage);
        const png = await sharp(buffer, { animated: false }).png().toBuffer();
        await sock.sendMessage(chatId, { image: png, caption: 'Sticker converted to image.' }, { quoted: message });
    } catch (error) {
        console.error('[toimg] error:', error);
        await sock.sendMessage(chatId, { text: 'Failed to convert sticker to image.' }, { quoted: message });
    }
}

function convertStickerToMp4(inputPath, outputPath, isAnimated) {
    return new Promise((resolve, reject) => {
        let command = ffmpeg(inputPath)
            .outputOptions(['-movflags +faststart', '-pix_fmt yuv420p'])
            .videoCodec('libx264')
            .format('mp4')
            .save(outputPath);

        if (!isAnimated) {
            command = ffmpeg(inputPath)
                .inputOptions(['-loop 1'])
                .outputOptions(['-t 3', '-movflags +faststart', '-pix_fmt yuv420p'])
                .videoCodec('libx264')
                .format('mp4')
                .save(outputPath);
        }

        command.on('end', resolve).on('error', reject);
    });
}

async function toVideoCommand(sock, chatId, message) {
    const stickerMessage = getQuotedSticker(message);
    if (!stickerMessage) {
        await sock.sendMessage(chatId, { text: 'Reply to a sticker with `.tovideo` or `.tovid`.' }, { quoted: message });
        return;
    }

    ensureTempDir();
    const stamp = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const inputPath = path.join(TEMP_DIR, `${stamp}.webp`);
    const outputPath = path.join(TEMP_DIR, `${stamp}.mp4`);

    try {
        const buffer = await downloadStickerBuffer(stickerMessage);
        fs.writeFileSync(inputPath, buffer);
        await convertStickerToMp4(inputPath, outputPath, Boolean(stickerMessage.isAnimated));
        const outputBuffer = fs.readFileSync(outputPath);

        await sock.sendMessage(chatId, {
            video: outputBuffer,
            caption: 'Sticker converted to video.'
        }, { quoted: message });
    } catch (error) {
        console.error('[tovideo] error:', error);
        await sock.sendMessage(chatId, { text: 'Failed to convert sticker to video.' }, { quoted: message });
    } finally {
        for (const file of [inputPath, outputPath]) {
            if (file && fs.existsSync(file)) {
                try {
                    fs.unlinkSync(file);
                } catch {}
            }
        }
    }
}

module.exports = [
    {
        name: 'toimg',
        alias: ['toimage'],
        async execute(ctx) {
            return toImgCommand(ctx.sock, ctx.chatId, ctx.message);
        }
    },
    {
        name: 'tovideo',
        alias: ['tovid', 'tomp4'],
        async execute(ctx) {
            return toVideoCommand(ctx.sock, ctx.chatId, ctx.message);
        }
    }
];
