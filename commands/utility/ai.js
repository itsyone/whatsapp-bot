const axios = require('axios');

const REBLIX_BASE = 'https://api-rebix.vercel.app/api';

const AI_MODELS = {
    '.gpt': { endpoint: 'gpt-5', name: 'GPT-5' },
    '.gemini': { endpoint: 'gemini', name: 'Gemini' },
    '.llama': { endpoint: 'llama-meta', name: 'LLaMA' },
    '.cohere': { endpoint: 'cohere', name: 'Cohere' }
};

function extractAiAnswer(data) {
    if (!data || typeof data !== 'object') return '';

    const candidates = [
        data.result,
        data.results,
        data.response,
        data.answer,
        data.message,
        data.text
    ];

    for (const value of candidates) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }

        if (value && typeof value === 'object') {
            const nested = [
                value.result,
                value.results,
                value.response,
                value.answer,
                value.message,
                value.text,
                value.content
            ].find((item) => typeof item === 'string' && item.trim());

            if (nested) return nested.trim();
        }
    }

    return '';
}

async function aiCommand(sock, chatId, message) {
    const text =
        message.message?.conversation ||
        message.message?.extendedTextMessage?.text || '';

    const parts = text.trim().split(' ');
    const command = parts[0].toLowerCase();
    const query = parts.slice(1).join(' ').trim();

    const model = AI_MODELS[command];
    if (!model) return;

    if (!query) {
        return sock.sendMessage(chatId, {
            text: `Please provide a question after ${command}\n\nExample: ${command} explain black holes`
        }, { quoted: message });
    }

    try {
        await sock.sendMessage(chatId, {
            react: { text: '🤖', key: message.key }
        });

        const { data } = await axios.get(
            `${REBLIX_BASE}/${model.endpoint}?q=${encodeURIComponent(query)}`,
            {
                timeout: 20000,
                headers: {
                    'User-Agent': 'Mozilla/5.0'
                }
            }
        );

        const answer = extractAiAnswer(data);
        if (!answer) throw new Error('Empty response from Reblix');

        await sock.sendMessage(chatId, {
            text: answer
        }, { quoted: message });
    } catch (error) {
        console.error(`[aiCommand/${model.name}] Error:`, error.message);
        await sock.sendMessage(chatId, {
            text: `❌ ${model.name} failed to respond. Try again later.`
        }, { quoted: message });
    }
}





module.exports = {
  name: 'ai',
  async execute(ctx) {
    return aiCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
