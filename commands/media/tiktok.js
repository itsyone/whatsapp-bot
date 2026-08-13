const { TiktokDownloader } = require('../../lib/scrapers');
const axios = require('axios');

// Store processed message IDs to prevent duplicates
const processedMessages = new Set();

function extractText(message = {}) {
    return (
        message.message?.conversation ||
        message.message?.extendedTextMessage?.text ||
        message.message?.imageMessage?.caption ||
        message.message?.videoMessage?.caption ||
        ''
    );
}

function extractUrl(text = '') {
    const match = String(text || '').match(/https?:\/\/[^\s]+/i);
    return match ? match[0].trim() : '';
}

async function resolveTikTokUrl(url) {
    try {
        const response = await axios.get(url, {
            maxRedirects: 5,
            timeout: 15000,
            validateStatus: (status) => status >= 200 && status < 400,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            }
        });
        const finalUrl = response?.request?.res?.responseUrl || response?.config?.url || url;
        return typeof finalUrl === 'string' ? finalUrl : url;
    } catch {
        return url;
    }
}

async function tiktokCommand(sock, chatId, message) {
    try {
        if (processedMessages.has(message.key.id)) return;
        processedMessages.add(message.key.id);
        setTimeout(() => processedMessages.delete(message.key.id), 5 * 60 * 1000);

        const text = extractText(message);
        if (!text) {
            return await sock.sendMessage(chatId, { text: "Please provide a TikTok link for the video." });
        }

        const inputUrl = extractUrl(text.split(/\s+/).slice(1).join(' ').trim()) || extractUrl(text);
        if (!inputUrl) {
            return await sock.sendMessage(chatId, { text: "Please provide a TikTok link for the video." });
        }

        const url = await resolveTikTokUrl(inputUrl);
        const tiktokPatterns = [
            /https?:\/\/(?:www\.)?tiktok\.com\//,
            /https?:\/\/(?:vm\.)?tiktok\.com\//,
            /https?:\/\/(?:vt\.)?tiktok\.com\//,
            /https?:\/\/(?:www\.)?tiktok\.com\/@/,
            /https?:\/\/(?:www\.)?tiktok\.com\/t\//
        ];

        if (!tiktokPatterns.some(pattern => pattern.test(url))) {
            return await sock.sendMessage(chatId, { text: "That is not a valid TikTok link." });
        }

        // Set initial reaction to ⏳
        await sock.sendMessage(chatId, { react: { text: '⏳', key: message.key } });

        try {
            const result = await TiktokDownloader.extract(url);
            
            if (!result || !result.videoUrl) {
                throw new Error("Failed to extract download URL.");
            }

            const { videoUrl, description } = result;

            // Send via Direct URL (WhatsApp handles the download for extreme speed)
            await sock.sendMessage(chatId, {
                video: { url: videoUrl },
                mimetype: "video/mp4",
                caption: (description || "").replace(/https?:\/\/\S+/g, '') // Remove possible links
            }, { quoted: message });

            // Send done reaction
            await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });

        } catch (error) {
            console.error('TikTok download failed:', error.message);
            await sock.sendMessage(chatId, { text: "❌ Failed to download TikTok video. Please try again later." });
            await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
        }
    } catch (error) {
        console.error('Error in TikTok command:', error);
    }
}

module.exports = {
  name: 'tiktok',
  async execute(ctx) {
    return tiktokCommand(ctx.sock, ctx.chatId, ctx.message);
  }
};
