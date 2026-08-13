const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

/**
 * 💠 UNIT 06: COMBOT HARVESTER 🛰️
 * Specialized in synchronizing with the Combot Layer and Telegram Bot API.
 */

class CombotHarvester {
    constructor() {
        this.token = '8365930587:AAEh3XhE2bYw_8Y9SQ5V6Xv5agqhQs-kfOQ';
        this.baseUrl = 'https://combot.org/telegram/stickers';
        this.apiBase = `https://api.telegram.org/bot${this.token}`;
        this.fileBase = `https://api.telegram.org/file/bot${this.token}`;
        this.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
        };
    }

    /**
     * 🔍 Synchronize with Combot search results.
     * Utilizes Puppeteer to bypass Cloudflare layers.
     */
    async search(query) {
        console.log(`💠 [SEARCH] Synchronizing with Combot Layer: "${query}"...`);
        let browser;
        try {
            browser = await puppeteer.launch({
                headless: "new",
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            const page = await browser.newPage();
            await page.setUserAgent(this.headers['User-Agent']);
            
            const url = `${this.baseUrl}?q=${encodeURIComponent(query)}`;
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

            // Wait for results or empty state
            await page.waitForSelector('.stickerset, .no-results', { timeout: 10000 });

            const content = await page.content();
            const $ = cheerio.load(content);
            const packs = [];

            $('.stickerset').each((i, el) => {
                const title = $(el).find('.stickerset__title').text().trim();
                const addLink = $(el).find('.stickers-add-btn').attr('href');
                const slug = addLink ? addLink.split('/').pop() : null;
                const previewImg = $(el).find('.stickers-sticker-link img').attr('data-src') || $(el).find('.stickers-sticker-link img').attr('src');
                const stickerCount = $(el).find('.stickerset__count').text().trim();

                if (slug) {
                    packs.push({
                        title,
                        slug,
                        preview: previewImg,
                        count: stickerCount,
                        link: `https://t.me/addstickers/${slug}` 
                    });
                }
            });

            console.log(`⚡ [SUCCESS] Found ${packs.length} frequency nodes.`);
            return packs;
        } catch (error) {
            console.error(`⚡ [ERROR] Failed to synchronize with Combot: ${error.message}`);
            return [];
        } finally {
            if (browser) await browser.close();
        }
    }

    /**
     * 🛰️ Extract full sticker set manifest via Telegram Bot API.
     */
    async getPack(slug) {
        console.log(`💠 [EXTRACT] Deep-harvesting pack: "${slug}"...`);
        try {
            const res = await axios.get(`${this.apiBase}/getStickerSet?name=${slug}`);
            if (!res.data.ok) throw new Error(res.data.description || 'Failed to fetch pack');

            const set = res.data.result;
            const stickers = await Promise.all(set.stickers.map(async (sticker) => {
                // Get file path for each sticker
                const fileRes = await axios.get(`${this.apiBase}/getFile?file_id=${sticker.file_id}`);
                const filePath = fileRes.data.result.file_path;
                
                return {
                    file_id: sticker.file_id,
                    emoji: sticker.emoji,
                    is_animated: sticker.is_animated,
                    is_video: sticker.is_video,
                    download_url: `${this.fileBase}/${filePath}` 
                };
            }));

            console.log(`⚡ [SUCCESS] Harvested ${stickers.length} assets from "${set.title}".`);
            return {
                title: set.title,
                name: set.name,
                is_animated: set.is_animated,
                is_video: set.is_video,
                stickers
            };
        } catch (error) {
            console.error(`⚡ [ERROR] Extraction failed for "${slug}": ${error.message}`);
            return null;
        }
    }
}

// 🛠️ CLI BRIDGE
if (require.main === module) {
    const harvester = new CombotHarvester();
    const [,, cmd, val] = process.argv;

    if (cmd === 'search' && val) {
        harvester.search(val).then(res => console.log(JSON.stringify(res, null, 2)));
    } else if (cmd === 'pack' && val) {
        harvester.getPack(val).then(res => console.log(JSON.stringify(res, null, 2)));
    } else {
        console.log('💠 Combot Harvester Operational');
        console.log('Usage: node combotHarvester.js search <query>');
        console.log('Usage: node combotHarvester.js pack <slug>');
    }
}

module.exports = CombotHarvester;
