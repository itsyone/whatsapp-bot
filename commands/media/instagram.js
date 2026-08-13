const axios = require('axios');
const cheerio = require('cheerio');

/**
 * 🛰️ UNIT 06: INSTAGRAM HARVESTER (Grabgram Node)
 * Designed for high-fidelity extraction of Reels, Videos, and Photos.
 */
class InstaDownloader {
    constructor() {
        this.baseUrl = 'https://grabgram.io';
        this.client = axios.create({
            baseURL: this.baseUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Origin': 'https://grabgram.io',
                'Referer': 'https://grabgram.io/tools/instagram-reels-downloader',
                'X-Requested-With': 'XMLHttpRequest'
            }
        });
    }

    /**
     * 💠 Synchronizing with the Wired (Handshake)...
     * Extracts CSRF tokens and session cookies.
     */
    async getTokens() {
        try {
            const response = await this.client.get('/tools/instagram-reels-downloader');
            const $ = cheerio.load(response.data);
            
            const csrfToken = $('meta[name="csrf-token"]').attr('content');
            const rawCookies = response.headers['set-cookie'];
            const cookies = Array.isArray(rawCookies) ? rawCookies : rawCookies ? [rawCookies] : [];
            
            const xsrfCookie = cookies.find(c => c.startsWith('XSRF-TOKEN='));
            const xsrfToken = xsrfCookie ? decodeURIComponent(xsrfCookie.split('=')[1].split(';')[0]) : null;

            if (!csrfToken) {
                throw new Error('Failed to synchronize CSRF token.');
            }

            return { csrfToken, cookies, xsrfToken };
        } catch (err) {
            throw new Error(`Handshake Failed: ${err.message}`);
        }
    }

    /**
     * ⚡ Initiating Frequency Synthesis (Media Extraction)...
     */
    async download(videoUrl) {
        try {
            const { csrfToken, cookies, xsrfToken } = await this.getTokens();

            const headers = {
                'x-csrf-token': csrfToken,
                'Cookie': cookies.map(c => c.split(';')[0]).join('; '),
                'Content-Type': 'application/json'
            };

            if (xsrfToken) headers['x-xsrf-token'] = xsrfToken;

            const response = await this.client.post('/api/fetch/instagram', 
                { url: videoUrl },
                { headers }
            );

            const result = response.data;
            
            const isOk = result.ok || result.status === 'success';
            const data = result.data;
            
            if (!isOk || !data) {
                throw new Error('API returned unsuccessful status or empty data.');
            }

            // Extract caption from various response locations
            const caption = result.caption || result.title || data.caption || data.title ||
                (Array.isArray(data) ? data[0]?.caption || data[0]?.title : null) ||
                (data.items?.[0]?.caption) || '';

            // Extract thumbnail
            const thumbnail = result.thumbnail || data.thumbnail ||
                (Array.isArray(data) ? data[0]?.thumbnail : null) ||
                (data.items?.[0]?.thumbnail) || null;

            let mediaAssets = [];
            
            if (Array.isArray(data)) {
                mediaAssets = data[0]?.media || [];
            } else if (data.items && Array.isArray(data.items)) {
                mediaAssets = data.items[0]?.downloads || data.items[0]?.media || [];
            } else if (data.media && Array.isArray(data.media)) {
                mediaAssets = data.media;
            }

            if (mediaAssets.length === 0) {
                throw new Error('No media found in the recognized data structures.');
            }
            
            return {
                media: mediaAssets.map(m => ({
                    type: m.kind || m.type,
                    url: m.url,
                    quality: m.label || 'HD',
                    extension: m.ext || ((m.kind || m.type) === 'video' ? 'mp4' : 'jpg'),
                    thumbnail: m.thumbnail || thumbnail || null
                })),
                caption: String(caption || '').slice(0, 1000)
            };
        } catch (err) {
            throw new Error(`Extraction Failed: ${err.message}`);
        }
    }
}

const downloader = new InstaDownloader();

async function instagramCommand(sock, chatId, message) {
    const text = message.message?.conversation || message.message?.extendedTextMessage?.text;
    if (!text) {
        return await sock.sendMessage(chatId, { text: 'Please provide an Instagram link.' });
    }

    const urlMatch = text.match(/https?:\/\/[^\s]+/i);
    const url = urlMatch ? urlMatch[0].trim() : '';
    
    if (!url || !url.includes('instagram.com')) {
        return await sock.sendMessage(chatId, { text: 'Please provide a valid Instagram link.' });
    }

    const loadingMsg = await sock.sendMessage(chatId, { text: '*⏳ Hold on — grabbing your reel...*' });

    try {
        const { media: mediaAssets, caption } = await downloader.download(url);

        const videos = mediaAssets.filter(m => m.type === 'video' || m.extension === 'mp4');
        const images = mediaAssets.filter(m => m.type !== 'video' && m.extension !== 'mp4');

        // If videos exist, send only videos (images are just thumbnails)
        const toSend = videos.length > 0 ? videos : images;

        for (const media of toSend) {
            if (videos.length > 0) {
                const msg = {
                    video: { url: media.url },
                    mimetype: 'video/mp4',
                    caption: caption || undefined
                };
                if (media.thumbnail) msg.jpegThumbnail = media.thumbnail;
                await sock.sendMessage(chatId, msg, { quoted: message });
            } else {
                await sock.sendMessage(chatId, {
                    image: { url: media.url },
                    caption: caption || undefined
                }, { quoted: message });
            }
        }

        await sock.sendMessage(chatId, { text: '*i fetched..*', edit: loadingMsg.key });
    } catch (error) {
        console.error('Instagram download error:', error);
        await sock.sendMessage(chatId, { text: 'Failed to download Instagram media. The post might be private or the link is invalid.' });
    }
}

module.exports = {
    name: 'instagram',
    alias: ['ig', 'insta'],
    async execute(ctx) {
        return instagramCommand(ctx.sock, ctx.chatId, ctx.message);
    }
};
