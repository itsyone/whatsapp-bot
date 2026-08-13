const axios = require('axios');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const ytdlClassic = require('ytdl-core');

const AXIOS_DEFAULTS = {
    timeout: 60000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
    }
};
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const UA = AXIOS_DEFAULTS.headers['User-Agent'];
const YT_COOKIE = process.env.YT_COOKIE || process.env.YOUTUBE_COOKIE || '';
const YT_HEADERS = {
    'User-Agent': UA,
    Referer: 'https://www.youtube.com/',
    Origin: 'https://www.youtube.com',
    ...(YT_COOKIE ? { Cookie: YT_COOKIE } : {})
};

async function tryRequest(getter, attempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await getter();
        } catch (err) {
            lastError = err;
            if (attempt < attempts) {
                await new Promise((r) => setTimeout(r, 1000 * attempt));
            }
        }
    }
    throw lastError;
}

async function downloadUrlToBuffer(url, maxBytes = MAX_VIDEO_BYTES) {
    const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        headers: {
            'User-Agent': UA,
            Referer: 'https://www.youtube.com/',
            Origin: 'https://www.youtube.com',
            Accept: '*/*'
        }
    });

    const buffer = Buffer.from(res.data);
    if (!buffer.length) {
        throw new Error('Empty video download');
    }
    return buffer;
}

function pickBestVideoFormat(formats = []) {
    const mp4Videos = formats.filter((f) =>
        f &&
        f.type === 'video' &&
        (f.extension === 'mp4' || String(f.mime_type || '').includes('video/mp4')) &&
        f.url
    );

    if (!mp4Videos.length) return null;

    // Prefer mp4 that includes audio for direct WhatsApp playback.
    const withAudio = mp4Videos.filter((f) => f.has_audio === true);
    const pool = withAudio.length ? withAudio : mp4Videos;

    // Prefer higher quality labels when possible.
    const preferredOrder = ['1080', '720', '480', '360', '240', '144'];
    for (const q of preferredOrder) {
        const found = pool.find((f) => String(f.quality || '').includes(q));
        if (found) return found;
    }

    return pool[0];
}

function extractYouTubeId(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;

    const patterns = [
        /[?&]v=([a-zA-Z0-9_-]{11})/,
        /youtu\.be\/([a-zA-Z0-9_-]{11})/,
        /\/shorts\/([a-zA-Z0-9_-]{11})/,
        /\/embed\/([a-zA-Z0-9_-]{11})/,
        /\/v\/([a-zA-Z0-9_-]{11})/
    ];

    for (const pattern of patterns) {
        const match = raw.match(pattern);
        if (match?.[1]) return match[1];
    }

    return null;
}

function normalizeYouTubeUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';

    const id = extractYouTubeId(raw);
    if (id) return `https://www.youtube.com/watch?v=${id}`;

    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('youtu.be/')) return `https://${raw}`;
    if (raw.startsWith('youtube.com/')) return `https://${raw}`;

    return raw;
}

function pickPlayableYtdlFormat(formats = []) {
    const mp4 = formats.filter((f) =>
        f &&
        f.hasVideo &&
        f.hasAudio &&
        String(f.container || '').toLowerCase() === 'mp4' &&
        f.url
    );
    if (!mp4.length) return null;

    const preferred = ['18', '22'];
    for (const itag of preferred) {
        const found = mp4.find((f) => String(f.itag) === itag);
        if (found) return found;
    }

    return mp4.sort((a, b) => (b.height || 0) - (a.height || 0))[0] || null;
}

async function getBk9VideoByUrl(youtubeUrl) {
    const apiUrl = `https://api.bk9.dev/download/youtube?url=${encodeURIComponent(youtubeUrl)}`;
    const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));

    const root = res?.data;
    const payload = root?.BK9;
    if (!root?.status || !payload) {
        throw new Error('BK9 API returned invalid response');
    }

    const picked = pickBestVideoFormat(payload.formats || []);
    if (!picked?.url) {
        throw new Error('BK9 API returned no playable mp4 format');
    }

    return {
        download: picked.url,
        title: payload.title || 'Video',
        thumbnail: payload.thumbnail,
        quality: picked.quality || 'mp4'
    };
}

