const axios = require('axios');

const API_URL = 'https://abhi-api.vercel.app/api/anime/couplepp';

function pickImageUrl(payload) {
    if (!payload) return '';
    if (typeof payload === 'string' && /^https?:\/\//i.test(payload)) return payload;
    return (
        payload.url ||
        payload.result?.url ||
        payload.result ||
        payload.data?.url ||
        payload.data ||
        payload.image ||
        ''
    );
}

function pickCoupleUrls(payload) {
    const out = [];
    const pushIfUrl = (u) => {
        const s = String(u || '').trim();
        if (/^https?:\/\//i.test(s)) out.push(s);
    };

    if (!payload) return out;
    if (typeof payload === 'string') {
        pushIfUrl(payload);
        return out;
    }

    pushIfUrl(payload.url);
    pushIfUrl(payload.result?.url);
    pushIfUrl(payload.data?.url);
    pushIfUrl(payload.image);

    // API-specific shape
    pushIfUrl(payload.result?.male);
    pushIfUrl(payload.result?.female);
    pushIfUrl(payload.male);
    pushIfUrl(payload.female);

    return [...new Set(out)];
}

async function coupleppCommand(sock, chatId, message) {
    try {
        const { data } = await axios.get(API_URL, {
            timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const urls = pickCoupleUrls(data);
        if (!urls.length) {
            await sock.sendMessage(chatId, { text: 'Failed to fetch couple pfp image.' }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, { text: '🩷 Couple PFP' }, { quoted: message });

        const labels = ['Male', 'Female'];
        for (let i = 0; i < Math.min(urls.length, 2); i += 1) {
            await sock.sendMessage(chatId, {
                image: { url: urls[i] },
                caption: labels[i] || 'PFP'
            }, { quoted: message });
        }
    } catch (error) {
        console.error('Error in couplepp command:', error?.message || error);
        await sock.sendMessage(chatId, { text: 'Failed to fetch couple pfp image.' }, { quoted: message });
    }
}





module.exports = {
  name: 'couplepp',
  async execute(ctx) {
    return coupleppCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
