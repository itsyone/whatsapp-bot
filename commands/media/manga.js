const axios = require('axios');
const { getBaileys } = require('../../lib/baileys');

const BASE_URL = 'https://api.mangadex.org';
const UPLOADS = 'https://uploads.mangadex.org/covers';
const CHAPTER_WINDOW = 5;
const PAGE_BATCH = 1;
let pollAggregatorPromise = null;

async function getPollAggregator() {
    if (!pollAggregatorPromise) {
        pollAggregatorPromise = getBaileys()
            .then((mod) => mod.getAggregateVotesInPollMessage || mod.default?.getAggregateVotesInPollMessage || null)
            .catch(() => null);
    }
    return pollAggregatorPromise;
}

function cleanText(input = '') {
    return String(input || '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function short(text, max = 360) {
    const t = cleanText(text);
    if (t.length <= max) return t;
    return `${t.slice(0, max - 3)}...`;
}

function getTitle(attrs = {}) {
    return (
        attrs?.title?.en ||
        attrs?.title?.['ja-ro'] ||
        attrs?.title?.ja ||
        Object.values(attrs?.title || {})[0] ||
        'Unknown Title'
    );
}

function getDescription(attrs = {}) {
    return (
        attrs?.description?.en ||
        Object.values(attrs?.description || {})[0] ||
        'No description.'
    );
}

function getSenderJid(message = {}) {
    return (
        message?.key?.participant ||
        message?.key?.remoteJid ||
        ''
    );
}

function parseCoverFromRelationships(manga = {}) {
    const rel = Array.isArray(manga?.relationships) ? manga.relationships : [];
    const coverRel = rel.find((x) => x?.type === 'cover_art');
    return coverRel?.attributes?.fileName || coverRel?.attributes?.filename || null;
}

async function fetchCoverFilename(mangaId, manga = null) {
    const fromRel = parseCoverFromRelationships(manga || {});
    if (fromRel) return fromRel;

    const { data } = await axios.get(`${BASE_URL}/cover`, {
        params: {
            'manga[]': mangaId,
            limit: 1,
            'order[updatedAt]': 'desc'
        },
        timeout: 15000
    });
    const first = Array.isArray(data?.data) ? data.data[0] : null;
    return first?.attributes?.fileName || first?.attributes?.filename || null;
}

function buildCoverUrls(mangaId, fileName) {
    if (!mangaId || !fileName) return { original: null, thumb256: null, thumb512: null };
    const base = `${UPLOADS}/${mangaId}/${fileName}`;
    return {
        original: base,
        thumb256: `${base}.256.jpg`,
        thumb512: `${base}.512.jpg`
    };
}

async function searchManga(query, limit = 8) {
    const { data } = await axios.get(`${BASE_URL}/manga`, {
        params: {
            title: query,
            limit,
            'includes[]': ['cover_art'],
            'contentRating[]': ['safe', 'suggestive', 'erotica', 'pornographic'],
            'order[relevance]': 'desc'
        },
        timeout: 15000
    });
    return Array.isArray(data?.data) ? data.data : [];
}

function normalizeTitleForMatch(text = '') {
    return cleanText(String(text || ''))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function getAltTitles(attrs = {}) {
    const alt = Array.isArray(attrs?.altTitles) ? attrs.altTitles : [];
    return alt.flatMap((entry) => Object.values(entry || {})).filter(Boolean);
}

function scoreMangaResult(manga, query) {
    const attrs = manga?.attributes || {};
    const titles = [getTitle(attrs), ...getAltTitles(attrs)]
        .map(normalizeTitleForMatch)
        .filter(Boolean);
    const q = normalizeTitleForMatch(query);
    if (!q) return 0;

    let score = 0;
    for (const title of titles) {
        if (title === q) score += 120;
        else if (title.startsWith(q)) score += 70;
        else if (title.includes(q)) score += 45;
    }

    const status = String(attrs?.status || '').toLowerCase();
    if (status === 'ongoing' || status === 'completed') score += 4;
    return score;
}

async function getMangaById(id) {
    const { data } = await axios.get(`${BASE_URL}/manga/${encodeURIComponent(id)}`, {
        params: { 'includes[]': ['cover_art', 'author', 'artist'] },
        timeout: 15000
    });
    return data?.data || null;
}

async function getMangaFeed(mangaId, lang = 'en', limit = 100) {
    const params = {
        limit,
        'order[volume]': 'asc',
        'order[chapter]': 'asc'
    };
    if (lang && lang !== 'any') {
        params['translatedLanguage[]'] = [lang];
    }
    const { data } = await axios.get(`${BASE_URL}/manga/${encodeURIComponent(mangaId)}/feed`, {
        params,
        timeout: 15000
    });
    return Array.isArray(data?.data) ? data.data : [];
}

async function getBestFeedForManga(mangaId, attrs = {}, limit = 200) {
    const candidateLangs = [];
    const available = Array.isArray(attrs?.availableTranslatedLanguages)
        ? attrs.availableTranslatedLanguages.filter(Boolean)
        : [];

    if (available.includes('en')) candidateLangs.push('en');
    if (available.includes('en-us')) candidateLangs.push('en-us');
    candidateLangs.push(...available.filter((lang) => !candidateLangs.includes(lang)).slice(0, 4));
    candidateLangs.push('any');

    for (const lang of candidateLangs) {
        const feed = await getMangaFeed(mangaId, lang, limit);
        if (feed.length) return { feed, lang };
    }

    return { feed: [], lang: 'any' };
}

async function pickBestSearchResult(query, results) {
    const ranked = [...results]
        .map((item) => ({ item, score: scoreMangaResult(item, query) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

    let best = null;

    for (const entry of ranked) {
        try {
            const manga = await getMangaById(entry.item.id);
            if (!manga) continue;

            const pickedFeed = await getBestFeedForManga(manga.id, manga.attributes || {}, 60);
            const chapterCount = normalizeChapters(pickedFeed.feed).length;
            const totalScore = entry.score + Math.min(80, chapterCount);

            if (!best || totalScore > best.totalScore) {
                best = {
                    manga,
                    feed: pickedFeed.feed,
                    lang: pickedFeed.lang,
                    totalScore
                };
            }
        } catch {}
    }

    return best;
}

async function getChapterPages(chapterId, quality = 'data-saver') {
    const q = quality === 'data' ? 'data' : 'data-saver';
    const { data } = await axios.get(`${BASE_URL}/at-home/server/${encodeURIComponent(chapterId)}`, {
        timeout: 15000
    });
    const baseUrl = data?.baseUrl;
    const hash = data?.chapter?.hash;
    const files = q === 'data'
        ? (Array.isArray(data?.chapter?.data) ? data.chapter.data : [])
        : (Array.isArray(data?.chapter?.dataSaver) ? data.chapter.dataSaver : []);
    if (!baseUrl || !hash || !files.length) return [];
    return files.map((f) => `${baseUrl}/${q}/${hash}/${f}`);
}

function normalizeChapters(feed = []) {
    const out = [];
    for (const ch of feed) {
        const a = ch?.attributes || {};
        out.push({
            id: ch.id,
            chapter: a.chapter || '?',
            volume: a.volume || '?',
            title: cleanText(a.title || 'Untitled'),
            lang: a.translatedLanguage || 'n/a'
        });
    }
    return out;
}

function getSessions() {
    if (!global.mangaDexSessions) global.mangaDexSessions = {};
    return global.mangaDexSessions;
}

function getPollSessions() {
    if (!global.mangaDexPollSessions) global.mangaDexPollSessions = {};
    return global.mangaDexPollSessions;
}

function sameUser(a, b) {
    const na = String(a || '').split('@')[0].split(':')[0];
    const nb = String(b || '').split('@')[0].split(':')[0];
    return Boolean(na && nb && na === nb);
}

async function sendChapterNavigator(sock, chatId, message, sessionKey, fromIndex = 0) {
    const sessions = getSessions();
    const s = sessions[sessionKey];
    if (!s || !s.chapters?.length) {
        await sock.sendMessage(chatId, { text: 'No manga session found. Use .manga <name> first.' }, { quoted: message });
        return null;
    }

    const start = Math.max(0, Number(fromIndex) || 0);
    s.windowStart = start;
    const end = Math.min(s.chapters.length, start + CHAPTER_WINDOW);
    const show = s.chapters.slice(start, end);

    const prevCmd = '.manga_prev ' + Math.max(0, start - CHAPTER_WINDOW);
    const nextCmd = '.manga_next ' + end;

    try {
        const chapterRows = show.map((c, i) => {
            const idx = start + i + 1;
            const desc = c.title ? c.title.slice(0, 60) : ('Vol ' + c.volume);
            return {
                title: 'Chapter ' + idx + ' (ch ' + c.chapter + ')',
                description: desc,
                rowId: '.manga_read ' + idx
            };
        });

        const navRows = [];
        if (start > 0) {
            navRows.push({
                title: 'Previous Page',
                description: 'Go to chapters ' + Math.max(1, start - CHAPTER_WINDOW + 1) + '-' + start,
                rowId: prevCmd
            });
        }
        if (end < s.chapters.length) {
            navRows.push({
                title: 'Next Page',
                description: 'Go to chapters ' + (end + 1) + '-' + Math.min(s.chapters.length, end + CHAPTER_WINDOW),
                rowId: nextCmd
            });
        }

        await sock.sendMessage(chatId, {
            text: 'Manga: ' + s.name + '\nChapters ' + (start + 1) + '-' + end + ' of ' + s.chapters.length,
            footer: 'Wistoria Manga Reader',
            title: 'Select a chapter',
            buttonText: 'Open Chapter List',
            sections: [
                { title: 'Chapters', rows: chapterRows },
                ...(navRows.length ? [{ title: 'Navigation', rows: navRows }] : [])
            ]
        }, { quoted: message });

        return null;
    } catch (e) {
        console.error('[manga] list message failed:', e?.message || e);
    }

    const lines = [];
    lines.push('Manga: ' + s.name);
    lines.push('Showing chapters ' + (start + 1) + '-' + end + ' of ' + s.chapters.length);
    lines.push('');
    show.forEach((c, i) => {
        const idx = start + i + 1;
        lines.push(idx + '. ch ' + c.chapter + ' (vol ' + c.volume + ')');
        lines.push('   ' + c.title);
    });
    lines.push('');
    lines.push('Use:');
    lines.push('.manga_read <index> [data|saver] [startPage]');
    if (start > 0) lines.push(prevCmd);
    if (end < s.chapters.length) lines.push(nextCmd);

    await sock.sendMessage(chatId, { text: lines.join('\n') }, { quoted: message });
    return null;
}

async function startMangaSession(sock, chatId, message, query) {
    const results = await searchManga(query, 10);
    if (!results.length) {
        await sock.sendMessage(chatId, { text: '❌ Manga not found.' }, { quoted: message });
        return null;
    }

    const picked = await pickBestSearchResult(query, results);
    const manga = picked?.manga;
    if (!manga) {
        await sock.sendMessage(chatId, { text: '❌ Manga details not found.' }, { quoted: message });
        return null;
    }

    const attrs = manga.attributes || {};
    const file = await fetchCoverFilename(manga.id, manga);
    const cover = buildCoverUrls(manga.id, file);
    const feed = Array.isArray(picked?.feed) ? picked.feed : [];
    const chapters = normalizeChapters(feed);

    const sender = getSenderJid(message);
    const sessions = getSessions();
    sessions[sender] = {
        mangaId: manga.id,
        name: getTitle(attrs),
        chapters,
        chapterLang: picked?.lang || 'any',
        windowStart: 0,
        reader: {
            chapterIndex: 1,
            mode: 'saver',
            nextPage: 1,
            lastStart: 1,
            totalPages: 0
        }
    };

    const info =
`╭━━━✦ *${getTitle(attrs)}* ✦━━━╮
┃ 🆔 ${manga.id}
┃ 📊 Status: ${attrs?.status || 'N/A'}
┃ 🕐 Year: ${attrs?.year || 'N/A'}
┃ 📚 Chapters: ${chapters.length}
┃
┃ 📝 Synopsis:
┃ ${short(getDescription(attrs), 220)}
╰━━━━━━━━━━━━━━━━━━━╯`;

    if (cover.thumb512) {
        await sock.sendMessage(chatId, {
            image: { url: cover.thumb512 },
            caption: info
        }, { quoted: message });
    } else {
        await sock.sendMessage(chatId, { text: info }, { quoted: message });
    }

    await sendChapterNavigator(sock, chatId, message, sender, 0);
}

async function sendMangaDetails(sock, chatId, message, mangaId) {
    const manga = await getMangaById(mangaId);
    if (!manga) {
        await sock.sendMessage(chatId, { text: 'Manga not found.' }, { quoted: message });
        return;
    }

    const attrs = manga.attributes || {};
    const file = await fetchCoverFilename(manga.id, manga);
    const cover = buildCoverUrls(manga.id, file);
    const tags = Array.isArray(attrs?.tags)
        ? attrs.tags
              .map((t) => t?.attributes?.name?.en || Object.values(t?.attributes?.name || {})[0])
              .filter(Boolean)
              .slice(0, 6)
              .join(', ')
        : 'N/A';

    const text =
`📖 *${getTitle(attrs)}*
🆔 \`${manga.id}\`
📅 ${attrs?.year || 'N/A'} • ${attrs?.status || 'N/A'}
🏷️ ${tags}

${short(getDescription(attrs), 420)}

🖼️ cover:
${cover.original || 'N/A'}`;

    await sock.sendMessage(chatId, {
        text,
        ...(cover.thumb512
            ? {
                  contextInfo: {
                      externalAdReply: {
                          title: getTitle(attrs),
                          body: 'Manga details',
                          sourceUrl: cover.original || 'https://mangadex.org',
                          mediaType: 1,
                          renderLargerThumbnail: false,
                          showAdAttribution: false,
                          thumbnailUrl: cover.thumb512
                      }
                  }
              }
            : {})
    }, { quoted: message });
}

async function sendMangaChapters(sock, chatId, message, mangaId, lang = 'en') {
    const chapters = normalizeChapters(await getMangaFeed(mangaId, lang, 20));
    if (!chapters.length) {
        await sock.sendMessage(chatId, { text: `No chapters found for lang: ${lang}` }, { quoted: message });
        return;
    }

    const lines = [`📚 *Manga Chapters*`, `manga: \`${mangaId}\``, `lang: ${lang}`, ``];
    for (let i = 0; i < chapters.length; i += 1) {
        const c = chapters[i];
        lines.push(`${i + 1}. ch ${c.chapter} (vol ${c.volume})`);
        lines.push(`   id: \`${c.id}\``);
        lines.push(`   ${c.title}`);
    }
    lines.push('');
    lines.push('Use: `.manga read <chapter-id> [data|saver]`');

    await sock.sendMessage(chatId, { text: lines.join('\n') }, { quoted: message });
}

async function sendChapterReadById(sock, chatId, message, chapterId, mode = 'saver', startPage = 1) {
    const quality = String(mode).toLowerCase() === 'data' ? 'data' : 'data-saver';
    const pages = await getChapterPages(chapterId, quality);
    if (!pages.length) {
        await sock.sendMessage(chatId, { text: 'No pages found for this chapter.' }, { quoted: message });
        return null;
    }

    const start = Math.max(1, Number(startPage) || 1);
    const from = Math.min(pages.length, start) - 1;
    const slice = pages.slice(from, from + PAGE_BATCH);

    for (let i = 0; i < slice.length; i += 1) {
        await sock.sendMessage(chatId, {
            image: { url: slice[i] },
            caption: 'Page ' + (from + i + 1) + '/' + pages.length
        }, { quoted: message });
    }

    return {
        from: from + 1,
        sent: slice.length,
        total: pages.length,
        hasMore: from + slice.length < pages.length,
        nextPage: from + slice.length + 1
    };
}

async function sendChapterReadFromSession(sock, chatId, message, chapterIndex, mode = 'saver', startPage = 1) {
    const sender = getSenderJid(message);
    const sessions = getSessions();
    const s = sessions[sender];
    if (!s || !s.chapters?.length) {
        await sock.sendMessage(chatId, { text: '❌ No manga session found. Use `.manga <name>` first.' }, { quoted: message });
        return;
    }

    const idx = Number(chapterIndex);
    if (!idx || idx < 1 || idx > s.chapters.length) {
        await sock.sendMessage(chatId, { text: `❌ Invalid chapter index. Choose 1-${s.chapters.length}.` }, { quoted: message });
        return;
    }

    const chapter = s.chapters[idx - 1];
    return await sendChapterReadById(sock, chatId, message, chapter.id, mode, startPage);
}

function ensureReaderState(session) {
    if (!session.reader || typeof session.reader !== 'object') {
        session.reader = {
            chapterIndex: 1,
            mode: 'saver',
            nextPage: 1,
            lastStart: 1,
            totalPages: 0
        };
    }
    return session.reader;
}

async function handleSimpleRead(sock, chatId, message, parts) {
    const sender = getSenderJid(message);
    const sessions = getSessions();
    const s = sessions[sender];
    if (!s || !s.chapters?.length) {
        await sock.sendMessage(chatId, { text: '❌ No manga session found. Use `.manga <name>` first.' }, { quoted: message });
        return;
    }

    const reader = ensureReaderState(s);
    const arg1 = (parts[1] || '').toLowerCase();
    const arg2 = (parts[2] || '').toLowerCase();
    const arg3 = (parts[3] || '').toLowerCase();

    let chapterIndex = Number(reader.chapterIndex || 1);
    let mode = reader.mode || 'saver';
    let startPage = 1;

    if (/^\d+$/.test(arg1)) {
        chapterIndex = Number(arg1);
        mode = arg2 === 'data' ? 'data' : 'saver';
        startPage = /^\d+$/.test(arg3) ? Number(arg3) : 1;
    } else if (arg1 === 'data' || arg1 === 'saver') {
        mode = arg1 === 'data' ? 'data' : 'saver';
        startPage = /^\d+$/.test(arg2) ? Number(arg2) : 1;
    }

    const meta = await sendChapterReadFromSession(sock, chatId, message, chapterIndex, mode, startPage);
    if (!meta) return;

    reader.chapterIndex = chapterIndex;
    reader.mode = mode;
    reader.lastStart = meta.from;
    reader.nextPage = meta.hasMore ? meta.nextPage : (meta.total + 1);
    reader.totalPages = meta.total;
}

async function handleSimpleNext(sock, chatId, message) {
    const sender = getSenderJid(message);
    const sessions = getSessions();
    const s = sessions[sender];
    if (!s || !s.chapters?.length) {
        await sock.sendMessage(chatId, { text: '❌ No manga session found. Use `.manga <name>` first.' }, { quoted: message });
        return;
    }

    const reader = ensureReaderState(s);
    const start = Number(reader.nextPage || 1);
    if (reader.totalPages > 0 && start > reader.totalPages) {
        await sock.sendMessage(chatId, { text: '✅ End of chapter reached.\nUse `.read <chapter-index>` to switch chapter.' }, { quoted: message });
        return;
    }

    const meta = await sendChapterReadFromSession(
        sock,
        chatId,
        message,
        Number(reader.chapterIndex || 1),
        reader.mode || 'saver',
        start
    );
    if (!meta) return;

    reader.lastStart = meta.from;
    reader.nextPage = meta.hasMore ? meta.nextPage : (meta.total + 1);
    reader.totalPages = meta.total;
}

async function handleSimplePrev(sock, chatId, message) {
    const sender = getSenderJid(message);
    const sessions = getSessions();
    const s = sessions[sender];
    if (!s || !s.chapters?.length) {
        await sock.sendMessage(chatId, { text: '❌ No manga session found. Use `.manga <name>` first.' }, { quoted: message });
        return;
    }

    const reader = ensureReaderState(s);
    const start = Math.max(1, Number(reader.lastStart || 1) - PAGE_BATCH);
    const meta = await sendChapterReadFromSession(
        sock,
        chatId,
        message,
        Number(reader.chapterIndex || 1),
        reader.mode || 'saver',
        start
    );
    if (!meta) return;

    reader.lastStart = meta.from;
    reader.nextPage = meta.hasMore ? meta.nextPage : (meta.total + 1);
    reader.totalPages = meta.total;
}

async function mangaCommand(sock, chatId, message, rawText = '') {
    try {
        const parts = String(rawText || '').trim().split(/\s+/);
        const cmd = (parts[0] || '').toLowerCase().replace(/^\./, '');
        const sub = (parts[1] || '').toLowerCase();

        if (cmd === 'read') {
            await handleSimpleRead(sock, chatId, message, parts);
            return;
        }

        if (cmd === 'next') {
            await handleSimpleNext(sock, chatId, message);
            return;
        }

        if (cmd === 'prev') {
            await handleSimplePrev(sock, chatId, message);
            return;
        }

        if (cmd === 'manga_prev' || cmd === 'manga_next') {
            const sender = getSenderJid(message);
            const to = Number(parts[1]) || 0;
            await sendChapterNavigator(sock, chatId, message, sender, to);
            return;
        }

        if (cmd === 'manga_read') {
            const chapterIndex = parts[1];
            const mode = (parts[2] || 'saver').toLowerCase();
            const startPage = Number(parts[3] || 1);
            if (!chapterIndex) {
                await sock.sendMessage(chatId, { text: 'Usage: .manga_read <index> [data|saver] [startPage]' }, { quoted: message });
                return;
            }
            const meta = await sendChapterReadFromSession(sock, chatId, message, chapterIndex, mode, startPage);
            const sender = getSenderJid(message);
            const sessions = getSessions();
            const s = sessions[sender];
            if (s && meta) {
                const reader = ensureReaderState(s);
                reader.chapterIndex = Number(chapterIndex) || reader.chapterIndex;
                reader.mode = mode === 'data' ? 'data' : 'saver';
                reader.lastStart = meta.from || startPage;
                reader.nextPage = meta.hasMore ? meta.nextPage : (meta.total + 1);
                reader.totalPages = meta.total || 0;
            }
            return;
        }

        if (!sub || sub === 'help') {
            await sock.sendMessage(chatId, {
                text:
`📚 *Manga Commands*

• \`.manga <query>\` (starts session + navigator)
• \`.manga details <manga-id>\`
• \`.manga chapters <manga-id> [lang]\`
• \`.manga read <chapter-id> [data|saver] [startPage]\`
• \`.manga_prev <index>\`
• \`.manga_next <index>\`
• \`.manga_read <index> [data|saver] [startPage]\``
            }, { quoted: message });
            return;
        }

        if (sub === 'details') {
            const id = parts[2];
            if (!id) {
                await sock.sendMessage(chatId, { text: 'Usage: .manga details <manga-id>' }, { quoted: message });
                return;
            }
            await sendMangaDetails(sock, chatId, message, id);
            return;
        }

        if (sub === 'chapters') {
            const id = parts[2];
            const lang = (parts[3] || 'en').toLowerCase();
            if (!id) {
                await sock.sendMessage(chatId, { text: 'Usage: .manga chapters <manga-id> [lang]' }, { quoted: message });
                return;
            }
            await sendMangaChapters(sock, chatId, message, id, lang);
            return;
        }

        if (sub === 'read') {
            const chapterId = parts[2];
            const mode = (parts[3] || 'saver').toLowerCase();
            const startPage = Number(parts[4] || 1);
            if (!chapterId) {
                await sock.sendMessage(chatId, { text: 'Usage: .manga read <chapter-id> [data|saver] [startPage]' }, { quoted: message });
                return;
            }
            await sendChapterReadById(sock, chatId, message, chapterId, mode, startPage);
            return;
        }

        // Default: treat everything after .manga as search query and start a session.
        const query = parts.slice(1).join(' ').trim();
        if (!query) {
            await sock.sendMessage(chatId, { text: 'Usage: .manga <query>' }, { quoted: message });
            return;
        }
        await startMangaSession(sock, chatId, message, query);
    } catch (error) {
        const apiMsg =
            error?.response?.data?.errors?.[0]?.detail ||
            error?.response?.data?.message ||
            error?.response?.data?.error ||
            error?.message ||
            'Unknown error';
        await sock.sendMessage(chatId, { text: `MangaDex error: ${apiMsg}` }, { quoted: message });
    }
}

async function handleMangaPollVote(sock, update, getMessage) {
    try {
        const key = update?.key;
        const pollUpdates = update?.update?.pollUpdates;
        if (!key?.id || !Array.isArray(pollUpdates) || !pollUpdates.length) return;

        const polls = getPollSessions();
        const pollCtx = polls[key.id];
        if (!pollCtx) return;

        const pollCreation = await getMessage?.(key);
        if (!pollCreation) return;

        const aggregateVotes = await getPollAggregator();
        if (typeof aggregateVotes !== 'function') return;

        const aggregate = aggregateVotes({
            message: pollCreation,
            pollUpdates
        });
        if (!Array.isArray(aggregate) || !aggregate.length) return;

        const selected = aggregate.find((x) => Array.isArray(x.voters) && x.voters.length > 0);
        if (!selected?.name) return;

        // Optional safety: only session owner should control this poll navigation.
        const voter = Array.isArray(selected.voters) ? selected.voters[0] : '';
        if (pollCtx.sessionKey && voter && !sameUser(voter, pollCtx.sessionKey)) {
            return;
        }

        const fakeMessage = { key: { remoteJid: pollCtx.chatId, participant: pollCtx.sessionKey } };
        const option = String(selected.name);

        if (option.includes('⬅️ Prev Page')) {
            await sendChapterNavigator(
                sock,
                pollCtx.chatId,
                fakeMessage,
                pollCtx.sessionKey,
                Math.max(0, pollCtx.start - CHAPTER_WINDOW)
            );
            delete polls[key.id];
            return;
        }
        if (option.includes('➡️ Next Page')) {
            await sendChapterNavigator(
                sock,
                pollCtx.chatId,
                fakeMessage,
                pollCtx.sessionKey,
                pollCtx.end
            );
            delete polls[key.id];
            return;
        }

        const match = option.match(/^(\d+)\s*•/);
        const chapterIndex = match ? Number(match[1]) : NaN;
        if (!Number.isNaN(chapterIndex) && chapterIndex > 0) {
            await sendChapterReadFromSession(sock, pollCtx.chatId, fakeMessage, chapterIndex, 'saver', 1);
            delete polls[key.id];
        }
    } catch (e) {
        console.error('[manga] poll vote handler error:', e?.message || e);
    }
}



module.exports.mangaCommand = mangaCommand;
module.exports.handleMangaPollVote = handleMangaPollVote;


module.exports = {
  name: 'manga',
  handleMangaPollVote, // Inject the named export back in!
  async execute(ctx) {
    return mangaCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.rawText || null);
  }
};
