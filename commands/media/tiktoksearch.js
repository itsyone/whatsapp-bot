const axios = require('axios');

const CONFIG = {
    MAX_RESULTS: 10,
    SEARCH_TIMEOUT: 20000,
    MAX_QUERY_LENGTH: 120
};

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
];

function pickUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function normalizeQuery(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, CONFIG.MAX_QUERY_LENGTH);
}

function getRawText(message) {
    return message?.message?.conversation || message?.message?.extendedTextMessage?.text || '';
}

function decodeHtml(value) {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function formatCount(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
    return String(n);
}

function formatDuration(value) {
    const total = Math.max(0, Number(value || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = Math.floor(total % 60);
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function pickVideoUrl(video = {}) {
    if (video.downloadAddr) return video.downloadAddr;
    if (video.playAddr) return video.playAddr;
    const bitrateList = Array.isArray(video.bitrateInfo) ? video.bitrateInfo : [];
    for (const item of bitrateList) {
        const list = item?.PlayAddr?.UrlList;
        if (Array.isArray(list) && list[0]) return list[0];
    }
    return '';
}

function normalizeVideo(itemStruct = {}) {
    const author = itemStruct.author || {};
    const stats = itemStruct.stats || {};
    const video = itemStruct.video || {};
    const videoUrl = pickVideoUrl(video);
    if (!videoUrl) return null;

    const rawTitle = (
        itemStruct.desc ||
        itemStruct.title ||
        itemStruct.caption ||
        itemStruct.name ||
        itemStruct.text ||
        ''
    );

    const nickname = (
        author.nickname ||
        author.uniqueId ||
        author.unique_id ||
        author.name ||
        itemStruct.nickname ||
        'Unknown Creator'
    );

    const uniqueId = (
        author.uniqueId ||
        author.unique_id ||
        author.secUid ||
        itemStruct.username ||
        itemStruct.unique_id ||
        itemStruct.uniqueId ||
        nickname
    );

    return {
        id: String(itemStruct.id || ''),
        title: decodeHtml(rawTitle).trim(),
        duration: Number(
            video.duration ||
            itemStruct.duration ||
            itemStruct.video_duration ||
            itemStruct.play_time ||
            0
        ),
        videoUrl,
        sourceUrl: itemStruct.sourceUrl || '',
        author: {
            nickname: decodeHtml(nickname).trim(),
            unique_id: decodeHtml(uniqueId).trim()
        },
        stats: {
            digg_count: Number(
                stats.diggCount ||
                stats.digg_count ||
                itemStruct.digg_count ||
                itemStruct.likes ||
                itemStruct.like_count ||
                0
            ),
            comment_count: Number(
                stats.commentCount ||
                stats.comment_count ||
                itemStruct.comment_count ||
                itemStruct.comments ||
                0
            ),
            share_count: Number(
                stats.shareCount ||
                stats.share_count ||
                itemStruct.share_count ||
                itemStruct.shares ||
                0
            )
        }
    };
}

function collectVideos(node, output, seen) {
    if (!node || typeof node !== 'object') return;

    if (node.itemStruct && typeof node.itemStruct === 'object') {
        const normalized = normalizeVideo(node.itemStruct);
        if (normalized && normalized.id && !seen.has(normalized.id)) {
            seen.add(normalized.id);
            output.push(normalized);
        }
    }

    if (node.video && node.author && (node.desc || node.title || node.id)) {
        const normalized = normalizeVideo(node);
        if (normalized && normalized.id && !seen.has(normalized.id)) {
            seen.add(normalized.id);
            output.push(normalized);
        }
    }

    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const entry of value) collectVideos(entry, output, seen);
        } else if (value && typeof value === 'object') {
            collectVideos(value, output, seen);
        }
    }
}

function extractEmbeddedJson(html) {
    const patterns = [
        /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">([\s\S]*?)<\/script>/i,
        /<script id="SIGI_STATE" type="application\/json">([\s\S]*?)<\/script>/i
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match?.[1]) return match[1];
    }

    return '';
}

