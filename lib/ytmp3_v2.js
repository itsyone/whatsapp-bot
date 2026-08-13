const axios = require('axios');
const playdl = require('play-dl');
const yts = require('yt-search');
const proxyManager = require('./proxy_manager');

const activeRequests = new Map();
const sessionCache = new Map();
const searchCache = new Map();

const SESSION_CACHE_TTL_MS = 60 * 60 * 1000;
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExpired(entry, ttlMs) {
    return !entry || (Date.now() - entry.timestamp >= ttlMs);
}

function extractVideoId(videoUrl = '') {
    const match = String(videoUrl).match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?:[?&/]|$)/);
    return match ? match[1] : null;
}

function getCacheKey(videoId, format) {
    return `${videoId}:${format}`;
}

function getCachedSession(videoId, format) {
    const cached = sessionCache.get(getCacheKey(videoId, format));
    if (cached && !isExpired(cached, SESSION_CACHE_TTL_MS)) return cached.data;
    return null;
}

function setCachedSession(videoId, format, data) {
    sessionCache.set(getCacheKey(videoId, format), {
        timestamp: Date.now(),
        data
    });
}

function getCachedSearch(query) {
    const cached = searchCache.get(String(query || '').trim().toLowerCase());
    if (cached && !isExpired(cached, SEARCH_CACHE_TTL_MS)) return cached.data;
    return null;
}

function setCachedSearch(query, data) {
    searchCache.set(String(query || '').trim().toLowerCase(), {
        timestamp: Date.now(),
        data
    });
}

function isRetryableError(error) {
    const status = Number(error?.response?.status || 0);
    const message = String(error?.message || '').toLowerCase();
    return status === 403 ||
        status === 429 ||
        message.includes('rate limit') ||
        message.includes('sign in to confirm') ||
        message.includes('browseid') ||
        message.includes('socket hang up') ||
        message.includes('timeout') ||
        message.includes('aborted') ||
        message.includes('econnreset');
}

async function withRetries(task, attempts = 3, delayMs = 1200) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await task(attempt);
        } catch (error) {
            lastError = error;
            if (attempt >= attempts || !isRetryableError(error)) throw error;
            await sleep(delayMs * attempt);
        }
    }
    throw lastError;
}

