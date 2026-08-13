const fetch = require('node-fetch');
const { downloadContentFromMessage } = require('../../lib/baileys');

const SUBTITLE_MODEL = 'openai/whisper-small';
const SUBTITLE_MAX_BYTES = Math.max(64 * 1024, Number(process.env.HF_SUBTITLE_MAX_BYTES || 25 * 1024 * 1024));

function getHfApiKey() {
    const apiKey = String(
        process.env.HF_API_KEY ||
        process.env.HUGGINGFACE_API_KEY ||
        process.env.HF_TOKEN ||
        ''
    ).trim();
    return apiKey || null;
}

function pickTargetMessage(message = {}) {
    const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    return quoted?.audioMessage || quoted?.videoMessage || message.message?.audioMessage || message.message?.videoMessage || null;
}

function pickDownloadType(target = {}) {
    if (target?.mimetype?.includes('video')) return 'video';
    return 'audio';
}

function pickExtension(mimeType = '') {
    const value = String(mimeType || '').toLowerCase();
    if (value.includes('ogg')) return 'ogg';
    if (value.includes('mpeg') || value.includes('mp3')) return 'mp3';
    if (value.includes('wav')) return 'wav';
    if (value.includes('webm')) return 'webm';
    if (value.includes('mp4')) return 'mp4';
    if (value.includes('m4a')) return 'm4a';
    return 'bin';
}

async function messageToBuffer(target) {
    const stream = await downloadContentFromMessage(target, pickDownloadType(target));
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
    }
    const out = Buffer.concat(chunks);
    return out.length ? out : null;
}

function cleanTranscript(text = '') {
    return String(text || '')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n');
}

async function subtitlesCommand(sock, chatId, message) {
    try {
        const apiKey = getHfApiKey();
        if (!apiKey) {
            await sock.sendMessage(chatId, {
                text: 'Hugging Face subtitles are not configured yet.'
            }, { quoted: message });
            return;
        }

        const target = pickTargetMessage(message);
        if (!target) {
            await sock.sendMessage(chatId, {
                text: 'Reply to an audio/video or send one with `.sub` or `.subtitles` as caption.'
            }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, {
            react: { text: '??', key: message.key }
        });

        const buffer = await messageToBuffer(target);
        if (!buffer?.length) {
            await sock.sendMessage(chatId, {
                text: 'Failed to read that media.'
            }, { quoted: message });
            return;
        }

        if (buffer.length > SUBTITLE_MAX_BYTES) {
            await sock.sendMessage(chatId, {
                text: 'That media is too large to subtitle.'
            }, { quoted: message });
            return;
        }

        const response = await fetch(`https://api-inference.huggingface.co/models/${encodeURIComponent(SUBTITLE_MODEL)}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': target?.mimetype || 'application/octet-stream'
            },
            body: buffer
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(errorText || `HF HTTP ${response.status}`);
        }

        const result = await response.json();

        const text = cleanTranscript(result?.text || result);
        if (!text) {
            await sock.sendMessage(chatId, {
                text: 'No clear speech was detected in that media.'
            }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, { text }, { quoted: message });
    } catch (error) {
        console.error('[subtitles] error:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: 'Failed to generate subtitles for that media.'
        }, { quoted: message });
    }
}





module.exports = {
  name: 'subtitles',
  async execute(ctx) {
    return subtitlesCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
