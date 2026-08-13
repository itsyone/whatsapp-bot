const axios = require('axios');
const FormData = require('form-data');

function loadCheerio() {
    const cheerio = require('cheerio');
    if (!cheerio || typeof cheerio.load !== 'function') {
        throw new Error('cheerio load is unavailable');
    }
    return cheerio; // FIXED: lazy cheerio resolve for scraper runtime
}

function normalizeSetCookieList(rawValue) {
    if (Array.isArray(rawValue)) {
        return rawValue.map((value) => String(value || '').trim()).filter(Boolean);
    }
    if (!rawValue) return [];
    if (typeof rawValue === 'string') {
        return rawValue
            .split(/,(?=[^;]+=[^;]+)/)
            .map((value) => value.trim())
            .filter(Boolean);
    }
    if (typeof rawValue[Symbol.iterator] === 'function') {
        return Array.from(rawValue).map((value) => String(value || '').trim()).filter(Boolean);
    }
    return [String(rawValue).trim()].filter(Boolean); // FIXED: normalize odd header shapes before cookie parsing
}

class PinterestHarvester {
    constructor() {
        this.baseUrl = 'https://www.pinterest.com';
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
        this.client = axios.create({
            baseURL: this.baseUrl,
            headers: {
                'User-Agent': this.userAgent,
                'Referer': 'https://www.pinterest.com/',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        });
        this.appVersion = '2d87642';
        this.csrfToken = null;
        this.cookies = '';
        this.handshakeExpiresAt = 0;
        this.handshakePromise = null;
        this.searchQueue = Promise.resolve();
    }

    async handshake(query = 'anime') {
        if (this.csrfToken && this.cookies && Date.now() < this.handshakeExpiresAt) return;
        if (this.handshakePromise) {
            await this.handshakePromise;
            return;
        }
        this.handshakePromise = (async () => {
        console.log('Performing Pinterest handshake...');
        try {
            const searchUrl = `/search/pins/?q=${encodeURIComponent(query)}`;
            const response = await this.client.get(searchUrl, {
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
                }
            });

            const $ = loadCheerio().load(response.data); // FIXED: scoped cheerio load
            const scriptData = $('#__PWS_DATA__').html();
            if (scriptData) {
                try {
                    const data = JSON.parse(scriptData);
                    this.appVersion = data.context.app_version;
                    console.log(`Pinterest app version synchronized: ${this.appVersion}`);
                } catch {}
            }

            const setCookies = normalizeSetCookieList(response.headers['set-cookie']);
            this.cookies = setCookies.map((cookie) => String(cookie || '').split(';')[0]).filter(Boolean).join('; ');

            const csrftoken = setCookies.find((cookie) => cookie.startsWith('csrftoken'));
            if (csrftoken) {
                this.csrfToken = csrftoken.split(';')[0].split('=')[1];
                console.log(`Pinterest CSRF token synchronized: ${this.csrfToken}`);
            }
            this.handshakeExpiresAt = Date.now() + (10 * 60 * 1000);

            if (!this.appVersion) {
                const versionMatch = response.data.match(/"app_version":"(.*?)"/);
                this.appVersion = versionMatch ? versionMatch[1] : '8e178ec';
            }
        } catch (error) {
            console.error('Pinterest handshake failed:', error.message);
            this.handshakeExpiresAt = 0;
        } finally {
            this.handshakePromise = null;
        }
        })();
        await this.handshakePromise;
    }

