const https = require('https');

const WIN_THUMB_URL = 'https://i.ibb.co/DfFjZrHn/Kaouru-Waguri.jpg';
const LOSS_THUMB_URL = 'https://i.ibb.co/G4zrX6Rg/download-6.jpg';
const PREVIEW_SOURCE_URL = '';

let winThumbCache = null;
let lossThumbCache = null;

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchBuffer(res.headers.location).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function getThumbBuffer(isWin) {
    if (isWin) {
        if (!winThumbCache) winThumbCache = await fetchBuffer(WIN_THUMB_URL).catch(() => null);
        return winThumbCache;
    }
    if (!lossThumbCache) lossThumbCache = await fetchBuffer(LOSS_THUMB_URL).catch(() => null);
    return lossThumbCache;
}

async function buildStyledTextPayload(text, isWin) {
    const thumbUrl = isWin ? WIN_THUMB_URL : LOSS_THUMB_URL;
    const jpegThumbnail = await getThumbBuffer(isWin);

    return {
        text,
        contextInfo: {
            externalAdReply: {
                title: isWin ? 'WIN' : 'LOSS',
                body: isWin ? 'big hit' : 'bad luck',
                sourceUrl: PREVIEW_SOURCE_URL,
                mediaType: 1,
                renderLargerThumbnail: false,
                showAdAttribution: false,
                thumbnailUrl: thumbUrl,
                ...(jpegThumbnail && { jpegThumbnail })
            }
        }
    };
}





module.exports = { buildStyledTextPayload };
