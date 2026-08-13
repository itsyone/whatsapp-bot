const axios = require('axios').default || require('axios');
const sharp = require('sharp');
const ytmp3v2 = require('../../lib/ytmp3_v2');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const os = require('os');
const fs = require('fs');
const playdl = require('play-dl');

async function downloadToBuffer(url) {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
    return Buffer.from(res.data);
}

function safeFileName(str) {
    return str.replace(/[\\/:"*?<>|]/g, '').substring(0, 50);
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
        } catch (e) {}
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

async function generateVideoPreview(url) {
    const videoId = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/)?.[1];
    if (!videoId) return null;

    const instances = [
        'https://invidious.projectsegfau.lt',
        'https://inv.tux.rs',
        'https://invidious.nerdvpn.de',
        'https://invidious.no-logs.com'
    ];
    
    const proxies = await ytmp3v2.proxyManager.getFastestProxies(5);
    let winningStream = null;
    let winningProxy = null;

    const racePromises = instances.map((inst, i) => {
        const proxy = proxies[i % proxies.length];
        const [h, p] = proxy.split(':');
        const streamUrl = `${inst}/latest_version?id=${videoId}&itag=18`;
        return axios.get(streamUrl, {
            proxy: { host: h, port: parseInt(p) },
            timeout: 3000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }).then(() => ({ streamUrl, proxy }));
    });

    try {
        const winner = await Promise.any(racePromises);
        winningStream = winner.streamUrl;
        winningProxy = winner.proxy;
    } catch (e) {
        try {
            const res = await ytmp3v2.download(url, 'mp4');
            if (res?.downloadURL) winningStream = res.downloadURL;
            else throw new Error();
        } catch (err) { return null; }
    }

    const tempOutput = path.join(os.tmpdir(), `preview_song_${Date.now()}.mp4`);
    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(winningStream);
        if (winningProxy) {
            const [h, p] = winningProxy.split(':');
            cmd.inputOptions([`-http_proxy`, `http://${h}:${p}`]);
        }
        cmd.inputOptions(['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2', '-user_agent', 'Mozilla/5.0'])
            .setStartTime(20)
            .duration(15)
            .size('480x?')
            .noAudio()
            .format('mp4')
            .outputOptions('-movflags frag_keyframe+empty_moov')
            .on('end', () => {
                const buffer = fs.readFileSync(tempOutput);
                fs.unlinkSync(tempOutput);
                resolve(buffer);
            })
            .on('error', (err) => reject(err))
            .save(tempOutput);
    });
}

module.exports = {
    name: 'song',
    alias: ['music'],
    category: 'media',
    desc: 'Download high-quality audio with video preview',
    async execute(sock, message, args) {
        const chatId = message.key.remoteJid;
        const query = args.join(' ');
        if (!query) return sock.sendMessage(chatId, { text: 'Query?' }, { quoted: message });

        try {
            const startTime = Date.now();
            console.log(`🚀 [SONG TURBO] Start: ${query}`);
            
            const searchResult = query.startsWith('http') ? { url: query, title: 'YouTube Audio', thumbnail: null } : await ytmp3v2.search(query);
            const videoUrl = searchResult.url;

            const [convertResult, rawThumbnail, previewBuffer] = await Promise.all([
                ytmp3v2.download(videoUrl, 'mp3'),
                getThumbBuffer(searchResult.thumbnail),
                Promise.race([
                    generateVideoPreview(videoUrl),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))
                ]).catch(() => null)
            ]);
            const thumbnail = await normalizeAudioThumb(rawThumbnail);
            
            if (!convertResult?.downloadURL) throw new Error('Conversion failed');

            if (previewBuffer) {
                await sock.sendMessage(chatId, { video: previewBuffer, caption: `🎬 *Preview:* ${convertResult.title || searchResult.title}`, gifPlayback: true }, { quoted: message });
            } else if (thumbnail) {
                await sock.sendMessage(chatId, { image: thumbnail, caption: `🎶 *Playing:* ${convertResult.title || searchResult.title}` }, { quoted: message });
            }

            const audioBuffer = await ytmp3v2.fetchAudioBuffer(convertResult.downloadURL);
            await sock.sendMessage(chatId, {
                audio: audioBuffer,
                mimetype: 'audio/mpeg',
                fileName: `${safeFileName(convertResult.title || searchResult.title)}.mp3`,
                ...(thumbnail ? { jpegThumbnail: thumbnail } : {}),
                ptt: false
            }, { quoted: message });
            console.log(`✅ [SONG TURBO] Total: ${Date.now() - startTime}ms`);
        } catch (error) {
            console.error('[SONG V2] Error:', error.message);
            await sock.sendMessage(chatId, { text: 'Error: Processing failed.' }, { quoted: message });
        }
    }
};
