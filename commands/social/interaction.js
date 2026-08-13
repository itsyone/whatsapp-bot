const axios = require('axios');

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

const CONFIG = {
    timeout: 9000,
    endpoints: {
        api: 'https://tenor.googleapis.com/v2/search',
        apiKey: 'AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ'
    }
};

const SUPPORTED = ['hug', 'kiss', 'slap', 'pat', 'wave', 'dance', 'fuck', 'laugh', 'bonk', 'bite', 'poke', 'cry', 'wink', 'nom', 'face-palm', 'kill'];

const ACTION_TEXT = {
    hug: 'hugged',
    kiss: 'kissed',
    slap: 'slapped',
    pat: 'patted',
    wave: 'waved at',
    dance: 'danced with',
    fuck: 'fucked',
    laugh: 'laughed at',
    bonk: 'bonked',
    bite: 'bit',
    poke: 'poked',
    cry: 'cried over',
    wink: 'winked at',
    nom: 'nommed',
    'face-palm': 'face-palmed at',
    kill: 'killed'
};

class TenorScraper {
    constructor(options = {}) {
        this.config = { ...CONFIG, ...options };
    }

    getRandomUA() {
        return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    }

    extractMedia(items, limit) {
        const results = [];
        for (const item of items) {
            if (results.length >= limit) break;
            const media = item?.media_formats || item?.media || {};
            // Prefer mp4 first for WhatsApp gifPlayback.
            const url = media.mp4?.url || media.nanomp4?.url || media.tinymp4?.url || media.gif?.url || media.tinygif?.url;
            if (!url) continue;
            const full = url.startsWith('http') ? url : `https:${url}`;
            results.push({
                url: full,
                type: full.includes('.mp4') ? 'mp4' : 'gif'
            });
        }
        return results;
    }

    async scrapeApi(query, limit) {
        const url = `${this.config.endpoints.api}?q=${encodeURIComponent(query)}&key=${this.config.endpoints.apiKey}&limit=${limit + 3}&media_filter=gif,mp4`;
        const { data } = await axios.get(url, {
            headers: { 'User-Agent': this.getRandomUA() },
            timeout: this.config.timeout
        });
        return this.extractMedia(data?.results || [], limit);
    }

    async scrapeNextData(query, limit) {
        const url = `https://tenor.com/search/${encodeURIComponent(query).replace(/%20/g, '-')}-gifs`;
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': this.getRandomUA(),
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: this.config.timeout
        });
        const match = data.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s);
        if (!match) return [];
        const json = JSON.parse(match[1]);
        const results = json?.props?.pageProps?.results || json?.props?.pageProps?.searchResults || [];
        return this.extractMedia(results, limit);
    }

    async scrapeMobile(query, limit) {
        const url = `https://tenor.com/search/${encodeURIComponent(query)}-gifs`;
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15'
            },
            timeout: this.config.timeout
        });
        const matches = data.match(/https:\/\/media\.tenor\.com\/[^"'\s]+?\.(gif|mp4)/gi) || [];
        const unique = [...new Set(matches)];
        return unique.slice(0, limit).map((u) => ({
            url: u,
            type: u.endsWith('.mp4') ? 'mp4' : 'gif'
        }));
    }

    async search(query, limit = 6) {
        const methods = [
            this.scrapeApi(query, limit),
            this.scrapeNextData(query, limit),
            this.scrapeMobile(query, limit)
        ];
        
        try {
            // Return the first successful result
            const results = await Promise.any(methods);
            return results || [];
        } catch (err) {
            return [];
        }
    }

    async download(url, maxSizeMB = 15) {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': this.getRandomUA(),
                Accept: '*/*'
            },
            timeout: 20000,
            maxContentLength: maxSizeMB * 1024 * 1024,
            maxBodyLength: maxSizeMB * 1024 * 1024
        });
        return Buffer.from(response.data);
    }
}

const scraper = new TenorScraper();

function parseCommand(rawText) {
    let cmd = String(rawText || '').trim().toLowerCase().split(/\s+/)[0].replace(/^\./, '');
    if (cmd === 'facepalm') cmd = 'face-palm';
    return SUPPORTED.includes(cmd) ? cmd : '';
}

