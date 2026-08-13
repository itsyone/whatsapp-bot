const fs = require('fs');
const path = require('path');
const axios = require('axios');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'nsfw-groups.json');

function ensureStateFile() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(STATE_FILE)) {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ groups: {} }, null, 2), 'utf8');
    }
}

function readState() {
    ensureStateFile();
    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (!parsed || typeof parsed !== 'object') {
            return { groups: {} };
        }
        if (!parsed.groups || typeof parsed.groups !== 'object') {
            parsed.groups = {};
        }
        return parsed;
    } catch {
        return { groups: {} };
    }
}

function writeState(state) {
    ensureStateFile();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function isNsfwEnabled(chatId) {
    const state = readState();
    return Boolean(state.groups?.[chatId]);
}

const isOwnerOrSudo = require('../../lib/isOwner');

async function handleNsfwCommand(sock, chatId, message, args = [], isSenderAdmin = false, senderId) {
    const isOwner = await isOwnerOrSudo(senderId);
    if (!isSenderAdmin && !isOwner) {
        await sock.sendMessage(chatId, { text: '*This command is only for admins*' }, { quoted: message });
        return;
    }
    const action = String(args[0] || '').trim().toLowerCase();
    
    // Default menu if no action provided
    if (!action || !['on', 'off'].includes(action)) {
        const status = isNsfwEnabled(chatId) ? 'ON' : 'OFF';
        await sock.sendMessage(chatId, {
            text: `*NSFW MENU*\n\n.nsfw on\n.nsfw off\n\nStatus: ${status}`
        }, { quoted: message });
        return;
    }

    const state = readState();

    if (action === 'on') {
        if (state.groups[chatId]) {
            await sock.sendMessage(chatId, { text: '*NSFW is already ON for this group*' }, { quoted: message });
            return;
        }
        state.groups[chatId] = true;
        writeState(state);
        await sock.sendMessage(chatId, {
            text: '*NSFW has been turned ON for this group*'
        }, { quoted: message });
        return;
    }

    if (action === 'off') {
        if (!state.groups[chatId]) {
            await sock.sendMessage(chatId, { text: '*NSFW is already OFF for this group*' }, { quoted: message });
            return;
        }
        delete state.groups[chatId];
        writeState(state);
        await sock.sendMessage(chatId, {
            text: '*NSFW has been turned OFF for this group*'
        }, { quoted: message });
        return;
    }
}

async function requireEnabled(sock, chatId, message) {
    if (!isNsfwEnabled(chatId)) {
        await sock.sendMessage(chatId, {
            text: 'NSFW is off in this group.\n\nAsk an admin to use `.nsfw on` first.'
        }, { quoted: message });
        return false;
    }
    return true;
}

function parseHentaiQuery(rawText) {
    return String(rawText || '').trim().split(/\s+/).slice(1).join(' ').trim().toLowerCase();
}

function decodeHtml(text) {
    return String(text || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
}

function stripTags(text) {
    return decodeHtml(String(text || '').replace(/\s+/g, ' '));
}

function normalizeAbsoluteUrl(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    if (value.startsWith('http://') || value.startsWith('https://')) return value;
    if (value.startsWith('//')) return `https:${value}`;
    return value;
}

async function getHentaiList(pageNumber = null) {
    const page = Number.isInteger(pageNumber) && pageNumber >= 0
        ? pageNumber
        : Math.floor(1153 * Math.random());

    const response = await fetch(`https://sfmcompile.club/page/${page}`, {
        headers: {
            'user-agent': 'Mozilla/5.0'
        },
        timeout: 15000
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch page ${page}`);
    }

    const htmlText = await response.text();
    const $ = cheerio.load(htmlText);
    const results = [];

    $('#primary > div > div > ul > li > article').each((_, article) => {
        results.push({
            title: stripTags($(article).find('header > h2').text()),
            link: normalizeAbsoluteUrl($(article).find('header > h2 > a').attr('href')),
            category: stripTags($(article).find('header > div.entry-before-title > span > span').text().replace('in ', '')),
            share_count: stripTags($(article).find('header > div.entry-after-title > p > span.entry-shares').text()),
            views_count: stripTags($(article).find('header > div.entry-after-title > p > span.entry-views').text()),
            type: $(article).find('source').attr('type') || 'image/jpeg',
            video_1: normalizeAbsoluteUrl($(article).find('source').attr('src') || $(article).find('img').attr('data-src')),
            video_2: normalizeAbsoluteUrl($(article).find('video > a').attr('href') || '')
        });
    });

    return results.filter((item) => item.title && (item.video_1 || item.video_2));
}

function matchesHentaiSearch(item, query) {
    if (!query) return true;
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const haystack = [
        item?.title,
        item?.category,
        item?.link
    ].join(' ').toLowerCase();
    return terms.some((term) => haystack.includes(term));
}

async function getSearchableHentaiList(query = '') {
    const attempts = query ? 24 : 6;
    let pool = [];

    for (let index = 0; index < attempts; index += 1) {
        try {
            const results = await getHentaiList();
            if (!query) {
                if (results.length) return results;
                continue;
            }

            const filtered = results.filter((item) => matchesHentaiSearch(item, query));
            if (filtered.length) {
                pool = pool.concat(filtered);
                if (pool.length >= 6) break;
            }
        } catch {}
    }

    return pool;
}

async function getNhentaiSearchItem(query = '') {
    const { API } = await getNhentaiModule();
    const api = new API();
    let doujin = null;

    if (query) {
        const result = await api.search(query, {
            language: 'english',
            page: Math.max(1, Math.floor(Math.random() * 5) + 1)
        });
        if (Array.isArray(result?.doujins) && result.doujins.length) {
            doujin = result.doujins[Math.floor(Math.random() * result.doujins.length)];
        }
    } else {
        const result = await api.search('*', {
            language: 'english',
            page: Math.max(1, Math.floor(Math.random() * 10) + 1)
        });
        if (Array.isArray(result?.doujins) && result.doujins.length) {
            doujin = result.doujins[Math.floor(Math.random() * result.doujins.length)];
        }
    }

    if (!doujin) return null;

    const tags = Array.isArray(doujin?.tags?.all)
        ? doujin.tags.all
            .map((tag) => String(tag?.name || '').trim())
            .filter(Boolean)
            .slice(0, 8)
        : [];

    return {
        imageUrl: doujin.cover.url,
        caption: [
            '🔞 *Hentai Result*',
            '━━━━━━━━━━━━━━━━━━',
            `📌 *Title:* ${pickEnglishTitle(doujin)}`,
            `📚 *Pages:* ${Array.isArray(doujin?.pages) ? doujin.pages.length : 0}`,
            tags.length ? `🏷️ *Tags:* ${tags.join(', ')}` : ''
        ].filter(Boolean).join('\n')
    };
}

async function hentaiCommand(sock, chatId, message, rawText = '') {
    const enabled = await requireEnabled(sock, chatId, message);
    if (!enabled) return;

    try {
        const query = parseHentaiQuery(rawText);
        const results = await getSearchableHentaiList(query);

        if (!results.length) {
            const fallback = await getNhentaiSearchItem(query).catch(() => null);
            if (fallback?.imageUrl) {
                await sock.sendMessage(chatId, {
                    image: { url: fallback.imageUrl },
                    caption: fallback.caption
                }, { quoted: message });
                return;
            }

            await sock.sendMessage(chatId, {
                text: '❌ *No result found*'
            }, { quoted: message });
            return;
        }

        const video = results[Math.floor(Math.random() * results.length)];
        const videoUrl = video.video_1 || video.video_2;

        if (!videoUrl) {
            await sock.sendMessage(chatId, {
                text: '❌ *Video URL not found*'
            }, { quoted: message });
            return;
        }

        const waitMsg = await sock.sendMessage(chatId, {
            text: `⬇️ *Downloading:*\n📌 ${video.title}`
        }, { quoted: message });

        const videoRes = await axios.get(videoUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Referer: 'https://sfmcompile.club/'
            },
            timeout: 30000,
            maxContentLength: 100 * 1024 * 1024,
            maxBodyLength: 100 * 1024 * 1024
        });

        const caption = `🔞 *Hentai Video*\n`
            + `━━━━━━━━━━━━━━━━━━\n`
            + `📌 *Title:* ${video.title}\n`
            + `📂 *Category:* ${video.category}\n`
            + `👁️ *Views:* ${video.views_count}\n`
            + `━━━━━━━━━━━━━━━━━━`;

        await sock.sendMessage(chatId, {
            video: Buffer.from(videoRes.data),
            caption
        }, { quoted: waitMsg });
    } catch (error) {
        console.error('Error in hentai command:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: 'Failed to fetch a hentai result right now. Please try again later.'
        }, { quoted: message });
    }
}

async function eroCommand(sock, chatId, message) {
    const enabled = await requireEnabled(sock, chatId, message);
    if (!enabled) return;

    const endpoints = [
        'https://api-rebix.vercel.app/api/nsfw/milf',
        'https://api-rebix.vercel.app/api/nsfw/pussy'
    ];
    const selected = endpoints[Math.floor(Math.random() * endpoints.length)];

    try {
        await sock.sendMessage(chatId, {
            image: { url: selected }
        }, { quoted: message });
    } catch (error) {
        console.error('Error in ero command:', error);
        await sock.sendMessage(chatId, {
            text: 'Failed to fetch ero image right now. Try again later.'
        }, { quoted: message });
    }
}

let nhentaiModulePromise = null;
async function getNhentaiModule() {
    if (!nhentaiModulePromise) {
        nhentaiModulePromise = import('nhentai');
    }
    return nhentaiModulePromise;
}

function parseNhentaiInput(rawText) {
    const text = String(rawText || '').trim();
    const args = text.split(/\s+/).slice(1).filter(Boolean);
    return args.join(' ').trim();
}

function pickEnglishTitle(doujin) {
    return (
        String(doujin?.titles?.english || '').trim() ||
        String(doujin?.titles?.pretty || '').trim() ||
        String(doujin?.titles?.japanese || '').trim() ||
        'Untitled'
    );
}

function buildNhentaiCaption(doujin) {
    const title = pickEnglishTitle(doujin);
    const tags = Array.isArray(doujin?.tags?.all)
        ? doujin.tags.all
            .map((tag) => String(tag?.name || '').trim())
            .filter(Boolean)
            .slice(0, 10)
        : [];
    const pageCount = Array.isArray(doujin?.pages) ? doujin.pages.length : 0;
    const id = doujin?.id || 'unknown';

    return [
        '*nhentai Result*',
        '',
        `Title: ${title}`,
        `ID: ${id}`,
        `Pages: ${pageCount}`,
        tags.length ? `Tags: ${tags.join(', ')}` : '',
        `Link: https://nhentai.net/g/${id}`
    ].filter(Boolean).join('\n');
}

async function nhentaiCommand(sock, chatId, message, rawText) {
    const enabled = await requireEnabled(sock, chatId, message);
    if (!enabled) return;

    try {
        const query = parseNhentaiInput(rawText);
        const { API } = await getNhentaiModule();
        const api = new API();
        let doujin = null;

        if (/^\d+$/.test(query)) {
            doujin = await api.fetchDoujin(query);
        } else if (query) {
            const result = await api.search(query, {
                language: 'english',
                page: Math.max(1, Math.floor(Math.random() * 3) + 1)
            });
            if (Array.isArray(result?.doujins) && result.doujins.length) {
                doujin = result.doujins[Math.floor(Math.random() * result.doujins.length)];
            }
        } else {
            const result = await api.search('*', {
                language: 'english',
                page: Math.max(1, Math.floor(Math.random() * 10) + 1)
            });
            if (Array.isArray(result?.doujins) && result.doujins.length) {
                doujin = result.doujins[Math.floor(Math.random() * result.doujins.length)];
            }
        }

        if (!doujin) {
            await sock.sendMessage(chatId, {
                text: 'No English nhentai result was found right now.'
            }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, {
            image: { url: doujin.cover.url },
            caption: buildNhentaiCaption(doujin)
        }, { quoted: message });
    } catch (error) {
        console.error('Error in nhentai command:', error);
        await sock.sendMessage(chatId, {
            text: 'Failed to fetch nhentai right now. Try again later.'
        }, { quoted: message });
    }
}

module.exports = {
    handleNsfwCommand,
    isNsfwEnabled,
    hentaiCommand,
    eroCommand,
    nhentaiCommand
};