    extractImageUrlsFromHtml(html, limit = 60) {
        const text = String(html || '');
        const urls = new Set();
        const patterns = [
            /https:\\\/\\\/i\.pinimg\.com\\\/[^"'\\\s]+/g,
            /https:\/\/i\.pinimg\.com\/[^"'\s]+/g
        ];

        for (const pattern of patterns) {
            const matches = text.match(pattern) || [];
            for (const raw of matches) {
                const normalized = String(raw)
                    .replace(/\\u002F/g, '/')
                    .replace(/\\\//g, '/')
                    .replace(/&amp;/g, '&');
                if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(normalized)) {
                    urls.add(normalized);
                }
                if (urls.size >= limit) break;
            }
            if (urls.size >= limit) break;
        }

        return Array.from(urls).slice(0, limit).map((image, index) => ({
            id: `html-${index + 1}`,
            title: 'Pinterest Result',
            image,
            pinner: 'Unknown'
        }));
    }

    async searchHtmlFallback(query, limit = 60) {
        const searchPath = `/search/pins/?q=${encodeURIComponent(query)}`;
        const response = await this.client.get(searchPath, {
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Cookie': this.cookies || '',
                'Referer': `https://www.pinterest.com${searchPath}`
            }
        });

        const results = this.extractImageUrlsFromHtml(response.data, limit);
        if (results.length === 0) {
            throw new Error('no pinterest images found in html fallback');
        }

        console.log(`Pinterest HTML fallback captured ${results.length} pins`);
        return results;
    }

    async search(query, limit = 60) {
        const safeLimit = Math.max(1, Math.min(Number(limit) || 1, 30));
        const run = async () => {
        await this.handshake(query);

        console.log(`Searching Pinterest for "${query}" (target ${safeLimit})...`);

        let allResults = [];
        let bookmarks = [];

        while (allResults.length < safeLimit) {
            const searchPath = `/search/pins/?q=${encodeURIComponent(query)}`;
            const data = {
                options: {
                    isPrefetch: false,
                    query,
                    scope: 'pins',
                    no_fetch_context_on_resource: false,
                    bookmarks,
                    page_size: 25,
                    field_set_key: 'unauth_react_main_grid'
                },
                context: {}
            };

            try {
                const response = await this.client.get('/resource/BaseSearchResource/get/', {
                    params: {
                        source_url: searchPath,
                        data: JSON.stringify(data),
                        _: Date.now()
                    },
                    headers: {
                        'X-Pinterest-App-Version': this.appVersion,
                        'X-CSRFToken': this.csrfToken || '',
                        'X-Pinterest-Source-Url': searchPath,
                        'X-Pinterest-PWS-Handler': 'www/search/pins/',
                        'Cookie': this.cookies,
                        'Referer': `https://www.pinterest.com${searchPath}`
                    }
                });

                if (!response.data || !response.data.resource_response || !response.data.resource_response.data) {
                    console.warn('Pinterest returned no resource response data.');
                    break;
                }

                const results = response.data.resource_response.data.results || [];
                bookmarks = response.data.resource_response.bookmark ? [response.data.resource_response.bookmark] : [];

                if (results.length === 0) break;

                allResults = allResults.concat(results.map((pin) => ({
                    id: pin.id,
                    title: pin.title || pin.grid_title || 'Untitled',
                    image: pin.images?.orig?.url,
                    pinner: pin.pinner ? pin.pinner.full_name : 'Unknown'
                })).filter((item) => item.image));

                console.log(`Pinterest captured ${allResults.length} pins so far`);

                if (!bookmarks.length || allResults.length >= safeLimit) break;
            } catch (e) {
                console.error('Pinterest search error:', e.message);
                if (e.response && (e.response.status === 401 || e.response.status === 403)) {
                    console.error('Pinterest session rejected, retrying handshake...');
                    this.csrfToken = null;
                    this.cookies = '';
                    await this.handshake(query);
                } else {
                    break;
                }
            }
        }

        if (allResults.length === 0) {
            try {
                return await this.searchHtmlFallback(query, safeLimit);
            } catch (fallbackError) {
                console.error('Pinterest HTML fallback failed:', fallbackError.message);
            }
        }

        console.log(`Pinterest search complete. Total: ${allResults.length}`);
        return allResults.slice(0, safeLimit);
        };

        const job = this.searchQueue.catch(() => {}).then(run);
        this.searchQueue = job.catch(() => {});
        return job;
    }
}

class TiktokDownloader {
    constructor() {
        this.baseUrl = 'https://snaptik.app';
        this.client = axios.create({
            baseURL: this.baseUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': 'https://snaptik.app/en2',
                'Origin': 'https://snaptik.app'
            }
        });
    }

    async getTokens() {
        console.log('Synchronizing TikTok scraper handshake...');
        const response = await this.client.get('/en2');
        const $ = loadCheerio().load(response.data); // FIXED: scoped cheerio load
        const token = $('input[name="token"]').val();

        if (!token) {
            throw new Error('Failed to extract TikTok token');
        }

        console.log(`TikTok token synchronized: ${token}`);
        return {
            token,
            cookies: normalizeSetCookieList(response.headers['set-cookie']) // FIXED: normalize Snaptik cookie header shapes
        };
    }

