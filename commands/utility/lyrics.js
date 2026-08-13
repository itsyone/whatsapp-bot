const fetch = require('node-fetch');

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0' }
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }

    return res.json();
}

function normalizeLyrics(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function fetchLyricsFromCurrentApi(query) {
    const data = await fetchJson(`https://apis-devlostboysearch.vercel.app/lyrics?song=${encodeURIComponent(query)}`);
    return (
        data?.lyrics ||
        data?.result?.lyrics ||
        data?.result?.song_lyrics ||
        data?.data?.lyrics ||
        ''
    );
}

async function fetchLyricsFromLrcLib(query) {
    const data = await fetchJson(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`);
    if (!Array.isArray(data) || !data.length) return '';

    const picked = data.find((item) => item?.plainLyrics) || data[0];
    return picked?.plainLyrics || picked?.syncedLyrics || '';
}

async function fetchLyricsFromLyricsOvh(query) {
    const parts = query.split(/\s*-\s*/);
    if (parts.length < 2) return '';

    const artist = parts.shift();
    const title = parts.join(' - ');
    const data = await fetchJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
    return data?.lyrics || '';
}

async function getLyrics(query) {
    const sources = [
        fetchLyricsFromCurrentApi,
        fetchLyricsFromLrcLib,
        fetchLyricsFromLyricsOvh
    ];

    for (const source of sources) {
        try {
            const lyrics = normalizeLyrics(await source(query));
            if (lyrics) return lyrics;
        } catch {}
    }

    return '';
}

async function lyricsCommand(sock, chatId, songTitle, message) {
    const query = String(songTitle || '').trim();

    if (!query) {
        await sock.sendMessage(chatId, {
            text: 'Please enter a song name. Usage: `.lyrics believer`'
        }, { quoted: message });
        return;
    }

    try {
        const lyrics = await getLyrics(query);

        if (!lyrics) {
            await sock.sendMessage(chatId, {
                text: `Lyrics not found for "${query}".\nTry a more specific query like \`artist - song\`.`
            }, { quoted: message });
            return;
        }

        const maxChars = 4096;
        const prefix = `Lyrics for "${query}"\n\n`;
        const output = lyrics.length + prefix.length > maxChars
            ? `${prefix}${lyrics.slice(0, maxChars - prefix.length - 3)}...`
            : `${prefix}${lyrics}`;

        await sock.sendMessage(chatId, { text: output }, { quoted: message });
    } catch (error) {
        console.error('Error in lyrics command:', error);
        await sock.sendMessage(chatId, {
            text: `An error occurred while fetching lyrics for "${query}".`
        }, { quoted: message });
    }
}





module.exports = {
  name: 'lyrics',
  async execute(ctx) {
    const query = Array.isArray(ctx.args) ? ctx.args.join(' ').trim() : String(ctx.rawText || ctx.userMessage || '').replace(/^\.lyrics\b/i, '').trim();
    return lyricsCommand(ctx.sock || null, ctx.chatId || null, query, ctx.message || null);
  }
};
