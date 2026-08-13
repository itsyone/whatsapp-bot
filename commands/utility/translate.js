const Groq = require('groq-sdk');

let groqClient = null;
function getGroq() {
    const apiKey = String(process.env.GROQ_API_KEY || '').trim();
    if (!apiKey) return null;
    if (!groqClient) {
        groqClient = new Groq({ apiKey, dangerouslyAllowBrowser: true });
    }
    return groqClient;
}

async function handleTranslateCommand(sock, chatId, message, match) {
    try {
        await sock.presenceSubscribe(chatId);
        await sock.sendPresenceUpdate('composing', chatId);

        // Extract quoted message text
        const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedText =
            quoted?.conversation ||
            quoted?.extendedTextMessage?.text ||
            quoted?.imageMessage?.caption ||
            quoted?.videoMessage?.caption ||
            '';

        // Parse: .translate [text] [-lang]
        // Supports: .translate hi / .translate hi -hindi / reply + .translate / reply + .translate -hindi
        const arg = match?.trim() || '';
        let textToTranslate = '';
        let targetLang = 'English'; // default

        // Extract -lang flag if present
        const flagMatch = arg.match(/\s*-(\w+)$/);
        const cleanArg = flagMatch ? arg.slice(0, arg.length - flagMatch[0].length).trim() : arg.trim();
        if (flagMatch) targetLang = flagMatch[1];

        if (quotedText) {
            textToTranslate = quotedText;
            // If no -lang flag, treat cleanArg as a language name for backward compat
            if (!flagMatch && cleanArg) targetLang = cleanArg;
        } else {
            textToTranslate = cleanArg;
            if (!textToTranslate) {
                return sock.sendMessage(chatId, {
                    text: `Usage:\n• *.translate hello* — translate to English\n• *.translate hello -hindi* — translate to Hindi\n• Reply to a message + *.translate* — translate reply to English\n• Reply + *.translate -french* — translate reply to French`,
                }, { quoted: message });
            }
        }

        if (!textToTranslate) {
            return sock.sendMessage(chatId, {
                text: '❌ No text found. Reply to a message or provide text inline.',
            }, { quoted: message });
        }

        const groq = getGroq();
        if (!groq) {
            return sock.sendMessage(chatId, {
                text: 'Translation unavailable (missing GROQ_API_KEY).'
            }, { quoted: message });
        }

        // Ask Groq to translate
        const completion = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [
                {
                    role: 'system',
                    content: `You are a translator. Translate the given text to ${targetLang}. 
Return ONLY the translated text — no explanations, no quotes, no extra words.`,
                },
                {
                    role: 'user',
                    content: textToTranslate,
                },
            ],
            temperature: 0.3,
            max_tokens: 1024,
        });

        const translated = completion.choices[0]?.message?.content?.trim();

        if (!translated) throw new Error('Empty response from Groq');

        await sock.sendMessage(chatId, {
            text: translated,
        }, { quoted: message });

    } catch (error) {
        console.error('[translateCommand] Error:', error.message);
        await sock.sendMessage(chatId, {
            text: '❌ Translation failed. Try again later.',
        }, { quoted: message });
    }
}




module.exports = {
  name: 'translate',
  async execute(ctx) {
    return handleTranslateCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.match || null);
  }
};