    async extract(videoUrl) {
        console.log('Attempting TikTok extraction via Snaptik...');
        try {
            const { token, cookies } = await this.getTokens();
            const form = new FormData();
            form.append('url', videoUrl);
            form.append('lang', 'en2');
            form.append('token', token);

            const response = await this.client.post('/abc2.php', form, {
                headers: {
                    ...form.getHeaders(),
                    'Cookie': cookies.length ? cookies.join('; ') : ''
                },
                timeout: 10000
            });

            const parsed = this.parseObfuscatedResponse(response.data);
            if (parsed?.videoUrl) {
                return parsed;
            }
        } catch (e) {
            console.warn('Snaptik extraction failed:', e.message);
        }

        console.log('Attempting TikTok fallback via TikWM...');
        try {
            const response = await axios.post(
                'https://www.tikwm.com/api/',
                new URLSearchParams({ url: videoUrl }),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                    },
                    timeout: 10000
                }
            );

            if (response.data && response.data.code === 0 && response.data.data) {
                const videoData = response.data.data;
                const fallbackUrl = videoData.play || videoData.hdplay || videoData.wmplay || '';
                if (fallbackUrl) {
                    console.log('TikWM extraction succeeded.');
                    return {
                        videoUrl: fallbackUrl,
                        description: String(videoData.title || videoData.desc || '').trim()
                    }; // FIXED: restore TikWM fallback for TikTok downloader reliability
                }
            }
        } catch (e) {
            console.error('TikWM extraction failed:', e.message);
        }

        return null;
    }

    parseObfuscatedResponse(html) {
        console.log('Deobfuscating TikTok scraper response...');

        const match = html.match(/eval\(function\(h,u,n,t,e,r\)\{.+?\}\((.+?)\)\)/);

        if (!match) {
            const $ = loadCheerio().load(html); // FIXED: scoped cheerio load
            const downloadBtn = $('.video-links a[data-event="download_no_watermark"]');
            if (downloadBtn.length > 0) {
                return {
                    videoUrl: downloadBtn.attr('href'),
                    description: $('.video-title').text().trim() || ''
                };
            }
            return null;
        }

        const argsStr = match[1];
        try {
            const args = JSON.parse(`[${argsStr.replace(/'/g, '"')}]`);
            const decoded = this.snaptikDecoder(...args);

            if (decoded.includes('Unable to connect to TikTok server')) {
                console.warn('Snaptik reported connection error.');
                return null;
            }

            const $decoded = loadCheerio().load(decoded); // FIXED: scoped cheerio load
            let downloadUrl = $decoded('a.btn.btn-main').first().attr('href') ||
                              $decoded('a[data-event="download_no_watermark"]').first().attr('href') ||
                              $decoded('a.download-file').first().attr('href');

            if (!downloadUrl) {
                const urlMatch = decoded.match(/https?:\/\/d\.rapidcdn\.app\/v2\?token=[^"']+/);
                downloadUrl = urlMatch ? urlMatch[0] : null;
            }

            return {
                videoUrl: downloadUrl,
                description: $decoded('.video-title').text().trim() || ''
            };
        } catch (e) {
            console.error('TikTok deobfuscation error:', e.message);
            return null;
        }
    }

    snaptikDecoder(h, u, n, t, e, r) {
        const _0xc17e = ['', 'split', '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/', 'slice', 'indexOf', '', '', '.', 'pow', 'reduce', 'reverse', '0'];

        function _0xe12c(d, e_base, f_base) {
            const g = _0xc17e[2][_0xc17e[1]](_0xc17e[0]);
            const h_inner = g[_0xc17e[3]](0, e_base);
            const i_inner = g[_0xc17e[3]](0, f_base);
            let j = d[_0xc17e[1]](_0xc17e[0])[_0xc17e[10]]()[_0xc17e[9]](function(a, b, c_idx) {
                if (h_inner[_0xc17e[4]](b) !== -1) {
                    return a += h_inner[_0xc17e[4]](b) * (Math[_0xc17e[8]](e_base, c_idx));
                }
                return a;
            }, 0);
            let k = _0xc17e[0];
            while (j > 0) {
                k = i_inner[j % f_base] + k;
                j = (j - (j % f_base)) / f_base;
            }
            return k || _0xc17e[11];
        }

        let decodedStr = '';
        for (let i = 0, len = h.length; i < len; i++) {
            let s = '';
            while (h[i] !== n[e]) {
                s += h[i];
                i++;
            }
            for (let j = 0; j < n.length; j++) {
                s = s.replace(new RegExp(n[j], 'g'), j);
            }
            decodedStr += String.fromCharCode(_0xe12c(s, e, 10) - t);
        }
        return decodeURIComponent(escape(decodedStr));
    }
}

module.exports = {
    PinterestHarvester: new PinterestHarvester(),
    TiktokDownloader: new TiktokDownloader()
};
