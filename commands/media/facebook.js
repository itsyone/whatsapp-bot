const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
let ffmpeg = null;
try {
    ffmpeg = require('fluent-ffmpeg');
} catch {}

function normalizeCaption(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function toCaptionPreview(value, maxWords = 25) {
    const normalized = normalizeCaption(value);
    if (!normalized) return '';

    const words = normalized.split(' ').filter(Boolean);
    if (words.length <= maxWords) {
        return normalized;
    }

    return `${words.slice(0, maxWords).join(' ')}...`;
}

async function normalizeVideoBuffer(buffer) {
    if (!buffer?.length || !ffmpeg) return buffer;

    const tmpDir = path.join(os.tmpdir(), 'eclipse-fb');
    fs.mkdirSync(tmpDir, { recursive: true });
    const inputPath = path.join(tmpDir, `fb_in_${Date.now()}.mp4`);
    const outputPath = path.join(tmpDir, `fb_out_${Date.now()}.mp4`);

    try {
        fs.writeFileSync(inputPath, buffer);
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .videoCodec('libx264')
                .audioCodec('aac')
                .outputOptions(['-movflags +faststart', '-pix_fmt yuv420p'])
                .on('end', resolve)
                .on('error', reject)
                .save(outputPath);
        });

        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
            return fs.readFileSync(outputPath);
        }
        return buffer;
    } catch {
        return buffer;
    } finally {
        for (const filePath of [inputPath, outputPath]) {
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            } catch {}
        }
    }
}

async function facebookCommand(sock, chatId, message) {
    try {
        const text = message.message?.conversation || message.message?.extendedTextMessage?.text;
        const url = text.split(' ').slice(1).join(' ').trim();

        if (!url) {
            return await sock.sendMessage(chatId, {
                text: 'Please provide a Facebook video URL.\nExample: .fb https://www.facebook.com/...'
            }, { quoted: message });
        }

        if (!url.includes('facebook.com')) {
            return await sock.sendMessage(chatId, {
                text: 'That is not a Facebook link.'
            }, { quoted: message });
        }

        await sock.sendMessage(chatId, {
            react: { text: '🔄', key: message.key }
        });

        let resolvedUrl = url;
        try {
            const res = await axios.get(url, {
                timeout: 20000,
                maxRedirects: 10,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            const possible = res?.request?.res?.responseUrl;
            if (possible && typeof possible === 'string') {
                resolvedUrl = possible;
            }
        } catch {
            // Ignore resolution errors and keep the original URL.
        }

        async function fetchFromApi(targetUrl) {
            const apiUrl = `https://api.princetechn.com/api/download/facebook?apikey=prince&url=${encodeURIComponent(targetUrl)}`;
            return axios.get(apiUrl, {
                timeout: 40000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                    Accept: 'application/json, text/plain, */*'
                },
                maxRedirects: 5,
                validateStatus: (status) => status >= 200 && status < 500
            });
        }

        let response;
        try {
            response = await fetchFromApi(resolvedUrl);
            if (!response || response.status >= 400 || !response.data) {
                throw new Error('bad');
            }
        } catch {
            response = await fetchFromApi(url);
        }

        const data = response.data;

        if (!data || data.status !== 200 || !data.success || !data.result) {
            return await sock.sendMessage(chatId, {
                text: 'Sorry the API did not return a valid response. Please try again later!'
            }, { quoted: message });
        }

        const fbvid = data.result.hd_video || data.result.sd_video;
        const postCaption = toCaptionPreview(
            data.result.caption ||
            data.result.title ||
            data.result.description ||
            data.result.text ||
            ''
        );

        if (!fbvid) {
            return await sock.sendMessage(chatId, {
                text: 'Wrong Facebook data. Please ensure the video exists.'
            }, { quoted: message });
        }

        const videoResponse = await axios({
            method: 'GET',
            url: fbvid,
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                Connection: 'keep-alive',
                Referer: 'https://www.facebook.com/'
            }
        });

        const rawBuffer = Buffer.from(videoResponse.data || []);
        if (!rawBuffer.length) {
            throw new Error('Failed to download video');
        }

        const playableBuffer = await normalizeVideoBuffer(rawBuffer);

        await sock.sendMessage(chatId, {
            video: playableBuffer,
            mimetype: 'video/mp4',
            caption: postCaption
        }, { quoted: message });
    } catch (error) {
        console.error('Error in Facebook command:', error);
        await sock.sendMessage(chatId, {
            text: `An error occurred. API might be down. Error: ${error.message}`
        }, { quoted: message });
    }
}





module.exports = {
  name: 'facebook',
  async execute(ctx) {
    return facebookCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
