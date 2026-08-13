const axios = require('axios').default || require('axios');
const sharp = require('sharp');
const ytmp3v2 = require('../../lib/ytmp3_v2');

async function retryOnceOnRateLimit(task, delayMs = 1200) {
    try {
        return await task();
    } catch (error) {
        const status = Number(error?.response?.status || 0);
        if (status !== 429) throw error;
        await new Promise((resolve) => setTimeout(resolve, delayMs)); // FIXED: single retry on provider rate limit
        return task();
    }
}

async function downloadToBuffer(url) {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 5000 });
    return Buffer.from(res.data);
}

function withTimeout(promise, ms, fallback = null) {
    return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
    ]);
}

async function getThumbBuffer(url) {
    const videoId = String(url || '').match(/\/vi\/([a-zA-Z0-9_-]{11})\//)?.[1];
    const candidates = [];

    if (videoId) {
        candidates.push(
            `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
            `https://i.ytimg.com/vi/${videoId}/hq720.jpg`,
            `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
            `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        );
    }

    if (url) {
        candidates.push(url);
    }

    for (const candidate of candidates) {
        try {
            const buffer = await downloadToBuffer(candidate);
            if (buffer && buffer.length > 8 * 1024) return buffer;
        } catch {}
    }
    return null;
}

async function normalizeAudioThumb(buffer) {
    if (!buffer?.length) return null;
    try {
        return await sharp(buffer)
            .jpeg({ quality: 90, mozjpeg: true })
            .toBuffer();
    } catch {
        return buffer;
    }
}

function safeFileName(name = 'song') {
    return String(name).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 100) || 'song';
}

async function playCommand(sock, chatId, message) {
    const text = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
    const query = text.split(' ').slice(1).join(' ').trim();

    if (!query) {
        return sock.sendMessage(chatId, { text: 'Error: Please enter song name' }, { quoted: message });
    }

    try {
        const startTime = Date.now();
        console.log(`[PLAY] Start: ${query}`);
        
        // 1. Search & Get URL
        const searchResult = query.startsWith('http')
            ? { url: query, title: 'YouTube Audio', thumbnail: null }
            : await retryOnceOnRateLimit(() => ytmp3v2.search(query));
        const videoUrl = searchResult.url;
        console.log(`[PLAY] Search Done in ${Date.now() - startTime}ms: ${videoUrl}`);

        // 2. Start thumbnail and conversion together
        const thumbPromise = getThumbBuffer(searchResult.thumbnail);
        const convertStart = Date.now();
        const [result, rawThumbnail] = await Promise.all([
            retryOnceOnRateLimit(() => ytmp3v2.download(videoUrl, 'mp3')),
            withTimeout(thumbPromise, 3000, null)
        ]);
        const thumbnail = await normalizeAudioThumb(rawThumbnail);
        if (!result?.downloadURL) throw new Error('No download link found');
        console.log(`[PLAY] Conversion Done in ${Date.now() - convertStart}ms: ${result.downloadURL}`);

        // 3. Send Image first (Quoted)
        if (thumbnail) {
            await sock.sendMessage(chatId, { 
                image: thumbnail, 
                caption: `🎶 *Playing:* ${result.title || searchResult.title}` 
            }, { quoted: message });
        }

        // 4. Upload audio from our side so WA does not need to fetch a flaky remote URL.
        const deliveryStart = Date.now();
        const audioBuffer = await retryOnceOnRateLimit(() => ytmp3v2.fetchAudioBuffer(result.downloadURL));
        await sock.sendMessage(chatId, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            fileName: `${safeFileName(result.title || searchResult.title)}.mp3`,
            ...(thumbnail ? { jpegThumbnail: thumbnail } : {}),
            ptt: false
        }, { quoted: message });

        console.log(`[PLAY] Delivered to WA in ${Date.now() - deliveryStart}ms`);
        console.log(`[PLAY] Total Time: ${Date.now() - startTime}ms`);

    } catch (error) {
        const status = Number(error?.response?.status || 0);
        const reply = status === 429
            ? 'Error: audio provider is rate-limited right now. Try again in a moment.'
            : `Error: ${error.message || 'Unknown Error'}`;
        console.error('[PLAY V2] Error:', error.message);
        await sock.sendMessage(chatId, { text: reply }, { quoted: message }); // FIXED: clearer play rate-limit reply
    }
}

module.exports = {
    name: 'play',
    async execute(ctx) {
        return playCommand(ctx.sock, ctx.chatId, ctx.message);
    }
};