function getTargetFromQuote(message) {
    return message?.message?.extendedTextMessage?.contextInfo?.participant || '';
}

function getTargetsFromMention(message, actorJid = '') {
    const ctx = message?.message?.extendedTextMessage?.contextInfo;
    const list = Array.isArray(ctx?.mentionedJid) ? ctx.mentionedJid : [];
    if (!list.length) return [];
    const actor = String(actorJid || '').trim();
    return list.filter((jid) => String(jid || '').trim() && String(jid || '').trim() !== actor);
}

function uniqueTargets(list) {
    const seen = new Set();
    const out = [];
    for (const jid of list) {
        const j = String(jid || '').trim();
        if (!j || seen.has(j)) continue;
        seen.add(j);
        out.push(j);
    }
    return out;
}

function mentionTag(jid) {
    return `@${String(jid || '').split('@')[0]}`;
}

function buildSearchQueries(action, targetCount) {
    const count = Math.max(1, Number(targetCount || 1));
    const list = [];

    if (action === 'kill' && count > 1) {
        list.push('anime kill all');
        list.push(`anime kill ${count} people`);
        list.push('anime massacre');
    } else if (count > 1) {
        list.push(`anime ${action} ${count} friends`);
        list.push(`anime ${action} group`);
        list.push(`anime ${action} multiple`);
    }

    list.push(`anime ${action}`);
    list.push(`${action} anime`);
    return [...new Set(list)];
}

async function interactionCommand(sock, chatId, message, rawText) {
    try {
        const action = parseCommand(rawText);
        if (!action) return;

        const actor = message?.key?.participant || message?.key?.remoteJid || '';
        const quoteTarget = getTargetFromQuote(message);
        const mentionTargets = getTargetsFromMention(message, actor);
        const targets = uniqueTargets([
            ...(quoteTarget ? [quoteTarget] : []),
            ...mentionTargets
        ]).filter((jid) => jid !== actor).slice(0, 8);

        if (!targets.length) {
            await sock.sendMessage(chatId, {
                text: `Reply to a user's message or @mention someone with .${action}`
            }, { quoted: message });
            return;
        }

        const queries = buildSearchQueries(action, targets.length);
        
        // Parallel search across all queries
        const searchPromises = queries.map(q => scraper.search(q, 3));
        const allResults = await Promise.all(searchPromises);
        const results = allResults.flat().filter(r => r && r.url);

        if (!results.length) {
            await sock.sendMessage(chatId, {
                text: `No GIF found for ${queries[0]}`
            }, { quoted: message });
            return;
        }

        // Prefer mp4 for gifPlayback.
        const mp4First = [...results].sort((a, b) => {
            if (a.type === b.type) return 0;
            return a.type === 'mp4' ? -1 : 1;
        });
        const picked = mp4First[Math.floor(Math.random() * Math.min(mp4First.length, 3))];
        const targetsText = targets.map(mentionTag).join(' ');
        const text = `${mentionTag(actor)} ${ACTION_TEXT[action]} ${targetsText}`;

        // Low-memory path first: let Baileys stream from URL.
        try {
            await sock.sendMessage(chatId, {
                video: { url: picked.url },
                gifPlayback: true,
                caption: text,
                mentions: [actor, ...targets]
            }, { quoted: message });
            return;
        } catch {
            // fallback below
        }

        const mediaBuffer = await scraper.download(picked.url, 8);
        await sock.sendMessage(chatId, {
            video: mediaBuffer,
            gifPlayback: true,
            caption: text,
            mentions: [actor, ...targets]
        }, { quoted: message });
    } catch (err) {
        console.error('[interaction] error:', err?.message || err);
        try {
            await sock.sendMessage(chatId, { text: 'Interaction failed. Try again.' }, { quoted: message });
        } catch {}
    }
}





module.exports = SUPPORTED.map(name => ({
  name,
  async execute(ctx) {
    return interactionCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.rawText || null);
  }
}));