async function searchTikTok(query) {
    try {
        const { data } = await axios.get('https://api-rebix.vercel.app/api/tiktoksearch', {
            params: { q: query },
            timeout: CONFIG.SEARCH_TIMEOUT,
            headers: {
                'User-Agent': pickUA(),
                Accept: 'application/json'
            }
        });

        const list = Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data?.result)
                ? data.result
                : Array.isArray(data?.results)
                    ? data.results
                    : [];

        const normalized = list.map((item) => normalizeVideo({
            id: item?.id || item?.aweme_id || item?.video_id,
            desc: item?.title || item?.desc || item?.caption,
            sourceUrl: item?.url || item?.share_url || item?.shareUrl,
            author: {
                nickname: item?.author?.nickname || item?.author?.name || item?.nickname,
                uniqueId: item?.author?.unique_id || item?.author?.uniqueId || item?.username || item?.unique_id
            },
            stats: {
                diggCount: item?.stats?.diggCount || item?.stats?.digg_count || item?.digg_count || item?.likes,
                commentCount: item?.stats?.commentCount || item?.stats?.comment_count || item?.comment_count || item?.comments,
                shareCount: item?.stats?.shareCount || item?.stats?.share_count || item?.share_count || item?.shares
            },
            video: {
                duration: item?.duration || item?.video?.duration,
                downloadAddr: item?.media?.no_watermark || item?.video || item?.play || item?.play_url || item?.wmplay || item?.video?.playAddr
            }
        })).filter(Boolean);

        if (normalized.length) return normalized.slice(0, CONFIG.MAX_RESULTS);
    } catch {}

    try {
        const { data } = await axios.post('https://www.tikwm.com/api/feed/search', {
            keywords: query,
            count: CONFIG.MAX_RESULTS,
            cursor: 0,
            web: 1
        }, {
            timeout: CONFIG.SEARCH_TIMEOUT,
            headers: {
                'User-Agent': pickUA(),
                Accept: 'application/json, text/plain, */*',
                'Content-Type': 'application/json'
            }
        });

        const list = Array.isArray(data?.data?.videos)
            ? data.data.videos
            : Array.isArray(data?.data?.aweme_list)
                ? data.data.aweme_list
                : [];

        const normalized = list.map((item) => normalizeVideo({
            id: item?.video_id || item?.aweme_id || item?.id,
            desc: item?.title || item?.desc,
            sourceUrl: item?.url || item?.share_url || item?.shareUrl,
            author: {
                nickname: item?.author?.nickname || item?.author?.name,
                uniqueId: item?.author?.unique_id || item?.author?.uniqueId
            },
            stats: {
                diggCount: item?.digg_count || item?.stats?.diggCount || item?.stats?.digg_count,
                commentCount: item?.comment_count || item?.stats?.commentCount || item?.stats?.comment_count,
                shareCount: item?.share_count || item?.stats?.shareCount || item?.stats?.share_count
            },
            video: {
                duration: item?.duration || item?.video?.duration,
                downloadAddr: item?.wmplay || item?.play || item?.video?.downloadAddr || item?.video?.playAddr
            }
        })).filter(Boolean);

        if (normalized.length) return normalized.slice(0, CONFIG.MAX_RESULTS);
    } catch {}

    const url = `https://www.tiktok.com/search/video?q=${encodeURIComponent(query)}`;
    const { data } = await axios.get(url, {
        timeout: CONFIG.SEARCH_TIMEOUT,
        headers: {
            'User-Agent': pickUA(),
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://www.tiktok.com/',
            DNT: '1'
        }
    });

    const embedded = extractEmbeddedJson(String(data || ''));
    if (!embedded) return [];

    const parsed = JSON.parse(embedded);
    const videos = [];
    const seen = new Set();
    collectVideos(parsed, videos, seen);
    return videos.slice(0, CONFIG.MAX_RESULTS);
}

function makeVideoInfo(item) {
    const title = item.title || `${item.author.nickname} の動画`;
    const creatorHandle = item.author.unique_id && item.author.unique_id !== item.author.nickname
        ? `@${item.author.unique_id}`
        : `@${item.author.nickname.replace(/\s+/g, '_')}`;

    return [
        '🩵 ｡ﾟ･ 𝑻𝒊𝒌𝑻𝒐𝒌 みつけたよ ･ﾟ｡',
        '',
        `💙 ${title}`,
        `🩷 Creator: ${item.author.nickname} (${creatorHandle})`,
        `🫧 Duration: ${formatDuration(item.duration)}`,
        `💗 Likes: ${formatCount(item.stats.digg_count)}`,
        `🩵 Comments: ${formatCount(item.stats.comment_count)}`,
        `💙 Shares: ${formatCount(item.stats.share_count)}`,
        '',
        '૮₍ ˶ᵔ ᵕ ᵔ˶ ₎ა'
    ].join('\n');
}

function makeSourceUrl(item) {
    if (item?.sourceUrl) return item.sourceUrl;
    const author = String(item?.author?.unique_id || '').trim();
    const id = String(item?.id || '').trim();
    if (author && id) return `https://www.tiktok.com/@${author}/video/${id}`;
    return 'https://www.tiktok.com/';
}

async function tiktokSearchCommand(sock, chatId, message) {
    const rawText = getRawText(message);
    const query = normalizeQuery(rawText.replace(/^\.(?:ttsearch|tiktoksearch)\b/i, ''));

    if (!query) {
        await sock.sendMessage(chatId, {
            text: 'Usage: .ttsearch <query>'
        }, { quoted: message });
        return;
    }

    try {
        await sock.sendMessage(chatId, {
            react: { text: '🔎', key: message.key }
        });

        const videos = await searchTikTok(query);
        if (!videos.length) {
            await sock.sendMessage(chatId, {
                text: 'No TikTok videos found for that query.'
            }, { quoted: message });
            return;
        }

        const cards = videos.map((item) => ({
            video: { url: item.videoUrl },
            caption: makeVideoInfo(item),
            footer: 'TikTok Search',
            nativeFlow: [{
                text: 'Open',
                url: makeSourceUrl(item)
            }]
        }));

        await sock.sendMessage(chatId, {
            text: `TikTok search results for: ${query}`,
            footer: `${cards.length} result${cards.length === 1 ? '' : 's'}`,
            cards
        }, { quoted: message });
    } catch (error) {
        console.error('[ttsearch] error:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: 'Failed to fetch TikTok search results.'
        }, { quoted: message });
    }
}





module.exports = {
  name: 'tiktoksearch',
  async execute(ctx) {
    return tiktokSearchCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
