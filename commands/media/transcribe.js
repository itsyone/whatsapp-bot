const Groq = require('groq-sdk');
const { downloadContentFromMessage } = require('../../lib/baileys');

const TRANSCRIBE_MODEL = String(process.env.GROQ_TRANSCRIBE_MODEL || process.env.CHATBOT_AUDIO_MODEL || 'whisper-large-v3-turbo').trim();
const TRANSCRIBE_MAX_BYTES = Math.max(64 * 1024, Number(process.env.GROQ_TRANSCRIBE_MAX_BYTES || 25 * 1024 * 1024));

let groqClient = null;

function getGroqClient() {
    const apiKey = String(process.env.GROQ_API_KEY || '').trim();
    if (!apiKey) return null;
    if (!groqClient) groqClient = new Groq({ apiKey }); // FIXED: removed dangerouslyAllowBrowser
    return groqClient;
}

function getTargetAudioMessage(message = {}) {
    const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quoted?.audioMessage) return quoted.audioMessage;
    if (message.message?.audioMessage) return message.message.audioMessage;
    return null;
}

async function audioMessageToBuffer(audioMessage) {
    if (!audioMessage) return null;
    const stream = await downloadContentFromMessage(audioMessage, 'audio');
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
    }
    const out = Buffer.concat(chunks);
    return out.length ? out : null;
}

function pickExtension(mimeType = '') {
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
    if (mimeType.includes('wav')) return 'wav';
    if (mimeType.includes('webm')) return 'webm';
    if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
    return 'ogg';
}

async function transcribeCommand(sock, chatId, message) {
    try {
        const client = getGroqClient();
        if (!client) {
            await sock.sendMessage(chatId, {
                text: 'Groq transcription is not configured yet.'
            }, { quoted: message });
            return;
        }

        const audioMessage = getTargetAudioMessage(message);
        if (!audioMessage) {
            await sock.sendMessage(chatId, {
                text: 'Reply to a voice note/audio or send audio with `.transcribe` as caption.'
            }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, {
            react: { text: '🎙️', key: message.key }
        });

        const buffer = await audioMessageToBuffer(audioMessage);
        if (!buffer?.length) {
            await sock.sendMessage(chatId, {
                text: 'Failed to read that audio.'
            }, { quoted: message });
            return;
        }

        if (buffer.length > TRANSCRIBE_MAX_BYTES) {
            await sock.sendMessage(chatId, {
                text: 'That audio is too large to transcribe.'
            }, { quoted: message });
            return;
        }

        const file = await Groq.toFile(buffer, `transcribe.${pickExtension(audioMessage?.mimetype || '')}`);
        const result = await client.audio.transcriptions.create({
            file,
            model: TRANSCRIBE_MODEL,
            temperature: 0,
            response_format: 'json'
        });

        const text = String(result?.text || '').replace(/\s+/g, ' ').trim();
        if (!text) {
            await sock.sendMessage(chatId, {
                text: 'I could not detect any speech in that audio.'
            }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, {
            text: `🎙️ *Transcription*\n\n${text}`
        }, { quoted: message });
    } catch (error) {
        console.error('[transcribe] error:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: 'Failed to transcribe that audio.'
        }, { quoted: message });
    }
}





module.exports = {
  name: 'transcribe',
  async execute(ctx) {
    return transcribeCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