async function getRebixVideoByUrl(youtubeUrl) {
    const apiUrl = `https://api-rebix.vercel.app/api/ytv?url=${encodeURIComponent(youtubeUrl)}`;
    const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));

    const root = res?.data;
    const payload = root?.results;
    if (!root?.status || !payload?.downloadUrl) {
        throw new Error('Video service returned invalid response');
    }

    return {
        download: payload.downloadUrl,
        title: payload.title || 'Video',
        thumbnail: payload.thumbnail || null,
        quality: payload.quality || 'mp4'
    };
}

async function getYtdlVideoByUrl(youtubeUrl) {
    const normalized = normalizeYouTubeUrl(youtubeUrl);
    const id = extractYouTubeId(normalized);
    if (!id) {
        throw new Error('Invalid YouTube URL');
    }
    const canonicalUrl = `https://www.youtube.com/watch?v=${id}`;

    const providers = [
        async () => ytdl.getInfo(canonicalUrl, {
            requestOptions: { headers: YT_HEADERS },
            playerClients: ['WEB', 'ANDROID', 'IOS']
        }),
        async () => ytdlClassic.getInfo(canonicalUrl, {
            requestOptions: { headers: YT_HEADERS }
        })
    ];

    let lastError = null;
    for (const provider of providers) {
        try {
            const info = await provider();
            const format = pickPlayableYtdlFormat(info?.formats || []);
            if (!format?.url) {
                throw new Error('No playable mp4 format found');
            }

            const thumbs = info?.videoDetails?.thumbnails || [];
            return {
                download: format.url,
                title: info?.videoDetails?.title || 'Video',
                thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : null,
                quality: format.qualityLabel || `${format.height || ''}p`.trim() || 'mp4'
            };
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('YTDL fallback failed');
}

async function getVideoFromYoutube(youtubeUrl) {
    try {
        return await getRebixVideoByUrl(youtubeUrl);
    } catch (rebixError) {
        try {
            return await getBk9VideoByUrl(youtubeUrl);
        } catch (bk9Error) {
            try {
                return await getYtdlVideoByUrl(youtubeUrl);
            } catch (fallbackError) {
                throw new Error(
                    `All video providers failed (${rebixError.message}; ${bk9Error.message}; ${fallbackError.message})`
                );
            }
        }
    }
}

function safeFileName(name = 'video') {
    return String(name).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120) || 'video';
}

async function videoCommand(sock, chatId, message) {
    try {
        const text = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
        const searchQuery = text.split(' ').slice(1).join(' ').trim();

        if (!searchQuery) {
            await sock.sendMessage(chatId, { text: 'What video do you want to download?' }, { quoted: message });
            return;
        }

        let videoUrl = '';
        let videoTitle = '';
        let videoThumbnail = '';

        if (searchQuery.startsWith('http://') || searchQuery.startsWith('https://')) {
            videoUrl = searchQuery;
        } else {
            const { videos } = await yts(searchQuery);
            if (!videos || videos.length === 0) {
                await sock.sendMessage(chatId, { text: 'No videos found!' }, { quoted: message });
                return;
            }
            videoUrl = videos[0].url;
            videoTitle = videos[0].title;
            videoThumbnail = videos[0].thumbnail;
        }

        const normalizedVideoUrl = normalizeYouTubeUrl(videoUrl);
        const ytId = extractYouTubeId(normalizedVideoUrl);
        if (!ytId) {
            await sock.sendMessage(chatId, { text: 'This is not a valid YouTube link!' }, { quoted: message });
            return;
        }

        const videoData = await getVideoFromYoutube(normalizedVideoUrl);
        const videoBuffer = await downloadUrlToBuffer(videoData.download);

        await sock.sendMessage(chatId, {
            video: videoBuffer,
            mimetype: 'video/mp4',
            fileName: `${safeFileName(videoData.title || videoTitle || 'video')}.mp4`,
            caption: `${videoData.title || videoTitle || 'Video'}\nQuality: ${videoData.quality}`
        }, { quoted: message });

    } catch (error) {
        console.error('[VIDEO] Command Error:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: 'Video download failed. Try another link, a shorter video, or try again in a moment.'
        }, { quoted: message });
    }
}





module.exports = {
  name: 'video',
  async execute(ctx) {
    return videoCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
