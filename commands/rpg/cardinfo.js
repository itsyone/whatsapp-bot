const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { getCardOwners } = require('../../lib/cardClaimStore');
const { getBuffer, gifToMp4 } = require('../../lib/myfunc'); // ✅ Import gifToMp4

const DATA_PATHS = [
    path.join(process.cwd(), 'data', 'mazoku_cards.json'),
    path.join(process.cwd(), '..', 'data', 'mazoku_cards.json'),
    path.join(__dirname, '..', '..', 'data', 'mazoku_cards.json')
];

const rarityEmoji = {
    'C': '⚪', 'R': '⭐', 'SR': '🌟',
    'SSR': '💎', 'UR': '🔥', 'EX': '👑'
};

const rarityNames = {
    'C': 'Common', 'R': 'Rare', 'SR': 'Super Rare',
    'SSR': 'SSR', 'UR': 'Ultra Rare', 'EX': 'Exclusive'
};

const rarityShort = ['C', 'R', 'SR', 'SSR', 'UR', 'EX'];

let cachedCards = null;

// ─── Format detection ────────────────────────────────────────────────────────

function isMp4Buffer(buffer) {
    // ftyp box at offset 4 signals MP4/MOV
    return buffer.length > 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp';
}

function isGifBuffer(buffer) {
    return buffer.length > 3 && buffer.slice(0, 3).toString('ascii') === 'GIF';
}

function isWebpBuffer(buffer) {
    return (
        buffer.length > 12 &&
        buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
        buffer.slice(8, 12).toString('ascii') === 'WEBP'
    );
}

// ─── Image helpers ───────────────────────────────────────────────────────────

/**
 * Makes a JPEG thumbnail suitable for WhatsApp's jpegThumbnail field.
 * Returns null on failure so callers can simply omit it.
 */
async function makeCardThumbnail(buffer) {
    try {
        const meta = await sharp(buffer, { animated: true, limitInputPixels: false })
            .metadata()
            .catch(() => null);

        if (!meta || !(meta.width > 0 && meta.width < 10000 && meta.height > 0 && meta.height < 10000)) {
            return null;
        }

        // Extract only the first frame for the thumbnail
        return await sharp(buffer, { animated: false, limitInputPixels: false })
            .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();
    } catch {
        return null;
    }
}

/**
 * Produces a high-quality PNG for static cards.
 * Preserves aspect ratio — no stretching.
 */
async function makeStillCardImage(buffer) {
    const meta = await sharp(buffer, { limitInputPixels: false })
        .metadata()
        .catch(() => ({ width: 0, height: 0 }));

    let pipeline = sharp(buffer, { limitInputPixels: false }).rotate();

    // Only upscale if both dimensions are below 1080
    if ((meta.width || 0) < 1080 && (meta.height || 0) < 1080) {
        pipeline = pipeline.resize({
            width: 1080,
            height: 1080,
            fit: 'inside',           // ✅ preserve aspect ratio, no stretch
            withoutEnlargement: false,
            kernel: 'lanczos3'
        });
    }

    return pipeline.png({ compressionLevel: 6 }).toBuffer();
}

// ─── Card loader ─────────────────────────────────────────────────────────────

function loadCards() {
    if (cachedCards) return cachedCards;
    const dataPath = DATA_PATHS.find(p => fs.existsSync(p));
    if (!dataPath) return [];
    try {
        const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        cachedCards = Array.isArray(raw) ? raw : [];
        return cachedCards;
    } catch {
        return [];
    }
}

// ─── Main command ─────────────────────────────────────────────────────────────

