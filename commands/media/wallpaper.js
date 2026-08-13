const fetch = require('node-fetch');

function parseQuery(rawText = '') {
    return String(rawText || '').trim().split(/\s+/).slice(1).join(' ').trim();
}

async function fetchAnimeWallpaper(query = '') {
    if (query) {
        const body = new URLSearchParams({ search: query });
        const res = await fetch('https://animepics.me/api/v3/posts', {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'user-agent': 'Mozilla/5.0'
            },
            body: body.toString()
        });

        if (!res.ok) {
            throw new Error(`Animepics search failed with ${res.status}`);
        }

        const data = await res.json();
        const posts = Array.isArray(data) ? data : [];
        if (posts.length) {
            return posts[Math.floor(Math.random() * posts.length)];
        }
    }

    const fallbackRes = await fetch('https://api.waifu.pics/sfw/waifu', {
        headers: { 'user-agent': 'Mozilla/5.0' }
    });

    if (!fallbackRes.ok) {
        throw new Error(`Wallpaper API failed with ${fallbackRes.status}`);
    }

    const fallback = await fallbackRes.json();
    if (!fallback?.url) {
        throw new Error('Wallpaper API returned no images');
    }

    return {
        id: 'waifu-pics',
        path: fallback.url,
        source: 'waifu.pics'
    };
}

function resolveImageUrl(item) {
    const candidates = [
        item?.file_url,
        item?.large_preview_url,
        item?.preview_url,
        item?.path
    ];
    return candidates.find((value) => String(value || '').trim()) || '';
}

function buildCaption(item, query = '') {
    const tags = Array.isArray(item?.tags)
        ? item.tags.slice(0, 8).join(', ')
        : '';

    return [
        '*Anime Wallpaper*',
        query ? `Query: ${query}` : 'Query: random',
        item?.id ? `ID: ${item.id}` : '',
        tags ? `Tags: ${tags}` : '',
        item?.source ? `Source: ${item.source}` : 'Source: anime wallpaper'
    ].filter(Boolean).join('\n');
}

async function wallpaperCommand(sock, chatId, message, rawText) {
    const query = parseQuery(rawText);

    try {
        const item = await fetchAnimeWallpaper(query);
        const imageUrl = resolveImageUrl(item);

        if (!imageUrl) {
            throw new Error('No wallpaper image URL found');
        }

        await sock.sendMessage(chatId, {
            image: { url: imageUrl },
            caption: buildCaption(item, query)
        }, { quoted: message });
    } catch (error) {
        console.error('Error in wallpaper command:', error);
        await sock.sendMessage(chatId, {
            text: query
                ? `Couldn't find an anime wallpaper for "${query}" right now.`
                : 'Couldn\'t fetch an anime wallpaper right now.'
        }, { quoted: message });
    }
}





module.exports = {
  name: 'wallpaper',
  async execute(ctx) {
    return wallpaperCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.rawText || null);
  }
};
