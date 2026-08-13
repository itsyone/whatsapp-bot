const gTTS = require('gtts');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LANG_ALIASES = {
    english: 'en', eng: 'en', en: 'en',
    hindi: 'hi', hi: 'hi',
    urdu: 'ur', ur: 'ur',
    arabic: 'ar', ar: 'ar',
    spanish: 'es', es: 'es',
    french: 'fr', fr: 'fr',
    german: 'de', de: 'de',
    italian: 'it', it: 'it',
    portuguese: 'pt', pt: 'pt',
    russian: 'ru', ru: 'ru',
    japanese: 'ja', ja: 'ja', jp: 'ja',
    korean: 'ko', ko: 'ko', kr: 'ko',
    chinese: 'zh-CN', zh: 'zh-CN', cn: 'zh-CN',
    turkish: 'tr', tr: 'tr',
    indonesian: 'id', id: 'id',
    dutch: 'nl', nl: 'nl',
    polish: 'pl', pl: 'pl',
    vietnamese: 'vi', vi: 'vi',
    thai: 'th', th: 'th',
    bengali: 'bn', bn: 'bn',
    tamil: 'ta', ta: 'ta',
    telugu: 'te', te: 'te'
};

function parseInput(rawArgs) {
    const text = String(rawArgs || '').trim();
    if (!text) return { text: '', lang: 'en' };
    
    // Check if last word is a language code/name: ".tts hello world hindi"
    const parts = text.split(/\s+/);
    if (parts.length >= 2) {
        const last = parts[parts.length - 1].toLowerCase();
        if (LANG_ALIASES[last]) {
            return { text: parts.slice(0, -1).join(' '), lang: LANG_ALIASES[last] };
        }
    }
    return { text, lang: 'en' };
}

async function ttsCommand(sock, chatId, message, args) {
    const { text, lang } = parseInput(args);
    
    if (!text) {
        await sock.sendMessage(chatId, {
            text: 'Usage: `.tts <text> [language]`\nExamples:\n• `.tts hello world`\n• `.tts namaste hindi`\n• `.tts bonjour fr`'
        }, { quoted: message });
        return;
    }

    // Write to OS temp dir — always writable
    const tmpDir = os.tmpdir();
    const filePath = path.join(tmpDir, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);

    try {
        const gtts = new gTTS(text, lang);
        await new Promise((resolve, reject) => {
            gtts.save(filePath, (err) => {
                if (err) return reject(err);
                resolve();
            });
        });

        await sock.sendMessage(chatId, {
            audio: { url: filePath },
            mimetype: 'audio/mpeg',
            ptt: false
        }, { quoted: message });
    } catch (error) {
        console.error('[tts] error:', error.message);
        await sock.sendMessage(chatId, {
            text: `Error generating TTS: ${error.message || 'unknown error'}`
        }, { quoted: message });
    } finally {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    }
}

module.exports = {
    name: 'tts',
    async execute(ctx) {
        return ttsCommand(
            ctx.sock || null,
            ctx.chatId || null,
            ctx.message || null,
            ctx.match || ''
        );
    }
};