class YTMP3Downloader {
    constructor() {
        this.cnvBaseUrl = 'https://cnvmp3.com';
        this.baseUrl = 'https://yt2mp3.sc/';
        this.apiBase = 'https://gamma.gammacloud.net/api/v1/';
        this.proxyManager = proxyManager;
        this.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Referer: this.baseUrl,
            Origin: this.baseUrl
        };
        this.cnvHeaders = {
            'Content-Type': 'application/json',
            Origin: 'https://cnvmp3.com',
            Referer: 'https://cnvmp3.com/v54',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        };
    }

    async _requestRace(url, options = {}, proxyCount = 10, stickyProxy = null) {
        if (stickyProxy) {
            const [host, port] = stickyProxy.split(':');
            try {
                const res = await axios({
                    ...options,
                    url,
                    headers: { ...this.headers, ...options.headers },
                    proxy: { host, port: parseInt(port, 10) },
                    timeout: 5000
                });
                return { res, proxyStr: stickyProxy };
            } catch (error) {
                console.warn('[STICKY] Proxy failed, re-racing...');
            }
        }

        const proxies = await proxyManager.getFastestProxies(proxyCount);
        const controller = new AbortController();
        const requests = proxies.map(async (proxyStr) => {
            const [host, port] = proxyStr.split(':');
            const res = await axios({
                ...options,
                url,
                headers: { ...this.headers, ...options.headers },
                proxy: { host, port: parseInt(port, 10) },
                timeout: 7000,
                signal: controller.signal
            });
            controller.abort();
            return { res, proxyStr };
        });

        requests.push((async () => {
            await sleep(900);
            const res = await axios({
                ...options,
                url,
                headers: { ...this.headers, ...options.headers },
                timeout: 8000,
                signal: controller.signal
            });
            controller.abort();
            return { res, proxyStr: null };
        })());

        try {
            return await Promise.any(requests);
        } catch {
            const res = await axios({
                ...options,
                url,
                headers: { ...this.headers, ...options.headers },
                timeout: 10000
            });
            return { res, proxyStr: null };
        }
    }

    async getJsonArray() {
        const { res } = await this._requestRace(this.baseUrl);
        const match = String(res?.data || '').match(/var json = JSON\.parse\('(.*?)'\);/);
        if (!match?.[1]) {
            throw new Error('Failed to parse Gammacloud auth payload');
        }
        return JSON.parse(match[1]);
    }

    generateAuthToken(json) {
        let token = '';
        for (let index = 0; index < json[0].length; index++) {
            token += String.fromCharCode(json[0][index] - json[2][json[2].length - (index + 1)]);
        }
        if (json[1]) token = token.split('').reverse().join('');
        return token.length > 32 ? token.substring(0, 32) : token;
    }

    normalizeCnvUrl(url = '') {
        const raw = String(url || '').trim();
        if (!raw) return raw;

        try {
            const parsed = new URL(raw);
            const fileParam = parsed.searchParams.get('file');
            if (fileParam !== null) {
                parsed.searchParams.set('file', fileParam);
            }
            return parsed.toString();
        } catch {
            // Fallback for malformed URLs returned by the provider.
            return encodeURI(raw)
                .replace(/#/g, '%23')
                .replace(/\+/g, '%2B');
        }
    }

    getDownloadHeaders(url = '') {
        const target = String(url || '').toLowerCase();
        if (target.includes('cnvmp3.online') || target.includes('cnvmp3.com')) {
            return {
                'User-Agent': this.headers['User-Agent'],
                Referer: 'https://cnvmp3.com/v54',
                Origin: 'https://cnvmp3.com'
            };
        }
        return {
            'User-Agent': this.headers['User-Agent'],
            Referer: this.baseUrl,
            Origin: this.baseUrl
        };
    }

    async fetchAudioBuffer(url) {
        if (!url) throw new Error('Missing audio URL');

        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 45000,
            maxRedirects: 5,
            headers: this.getDownloadHeaders(url),
            validateStatus: (status) => status >= 200 && status < 400
        });

        const buffer = Buffer.from(res.data);
        const contentType = String(res.headers['content-type'] || '').toLowerCase();
        if (buffer.length < 64 * 1024) {
            throw new Error('Downloaded audio is too small');
        }
        if (contentType && !contentType.includes('audio') && !contentType.includes('octet-stream')) {
            throw new Error(`Unexpected audio content-type: ${contentType}`);
        }
        return buffer;
    }

    async searchCnv(query) {
        console.log(`[YTMP3] CNV search via yt-search: "${query}"`);
        const res = await yts(query);
        const item = res?.videos?.[0];
        if (!item?.videoId || !item?.url) {
            throw new Error('No results from yt-search');
        }
        return {
            url: item.url,
            title: item.title || 'YouTube Audio',
            thumbnail: item.thumbnail || item.image || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`
        };
    }

    async downloadCnv(videoId) {
        const qualityCode = 0;
        const qualityKbps = '320';
        const formatValue = 1;
        const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

        console.log(`[YTMP3] CNV convert: ${videoId} (${qualityKbps}kbps)`);

        return withRetries(async () => {
            const checkRes = await axios.post(`${this.cnvBaseUrl}/check_database.php`, {
                youtube_id: videoId,
                quality: qualityCode,
                formatValue
            }, {
                headers: this.cnvHeaders,
                timeout: 10000
            });

            if (checkRes.data && !checkRes.data.error && checkRes.data.data?.server_path) {
                return {
                    title: checkRes.data.data.title || 'YouTube Audio',
                    downloadURL: this.normalizeCnvUrl(checkRes.data.data.server_path),
                    quality: qualityKbps,
                    cached: true
                };
            }

            const dataRes = await axios.post(`${this.cnvBaseUrl}/get_video_data.php`, {
                url: youtubeUrl,
                token: '1234'
            }, {
                headers: this.cnvHeaders,
                timeout: 12000
            });

            if (dataRes.data?.error) {
                throw new Error(`CNV video data error: ${dataRes.data.error}`);
            }

            const title = dataRes.data?.title || 'YouTube Audio';
            const dlRes = await axios.post(`${this.cnvBaseUrl}/download_video_ucep.php`, {
                url: youtubeUrl,
                quality: qualityCode,
                title,
                formatValue
            }, {
                headers: this.cnvHeaders,
                timeout: 20000
            });

            if (dlRes.data?.error || !dlRes.data?.download_link) {
                throw new Error(`CNV conversion error: ${dlRes.data?.error || 'missing download link'}`);
            }

            axios.post(`${this.cnvBaseUrl}/insert_to_database.php`, {
                youtube_id: videoId,
                server_path: dlRes.data.download_link,
                quality: qualityCode,
                title,
                formatValue
            }, {
                headers: this.cnvHeaders,
                timeout: 10000
            }).catch(() => {});

            return {
                title,
                downloadURL: this.normalizeCnvUrl(dlRes.data.download_link),
                quality: qualityKbps,
                cached: false
            };
        }, 3, 1200);
    }

    async downloadGammacloud(videoUrl, videoId, format = 'mp3') {
        console.log(`[YTMP3] Using Gammacloud for ${videoId} (${format})...`);

        return withRetries(async () => {
            const json = await this.getJsonArray();
            const authToken = this.generateAuthToken(json);
            const authKey = String.fromCharCode(json[6]);

            const initUrl = `${this.apiBase}init?${authKey}=${authToken}&t=${Date.now()}`;
            const { res: initRes, proxyStr } = await this._requestRace(initUrl);
            if (Number(initRes?.data?.error || 0) > 0) {
                throw new Error(`API init error: ${initRes.data.error}`);
            }

            let currentUrl = `${initRes.data.convertURL}&v=${videoId}&f=${format}&t=${Date.now()}`;
            let sid = '';
            let progressUrl = '';

            for (let redirectCount = 0; redirectCount < 5; redirectCount++) {
                const { res } = await this._requestRace(currentUrl, {}, 5, proxyStr);
                const data = res?.data || {};
                if (Number(data.error || 0) > 0) {
                    throw new Error(`API convert error: ${data.error}`);
                }

                if (data.redirect === 1 && data.redirectURL) {
                    currentUrl = data.redirectURL;
                    if (!currentUrl.includes('v=')) currentUrl += `&v=${videoId}&f=${format}`;
                    continue;
                }

                if (data.status === 3 || data.downloadURL) {
                    return {
                        title: data.title,
                        downloadURL: data.downloadURL
                    };
                }

                sid = data.sid;
                progressUrl = data.progressURL;
                break;
            }

            if (!sid || !progressUrl) {
                throw new Error('No progress session returned by Gammacloud');
            }

            for (let poll = 0; poll < 20; poll++) {
                const { res } = await this._requestRace(`${progressUrl}&sid=${sid}&t=${Date.now()}`, {}, 3, proxyStr);
                const data = res?.data || {};
                if (data.status === 3 || data.downloadURL) {
                    return {
                        title: data.title,
                        downloadURL: data.downloadURL
                    };
                }
                await sleep(1000);
            }

            throw new Error('Gammacloud progress timed out');
        }, 3, 1500);
    }

    async search(query) {
        console.log(`[YTMP3] Searching: "${query}"`);
        const cached = getCachedSearch(query);
        if (cached) return cached;

        const providers = [
            async () => this.searchCnv(query),
            async () => {
                const results = await playdl.search(query, {
                    limit: 1,
                    source: { youtube: 'video' }
                });
                if (!results?.length) throw new Error('No results from play-dl');
                const video = results[0];
                const bestThumb = [...(video.thumbnails || [])].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url;
                return {
                    url: video.url,
                    title: video.title,
                    thumbnail: bestThumb || video.thumbnails?.[0]?.url || null
                };
            },
            async () => {
                const result = await yts(query);
                const video = result?.videos?.[0];
                if (!video?.url) throw new Error('No results from yt-search');
                return {
                    url: video.url,
                    title: video.title,
                    thumbnail: video.thumbnail || null
                };
            }
        ];

        let lastError;
        for (const provider of providers) {
            try {
                const found = await withRetries(() => provider(), 2, 1000);
                setCachedSearch(query, found);
                return found;
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError || new Error('No search results');
    }

    async download(videoUrl, format = 'mp3') {
        const id = extractVideoId(videoUrl);
        if (!id) throw new Error('Invalid YouTube URL');

        const key = getCacheKey(id, format);
        if (activeRequests.has(key)) return activeRequests.get(key);

        const cached = getCachedSession(id, format);
        if (cached) return cached;

        const requestPromise = format === 'mp3'
            ? this.downloadCnv(id).catch(async (cnvError) => {
                console.warn(`[YTMP3] CNV failed, falling back to Gammacloud: ${cnvError.message}`);
                return this.downloadGammacloud(videoUrl, id, format);
            })
            : this.downloadGammacloud(videoUrl, id, format);
        activeRequests.set(key, requestPromise);

        try {
            const result = await requestPromise;
            setCachedSession(id, format, result);
            return result;
        } finally {
            activeRequests.delete(key);
        }
    }
}

module.exports = new YTMP3Downloader();
