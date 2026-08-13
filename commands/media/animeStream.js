const axios = require('axios');

const ANIAPI_BASE = 'https://api.aniapi.com/v1';
const JIKAN_BASE = 'https://api.jikan.moe/v4';

function isHtmlPayload(data) {
    if (typeof data !== 'string') return false;
    const t = data.trim().toLowerCase();
    return t.startsWith('<!doctype') || t.startsWith('<html') || t.includes('<body');
}

function cleanText(input = '') {
    return String(input || '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function short(text, max = 320) {
    const t = cleanText(text);
    if (t.length <= max) return t;
    return `${t.slice(0, max - 3)}...`;
}

function normalizeFromAniapi(item = {}) {
    return {
        id: item.id,
        source: 'aniapi',
        title:
            item.titles?.en ||
            item.titles?.en_jp ||
            item.titles?.jp ||
            item.title ||
            'Unknown',
        cover:
            item.cover_image ||
            item.coverImage ||
            item.banner_image ||
            item.image ||
            null,
        description:
            item.descriptions?.en || item.description || item.synopsis || '',
        year: item.start_date ? String(item.start_date).slice(0, 4) : item.season_year || 'N/A',
        status: item.status || 'N/A',
        episodes: item.episodes_count || item.total_episodes || '?',
        genres: Array.isArray(item.genres) ? item.genres : [],
        raw: item
    };
}

function normalizeFromJikan(item = {}) {
    return {
        id: item.mal_id,
        source: 'jikan',
        title: item.title || item.title_english || item.title_japanese || 'Unknown',
        cover: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || null,
        description: item.synopsis || '',
        year: item.year || (item.aired?.from ? String(item.aired.from).slice(0, 4) : 'N/A'),
        status: item.status || 'N/A',
        episodes: item.episodes || '?',
        genres: Array.isArray(item.genres) ? item.genres.map((g) => g.name).filter(Boolean) : [],
        raw: item
    };
}

async function fetchAniapi(path, params = {}) {
    try {
        const { data } = await axios.get(`${ANIAPI_BASE}${path}`, {
            params,
            timeout: 12000,
            validateStatus: () => true
        });
        if (isHtmlPayload(data)) return null;
        return data;
    } catch {
        return null;
    }
}

async function fetchAnimeByQuery(query) {
    const aniapi = await fetchAniapi('/anime', { title: query, per_page: 8 });
    const aniDocs = aniapi?.data?.documents;
    if (Array.isArray(aniDocs) && aniDocs.length) {
        return aniDocs.map(normalizeFromAniapi);
    }

    // AniAPI is often down/parked. Auto-fallback so command remains usable.
    const { data } = await axios.get(`${JIKAN_BASE}/anime`, {
        params: { q: query, limit: 8 },
        timeout: 12000
    });
    const list = Array.isArray(data?.data) ? data.data : [];
    return list.map(normalizeFromJikan);
}

async function fetchAnimeById(id) {
    const aniapi = await fetchAniapi(`/anime/${encodeURIComponent(id)}`);
    const docs = aniapi?.data?.documents;
    if (Array.isArray(docs) && docs.length) return normalizeFromAniapi(docs[0]);
    if (aniapi?.data && !Array.isArray(aniapi.data)) return normalizeFromAniapi(aniapi.data);

    const { data } = await axios.get(`${JIKAN_BASE}/anime/${encodeURIComponent(id)}`, {
        timeout: 12000
    });
    if (!data?.data) return null;
    return normalizeFromJikan(data.data);
}

async function fetchAniapiEpisode(animeId, episodeNo) {
    const data = await fetchAniapi('/episode', {
        anime_id: animeId,
        number: episodeNo,
        per_page: 10
    });
    const docs = data?.data?.documents;
    if (!Array.isArray(docs) || !docs.length) return null;
    return docs.find((x) => Number(x.number) === Number(episodeNo)) || docs[0];
}

function getEpisodeLinks(ep = {}) {
    const links = [];
    const direct = [
        ep.url,
        ep.stream_url,
        ep.streamUrl,
        ep.video_url,
        ep.videoUrl
    ].filter((x) => typeof x === 'string' && x.startsWith('http'));
    links.push(...direct);

    const arrCandidates = [ep.videos, ep.sources, ep.links, ep.streams];
    for (const arr of arrCandidates) {
        if (!Array.isArray(arr)) continue;
        for (const x of arr) {
            if (typeof x === 'string' && x.startsWith('http')) links.push(x);
            else if (x && typeof x === 'object') {
                const u = x.url || x.src || x.link;
                if (typeof u === 'string' && u.startsWith('http')) links.push(u);
            }
        }
    }

    return Array.from(new Set(links));
}

async function fetchJikanEpisode(animeId, episodeNo) {
    try {
        const { data } = await axios.get(`${JIKAN_BASE}/anime/${encodeURIComponent(animeId)}/episodes`, {
            params: { page: 1 },
            timeout: 12000
        });
        const eps = Array.isArray(data?.data) ? data.data : [];
        return eps.find((x) => Number(x.mal_id) === Number(episodeNo) || Number(x.mal_id) === Number(episodeNo)) ||
            eps.find((x) => Number(x.mal_id) === Number(episodeNo)) ||
            eps.find((x) => Number(x.episode_id) === Number(episodeNo)) ||
            eps.find((x) => Number(x.mal_id) === Number(episodeNo)) ||
            eps.find((x) => Number(x.episode_id) === Number(episodeNo)) ||
            eps.find((x) => Number(x?.mal_id) >= 0 && Number(episodeNo) === Number(x?.mal_id)) ||
            eps.find((x) => Number(x?.episode_id) >= 0 && Number(episodeNo) === Number(x?.episode_id)) ||
            null;
    } catch {
        return null;
    }
}

async function sendCard(sock, chatId, text, quoted, thumbUrl) {
    const contextInfo = thumbUrl
        ? {
              externalAdReply: {
                  title: 'Wistoria Anime',
                  body: 'AniAPI',
                  sourceUrl: 'https://aniapi.com',
                  mediaType: 1,
                  renderLargerThumbnail: false,
                  showAdAttribution: false,
                  thumbnailUrl: thumbUrl
              }
          }
        : undefined;

    await sock.sendMessage(
        chatId,
        {
            text,
            ...(contextInfo ? { contextInfo } : {})
        },
        { quoted }
    );
}

async function animeStreamCommand(sock, chatId, message, rawText = '') {
    try {
        const args = String(rawText || '').trim().split(/\s+/).slice(1);
        if (!args.length) {
            await sock.sendMessage(
                chatId,
                {
                    text:
`🎬 *Anime*

• \`.anime <name>\`
• \`.anime info <id>\`
• \`.anime watch <id> <season> <episode>\`

Example: \`.anime dragon ball\``
                },
                { quoted: message }
            );
            return;
        }

        const sub = String(args[0] || '').toLowerCase();

        if (sub === 'info') {
            const id = args[1];
            if (!id) {
                await sock.sendMessage(chatId, { text: 'Use: .anime info <id>' }, { quoted: message });
                return;
            }

            const anime = await fetchAnimeById(id);
            if (!anime) {
                await sock.sendMessage(chatId, { text: 'Anime not found.' }, { quoted: message });
                return;
            }

            const line =
`🎬 *${anime.title}*
🆔 ${anime.id}
📅 ${anime.year} • 📺 ${anime.episodes} ep
🏷 ${anime.status}
🎭 ${anime.genres.slice(0, 5).join(', ') || 'N/A'}

${short(anime.description || 'No description.')}`;

            await sendCard(sock, chatId, line, message, anime.cover);
            return;
        }

        if (sub === 'watch') {
            const id = args[1];
            const season = Number(args[2] || 1);
            const episodeNo = Number(args[3] || 1);

            if (!id || Number.isNaN(episodeNo)) {
                await sock.sendMessage(
                    chatId,
                    { text: 'Use: .anime watch <id> <season> <episode>' },
                    { quoted: message }
                );
                return;
            }

            const anime = await fetchAnimeById(id);
            if (!anime) {
                await sock.sendMessage(chatId, { text: 'Anime not found.' }, { quoted: message });
                return;
            }

            const aniEpisode = await fetchAniapiEpisode(id, episodeNo);
            const aniLinks = aniEpisode ? getEpisodeLinks(aniEpisode) : [];
            if (aniLinks.length) {
                await sendCard(
                    sock,
                    chatId,
`🎬 *${anime.title}*
🆔 ${anime.id}
📺 S${season} • E${episodeNo}

🔗 ${aniLinks.slice(0, 3).join('\n🔗 ')}`,
                    message,
                    anime.cover
                );
                return;
            }

            const ep = await fetchJikanEpisode(anime.id, episodeNo);
            const malAnime = anime.raw?.url;
            const epUrl = ep?.url;
            const links = [epUrl, malAnime].filter(Boolean);

            await sendCard(
                sock,
                chatId,
`🎬 *${anime.title}*
🆔 ${anime.id}
📺 S${season} • E${episodeNo}

Direct episode stream is unavailable from AniAPI right now.
${links.length ? `\nReference:\n${links.map((x) => `🔗 ${x}`).join('\n')}` : ''}`,
                message,
                anime.cover
            );
            return;
        }

        const query = args.join(' ');
        const list = await fetchAnimeByQuery(query);
        if (!list.length) {
            await sock.sendMessage(chatId, { text: 'No anime found for that query.' }, { quoted: message });
            return;
        }

        const top = list.slice(0, 6);
        const lines = top.map((x, i) => `${i + 1}. *${x.title}*\n   ID: ${x.id} • ${x.year} • ${x.episodes} ep`);
        await sendCard(
            sock,
            chatId,
`🎬 *Anime Results* for: *${query}*

${lines.join('\n')}

Use:
• \`.anime info <id>\`
• \`.anime watch <id> <season> <episode>\``,
            message,
            top[0]?.cover || null
        );
    } catch (error) {
        console.error('[animeStream] error:', error?.message || error);
        await sock.sendMessage(chatId, { text: 'Anime fetch failed. Try again in a moment.' }, { quoted: message });
    }
}





module.exports = {
  name: 'animeStream',
  async execute(ctx) {
    return animeStreamCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.rawText || null);
  }
};