async function cardInfoCommand(sock, chatId, message, rawText) {
    const query = String(rawText || '').replace(/^\.(?:cardinfo|ci)\b/i, '').trim();
    if (!query) {
        await sock.sendMessage(chatId, {
            text: 'Usage: `.ci <name> <rarity>`\nExample: `.ci gojo SSR`'
        }, { quoted: message });
        return;
    }

    const cards = loadCards();
    if (!cards.length) {
        await sock.sendMessage(chatId, { text: 'Card database not found.' }, { quoted: message });
        return;
    }

    // Parse optional rarity suffix
    const parts = query.split(/\s+/);
    let searchName = query;
    let searchTier = null;

    if (parts.length > 1) {
        const lastPart = parts[parts.length - 1].toUpperCase();
        if (rarityShort.includes(lastPart)) {
            searchTier = lastPart;
            searchName = parts.slice(0, -1).join(' ');
        }
    }

    let matches = cards.filter(c =>
        String(c.name || '').toLowerCase().includes(searchName.toLowerCase())
    );
    if (searchTier) {
        matches = matches.filter(c => String(c.tier || '').toUpperCase() === searchTier);
    }

    if (!matches.length) {
        await sock.sendMessage(chatId, {
            text: `No cards found matching "${query}".`
        }, { quoted: message });
        return;
    }

    const card = matches[0];
    const tier = String(card.tier || 'C').toUpperCase();
    const rarityName = rarityNames[tier] || 'Common';
    const emoji = rarityEmoji[tier] || '⚪';
    const value = card.price || 0;
    const uuid = card.uuid ? card.uuid.split('-')[0].toUpperCase() : '????';

    const owners = getCardOwners(card.name, tier);
    let ownerText = '> no owner of this card';
    if (owners.length > 0) {
        const first = owners[0];
        const count = owners.reduce((sum, o) => sum + o.count, 0);
        ownerText = `> owner: @${first.jid.split('@')[0]}${count > 1 ? ` and ${count - 1} others` : ''}`;
    }

    const caption =
        `*📋 Card Info — #${uuid}*\n\n` +
        `*${card.name}*\n` +
        `*📺 Series: ${card.series || 'Unknown'}*\n` +
        `*${emoji} Rarity: ${rarityName}*\n` +
        `*💰 Value: \`${value.toLocaleString()}\` coins*\n\n` +
        ownerText;

    const mentions = owners.map(o => o.jid);

    // ── Check manifest for preconverted MP4 ─────────────────────────────────────
    const manifestPath = path.join(process.cwd(), 'data', 'converted-cards', 'manifest.json');
    let buffer = null;
    let tempFile = null;

    if (fs.existsSync(manifestPath)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const manifestEntry = manifest[uuid];
            
            if (manifestEntry && manifestEntry.type === 'mp4' && fs.existsSync(manifestEntry.path)) {
                console.log(`[CARDINFO] Using preconverted MP4 from manifest`);
                buffer = fs.readFileSync(manifestEntry.path);
                tempFile = manifestEntry.path; // Mark for deletion after send
            }
        } catch (err) {
            console.log(`[CARDINFO] Manifest read failed, falling back to fetch`);
        }
    }

    // ── No image URL → send text only ────────────────────────────────────────
    if (!card.image && !buffer) {
        await sock.sendMessage(chatId, { text: caption, mentions }, { quoted: message });
        return;
    }

    // ── Fetch image buffer if not from manifest ────────────────────────────────
    if (!buffer) {
        buffer = await getBuffer(card.image, {
            timeout: 8000,
            maxContentLength: 50 * 1024 * 1024,
            maxBodyLength:    50 * 1024 * 1024
        }).catch(() => null);

        if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 1024) {
            // Fetch failed — text fallback
            await sock.sendMessage(chatId, { text: caption, mentions }, { quoted: message });
            return;
        }

        console.log(`[CARDINFO] Fetched ${card.name} — ${buffer.length} bytes`);
    }

    try {
        const gif  = isGifBuffer(buffer);
        const webp = isWebpBuffer(buffer);
        const mp4  = isMp4Buffer(buffer);

        // ── MP4: send directly ────────────────────────────────────────────────
        if (mp4) {
            console.log('[CARDINFO] Sending as MP4 (direct)');
            const thumbnail = await makeCardThumbnail(buffer);
            await sock.sendMessage(chatId, {
                video: buffer,
                gifPlayback: true,
                caption,
                mimetype: 'video/mp4',
                mentions,
                ...(thumbnail ? { jpegThumbnail: thumbnail } : {})
            }, { quoted: message });
            // Cleanup temp file if from manifest
            if (tempFile) { try { fs.unlinkSync(tempFile); } catch {} }
            return;
        }

        // ── GIF: convert to real MP4 first ────────────────────────────────────
        // ✅ Raw GIF buffers sent as video/mp4 cause blurry / broken playback.
        //    gifToMp4 in myfunc.js runs proper ffmpeg conversion with caching.
        if (gif) {
            console.log('[CARDINFO] Converting GIF → MP4 via ffmpeg');
            const mp4Buffer = await gifToMp4(buffer).catch(() => null);

            if (mp4Buffer && mp4Buffer.length > 1024) {
                console.log(`[CARDINFO] MP4 size: ${mp4Buffer.length / 1024 / 1024}MB`);
                const thumbnail = await makeCardThumbnail(buffer); // use original for thumb
                await sock.sendMessage(chatId, {
                    video: mp4Buffer,
                    gifPlayback: true,
                    caption,
                    mimetype: 'video/mp4',
                    mentions,
                    ...(thumbnail ? { jpegThumbnail: thumbnail } : {})
                }, { quoted: message });
                // Cleanup temp file if from manifest
                if (tempFile) { try { fs.unlinkSync(tempFile); } catch {} }
                return;
            }

            // ffmpeg failed — fall through to static image
            console.log('[CARDINFO] GIF→MP4 conversion failed, falling back to still image');
        }

        // ── Animated WebP: check page count then convert ───────────────────────
        if (webp) {
            const meta = await sharp(buffer, { animated: true, limitInputPixels: false })
                .metadata()
                .catch(() => ({}));

            if ((meta.pages || 1) > 1) {
                console.log(`[CARDINFO] Animated WebP (${meta.pages} frames) → converting to MP4`);
                const mp4Buffer = await gifToMp4(buffer).catch(() => null);

                if (mp4Buffer && mp4Buffer.length > 1024) {
                    console.log(`[CARDINFO] MP4 size: ${mp4Buffer.length / 1024 / 1024}MB`);
                    const thumbnail = await makeCardThumbnail(buffer);
                    await sock.sendMessage(chatId, {
                        video: mp4Buffer,
                        gifPlayback: true,
                        caption,
                        mimetype: 'video/mp4',
                        mentions,
                        ...(thumbnail ? { jpegThumbnail: thumbnail } : {})
                    }, { quoted: message });
                    // Cleanup temp file if from manifest
                    if (tempFile) { try { fs.unlinkSync(tempFile); } catch {} }
                    return;
                }

                console.log('[CARDINFO] WebP→MP4 conversion failed, falling back to still image');
            }
            // Static WebP — fall through to still image
        }

        // ── Static image (PNG/JPG/static WebP) ───────────────────────────────
        console.log('[CARDINFO] Sending as static image');
        const finalBuffer = await makeStillCardImage(buffer);
        await sock.sendMessage(chatId, {
            image: finalBuffer,
            mimetype: 'image/png',
            caption,
            mentions
        }, { quoted: message });
        // Cleanup temp file if from manifest
        if (tempFile) { try { fs.unlinkSync(tempFile); } catch {} }

    } catch (err) {
        console.error('[CARDINFO] Processing error:', err.message);
        // Last-resort text fallback
        await sock.sendMessage(chatId, { text: caption, mentions }, { quoted: message });
        // Cleanup temp file if from manifest
        if (tempFile) { try { fs.unlinkSync(tempFile); } catch {} }
    }
}

module.exports = {
    name: 'cardinfo',
    alias: ['ci'],
    async execute(ctx) {
        return cardInfoCommand(ctx.sock, ctx.chatId, ctx.message, ctx.rawText);
    }
};