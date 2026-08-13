const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { downloadContentFromMessage } = require('../../lib/baileys');

let sharp = null;
try {
    sharp = require('sharp');
} catch {}

const DATA_PATH = path.join(process.cwd(), 'data', 'antiporn.json');
const TEMP_DIR = path.join(process.cwd(), 'temp_antiporn');
const WARN_LIMIT = 3;
const IMAGE_MAX_BYTES = Math.max(128 * 1024, Number(process.env.ANTIPORN_IMAGE_MAX_BYTES || 8 * 1024 * 1024));
const VIDEO_MAX_BYTES = Math.max(512 * 1024, Number(process.env.ANTIPORN_VIDEO_MAX_BYTES || 18 * 1024 * 1024));
const VIDEO_MAX_SECONDS = Math.max(2, Number(process.env.ANTIPORN_VIDEO_MAX_SECONDS || 30));
const HF_API_KEY = String(
    process.env.HF_API_KEY ||
    process.env.HUGGINGFACE_API_KEY ||
    process.env.HF_TOKEN ||
    ''
).trim();
const DEFAULT_ANTIPORN_MODEL = 'Falconsai/nsfw_image_detection';
const ANTIPORN_MODEL = String(process.env.ANTIPORN_MODEL || DEFAULT_ANTIPORN_MODEL).trim();
const ANTIPORN_FALLBACK_MODEL = String(process.env.ANTIPORN_FALLBACK_MODEL || DEFAULT_ANTIPORN_MODEL).trim();
const ANTIPORN_STRICT = !/^(0|false|no|off)$/i.test(String(process.env.ANTIPORN_STRICT || 'true').trim());
const candidateLabels = [
    'porn',
    'hentai',
    'explicit nudity',
    'nudity',
    'sexual content',
    'adult content',
    'nsfw',
    'suggestive',
    'safe content',
    'clothed person',
    'non-explicit'
];

function ensureStore() {
    const dir = path.dirname(DATA_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DATA_PATH)) {
        fs.writeFileSync(DATA_PATH, JSON.stringify({ groups: {}, warnings: {} }, null, 2), 'utf8');
    }
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function loadStore() {
    ensureStore();
    try {
        const raw = fs.readFileSync(DATA_PATH, 'utf8');
        const data = JSON.parse(raw || '{}');
        return {
            groups: data.groups || {},
            warnings: data.warnings || {}
        };
    } catch {
        return { groups: {}, warnings: {} };
    }
}

function saveStore(data) {
    ensureStore();
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function getConfig(groupId) {
    return loadStore().groups[groupId] || null;
}

function setConfig(groupId, enabled) {
    const store = loadStore();
    store.groups[groupId] = { enabled: Boolean(enabled), maxWarns: WARN_LIMIT };
    saveStore(store);
    return store.groups[groupId];
}

function removeConfig(groupId) {
    const store = loadStore();
    delete store.groups[groupId];
    delete store.warnings[groupId];
    saveStore(store);
}

function addWarning(groupId, userId) {
    const store = loadStore();
    if (!store.warnings[groupId]) store.warnings[groupId] = {};
    store.warnings[groupId][userId] = Number(store.warnings[groupId][userId] || 0) + 1;
    saveStore(store);
    return store.warnings[groupId][userId];
}

function resetWarning(groupId, userId) {
    const store = loadStore();
    if (store.warnings[groupId]) {
        delete store.warnings[groupId][userId];
        saveStore(store);
    }
}

function buildWarnText(userNumber, currentWarns, maxWarns) {
    const dots = Array.from({ length: maxWarns }, (_, i) => (i < currentWarns ? '●' : '○')).join('');
    const remaining = Math.max(0, maxWarns - currentWarns);
    return [
        '*ANTI-PORN*',
        `@${userNumber}`,
        'x nsfw media removed',
        `warn: ${dots}`,
        `${remaining}/${maxWarns} left`
    ].join('\n');
}

function getWarnDots(count, maxWarns) {
    return Array.from({ length: maxWarns }, (_, i) => (i < count ? '●' : '○')).join(' ');
}

function unwrapLiveMessage(messageNode = {}) {
    let node = messageNode;
    const seen = new Set();

    while (node && typeof node === 'object' && !seen.has(node)) {
        seen.add(node);

        if (node.imageMessage) return { kind: 'image', media: node.imageMessage };
        if (node.stickerMessage) return { kind: 'sticker', media: node.stickerMessage };
        if (node.videoMessage) return { kind: 'video', media: node.videoMessage };

        if (node.ephemeralMessage?.message) {
            node = node.ephemeralMessage.message;
            continue;
        }
        if (node.viewOnceMessage?.message) {
            node = node.viewOnceMessage.message;
            continue;
        }
        if (node.viewOnceMessageV2?.message) {
            node = node.viewOnceMessageV2.message;
            continue;
        }
        if (node.viewOnceMessageV2Extension?.message) {
            node = node.viewOnceMessageV2Extension.message;
            continue;
        }
        if (node.documentWithCaptionMessage?.message) {
            node = node.documentWithCaptionMessage.message;
            continue;
        }
        if (node.editedMessage?.message) {
            node = node.editedMessage.message;
            continue;
        }

        break;
    }

    return null;
}

function extractMediaPayload(message = {}) {
    return unwrapLiveMessage(message.message || {});
}

async function downloadBuffer(media, streamKind, maxBytes) {
    const stream = await downloadContentFromMessage(media, streamKind);
    const chunks = [];
    let total = 0;

    for await (const chunk of stream) {
        const part = Buffer.from(chunk);
        total += part.length;
        if (maxBytes && total > maxBytes) {
            throw new Error(`Media too large for anti-porn scan (${total} bytes)`);
        }
        chunks.push(part);
    }

    return Buffer.concat(chunks);
}

async function normalizeImageBuffer(buffer, kind) {
    if (!buffer?.length) return buffer;

    if (!sharp) {
        if (kind === 'sticker') {
            const viaFfmpeg = await convertStickerToJpegViaFfmpeg(buffer);
            return viaFfmpeg || buffer;
        }
        return buffer;
    }

    try {
        if (kind === 'sticker') {
            const still = await sharp(buffer, { animated: true })
                .rotate()
                .resize({
                    width: 896,
                    height: 896,
                    fit: 'inside',
                    withoutEnlargement: true
                })
                .jpeg({ quality: 84 })
                .toBuffer();
            if (still?.length) return still;
        }

        return await sharp(buffer, { animated: true })
            .rotate()
            .resize({
                width: 896,
                height: 896,
                fit: 'inside',
                withoutEnlargement: true
            })
            .jpeg({ quality: 82 })
            .toBuffer();
    } catch {
        if (kind === 'sticker') {
            const viaFfmpeg = await convertStickerToJpegViaFfmpeg(buffer);
            return viaFfmpeg || buffer;
        }
        return buffer;
    }
}

async function buildStickerVisionVariants(buffer) {
    if (!buffer?.length) return [];

    if (!sharp) {
        const normalized = await normalizeImageBuffer(buffer, 'sticker');
        return normalized?.length ? [normalized] : [];
    }

    try {
        const base = sharp(buffer, { animated: true }).rotate().trim();
        const metadata = await base.metadata().catch(() => null);
        const width = Math.max(1, Number(metadata?.width || 0));
        const height = Math.max(1, Number(metadata?.height || 0));
        const longestSide = Math.max(width, height);
        const zoomSize = Math.max(256, Math.floor(longestSide * 0.82));
        const left = Math.max(0, Math.floor((width - zoomSize) / 2));
        const top = Math.max(0, Math.floor((height - zoomSize) / 2));

        const containVariant = await base
            .resize({
                width: 896,
                height: 896,
                fit: 'contain',
                withoutEnlargement: false,
                background: { r: 245, g: 245, b: 245, alpha: 1 }
            })
            .jpeg({ quality: 88 })
            .toBuffer();

        const coverVariant = await base
            .resize({
                width: 896,
                height: 896,
                fit: 'cover',
                position: 'centre'
            })
            .flatten({ background: '#f5f5f5' })
            .jpeg({ quality: 88 })
            .toBuffer();

        const zoomVariant = await base
            .extract({
                left,
                top,
                width: Math.min(width, zoomSize),
                height: Math.min(height, zoomSize)
            })
            .resize({
                width: 896,
                height: 896,
                fit: 'cover',
                position: 'centre'
            })
            .flatten({ background: '#f5f5f5' })
            .jpeg({ quality: 88 })
            .toBuffer();

        return [containVariant, coverVariant, zoomVariant].filter((item) => item?.length);
    } catch {
        const normalized = await normalizeImageBuffer(buffer, 'sticker');
        return normalized?.length ? [normalized] : [];
    }
}

function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        if (!ffmpegPath) return reject(new Error('ffmpeg-static unavailable'));

        const child = spawn(ffmpegPath, args, { windowsHide: true });
        let stderr = '';

        child.stderr.on('data', (chunk) => {
            stderr += String(chunk || '');
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) return resolve();
            reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
        });
    });
}

async function convertStickerToJpegViaFfmpeg(buffer) {
    if (!buffer?.length || !ffmpegPath) return null;
    ensureStore();

    const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const inputPath = path.join(TEMP_DIR, `antiporn_sticker_${stamp}.webp`);
    const outputPath = path.join(TEMP_DIR, `antiporn_sticker_${stamp}.jpg`);

    try {
        await fs.promises.writeFile(inputPath, buffer);
        await runFfmpeg([
            '-y',
            '-i', inputPath,
            '-frames:v', '1',
            '-q:v', '4',
            outputPath
        ]);
        const out = await fs.promises.readFile(outputPath);
        return out?.length ? out : null;
    } catch {
        return null;
    } finally {
        try { await fs.promises.unlink(inputPath); } catch {}
        try { await fs.promises.unlink(outputPath); } catch {}
    }
}

async function extractVideoFrames(buffer, seconds = 0) {
    if (!buffer?.length || !ffmpegPath) return [];

    ensureStore();
    const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const inputPath = path.join(TEMP_DIR, `antiporn_${stamp}.mp4`);
    const timestamps = [Math.min(Math.max(seconds * 0.15, 0.35), Math.max(seconds - 0.35, 0.35))];
    if (seconds >= 4) timestamps.push(Math.max(0.5, seconds / 2));
    if (seconds >= 8) timestamps.push(Math.max(0.75, seconds - 1.2));

    const frames = [];

    try {
        await fs.promises.writeFile(inputPath, buffer);

        for (let i = 0; i < timestamps.length; i += 1) {
            const ts = timestamps[i];
            const outputPath = path.join(TEMP_DIR, `antiporn_${stamp}_${i}.jpg`);

            try {
                await runFfmpeg([
                    '-y',
                    '-ss', String(ts),
                    '-i', inputPath,
                    '-frames:v', '1',
                    '-q:v', '4',
                    outputPath
                ]);

                const frame = await fs.promises.readFile(outputPath);
                if (frame.length) frames.push(frame);
            } catch {}

            try {
                await fs.promises.unlink(outputPath);
            } catch {}
        }
    } finally {
        try {
            await fs.promises.unlink(inputPath);
        } catch {}
    }

    return frames;
}
async function extractStickerFrames(buffer, isAnimated) {
    if (!buffer?.length) return [];

    const frames = await buildStickerVisionVariants(buffer);
    if (!isAnimated || !ffmpegPath) return frames;

    ensureStore();
    const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const inputPath = path.join(TEMP_DIR, `antiporn_sticker_anim_${stamp}.webp`);
    const outputPattern = path.join(TEMP_DIR, `antiporn_sticker_anim_${stamp}_%02d.jpg`);

    try {
        await fs.promises.writeFile(inputPath, buffer);
        await runFfmpeg([
            '-y',
            '-i', inputPath,
            '-vf', 'fps=2',
            '-frames:v', '4',
            '-q:v', '4',
            outputPattern
        ]);

        for (let i = 1; i <= 4; i += 1) {
            const outPath = path.join(TEMP_DIR, `antiporn_sticker_anim_${stamp}_${String(i).padStart(2, '0')}.jpg`);
            try {
                const frame = await fs.promises.readFile(outPath);
                if (frame?.length) {
                    const variants = await buildStickerVisionVariants(frame);
                    frames.push(...variants);
                }
            } catch {}
            try { await fs.promises.unlink(outPath); } catch {}
        }
    } catch {
        return frames;
    } finally {
        try { await fs.promises.unlink(inputPath); } catch {}
    }

    return frames;
}

function isAnimatedStickerBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 32) return false;
    const text = buffer.toString('ascii');
    return text.includes('ANIM') || text.includes('ANMF');
}

function scoreResult(entries) {
    const scores = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const label = String(entry?.label || '').trim().toLowerCase();
        scores.set(label, Number(entry?.score || 0));
    }

    const value = (label) => Number(scores.get(label) || 0);
    const explicit = Math.max(value('porn'), value('hentai'), value('explicit nudity'));
    const medium = Math.max(value('nudity'), value('sexual content'), value('adult content'), value('nsfw'));
    const suggestive = value('suggestive');
    const safe = Math.max(value('safe content'), value('clothed person'), value('non-explicit'));
    const combinedRisk = explicit + medium + (suggestive * 0.35);
    const flagged =
        explicit >= 0.2 ||
        medium >= 0.4 ||
        combinedRisk >= 0.72 ||
        (combinedRisk >= 0.42 && combinedRisk > safe + 0.14);

    const topLabel = [...scores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'nsfw';
    return { flagged, topLabel };
}
function normalizeLabel(value) {
    return String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
}

function scoreBinaryImageClassification(entries, sensitivity = 'normal') {
    const scores = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const label = normalizeLabel(entry?.label);
        if (!label) continue;
        scores.set(label, Number(entry?.score || 0));
    }

    const pick = (hints) => {
        let best = 0;
        for (const [label, score] of scores.entries()) {
            if (hints.some((hint) => label.includes(hint))) {
                best = Math.max(best, score);
            }
        }
        return best;
    };

    const nsfw = pick(['nsfw', 'porn', 'hentai', 'explicit', 'nude', 'sexual', 'adult', 'erotic']);
    const safe = pick(['safe', 'sfw', 'normal', 'clean', 'non explicit', 'non-explicit']);
    const top = [...scores.entries()].sort((a, b) => b[1] - a[1])[0] || ['safe', 0];
    const topLabel = top[0];
    const topScore = Number(top[1] || 0);
    const topLooksNsfw = ['nsfw', 'porn', 'hentai', 'explicit', 'nude', 'sexual', 'adult', 'erotic']
        .some((hint) => topLabel.includes(hint));
    const strictThresholds = {
        sticker: { nsfw: 0.09, edge: 0.06, delta: 0.0, top: 0.08 },
        video: { nsfw: 0.14, edge: 0.1, delta: 0.01, top: 0.1 },
        normal: { nsfw: 0.18, edge: 0.12, delta: 0.02, top: 0.12 }
    };
    const relaxedThresholds = {
        sticker: { nsfw: 0.24, edge: 0.18, delta: 0.04, top: 0.16 },
        video: { nsfw: 0.32, edge: 0.24, delta: 0.06, top: 0.18 },
        normal: { nsfw: 0.4, edge: 0.3, delta: 0.08, top: 0.22 }
    };
    const thresholds = (ANTIPORN_STRICT ? strictThresholds : relaxedThresholds)[sensitivity] || (ANTIPORN_STRICT ? strictThresholds.normal : relaxedThresholds.normal);
    const flagged =
        nsfw >= thresholds.nsfw ||
        (nsfw >= thresholds.edge && nsfw > safe + thresholds.delta) ||
        (topLooksNsfw && topScore >= thresholds.top);
    return { flagged, topLabel };
}
function inferImageMime(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (
        buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
    ) return 'image/webp';
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif';
    return 'image/jpeg';
}

async function classifyWithDirectModel(buffer, model, sensitivity = 'normal') {
    if (!HF_API_KEY || !buffer?.length) return null;
    try {
        const response = await fetch(`https://router.huggingface.co/hf-inference/models/${encodeURIComponent(model)}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${HF_API_KEY}`,
                'Content-Type': inferImageMime(buffer)
            },
            body: buffer
        });

        if (!response.ok) return null;
        const out = await response.json().catch(() => null);
        if (!Array.isArray(out)) return null;
        return scoreBinaryImageClassification(out, sensitivity);
    } catch {
        return null;
    }
}

async function classifyImageBuffer(buffer, sensitivity = 'normal') {
    if (!HF_API_KEY || !buffer?.length) return null;

    const primary = await classifyWithDirectModel(buffer, ANTIPORN_MODEL, sensitivity);
    if (primary?.flagged) return primary;

    if (ANTIPORN_FALLBACK_MODEL && ANTIPORN_FALLBACK_MODEL !== ANTIPORN_MODEL) {
        const fallback = await classifyWithDirectModel(buffer, ANTIPORN_FALLBACK_MODEL, sensitivity);
        if (fallback?.flagged) return fallback;
    }

    if (DEFAULT_ANTIPORN_MODEL !== ANTIPORN_MODEL && DEFAULT_ANTIPORN_MODEL !== ANTIPORN_FALLBACK_MODEL) {
        const directFallback = await classifyWithDirectModel(buffer, DEFAULT_ANTIPORN_MODEL, sensitivity);
        if (directFallback?.flagged) return directFallback;
    }

    if (process.env.ANTIPORN_DEBUG === '1') {
        console.log('[antiporn] verdict', {
            sensitivity,
            primary: primary?.topLabel || null,
            fallbackModel: ANTIPORN_FALLBACK_MODEL,
            fallback: primary?.flagged ? 'flagged' : 'clear'
        });
    }

    return primary || { flagged: false, topLabel: 'safe' };
}

async function scanMediaPayload(payload) {
    if (!payload || !HF_API_KEY) return { flagged: false };

    if (payload.kind === 'video') {
        const seconds = Number(payload.media?.seconds || 0);
        if (seconds > VIDEO_MAX_SECONDS) return { flagged: false };

        const videoBuffer = await downloadBuffer(payload.media, 'video', VIDEO_MAX_BYTES);
        const frames = await extractVideoFrames(videoBuffer, Math.max(seconds, 1));
        for (const frame of frames) {
            const verdict = await classifyImageBuffer(await normalizeImageBuffer(frame, 'image'), 'video');
            if (verdict?.flagged) {
                return { ...verdict, kind: 'video' };
            }
        }
        return { flagged: false };
    }

    const streamKind = payload.kind === 'sticker' ? 'sticker' : 'image';
    const mediaBuffer = await downloadBuffer(payload.media, streamKind, IMAGE_MAX_BYTES);

    if (payload.kind === 'sticker') {
        const isAnimated = Boolean(payload.media?.isAnimated) || isAnimatedStickerBuffer(mediaBuffer);
        const frames = await extractStickerFrames(mediaBuffer, isAnimated);
        for (const frame of frames) {
            const verdict = await classifyImageBuffer(frame, 'sticker');
            if (verdict?.flagged) {
                return { ...verdict, kind: payload.kind };
            }
        }
        return { flagged: false, kind: payload.kind };
    }

    const verdict = await classifyImageBuffer(await normalizeImageBuffer(mediaBuffer, payload.kind), 'normal');
    return { ...(verdict || { flagged: false }), kind: payload.kind };
}

async function deleteMessage(sock, chatId, message, senderId) {
    try {
        await sock.sendMessage(chatId, { delete: message.key });
        return true;
    } catch {
        try {
            await sock.sendMessage(chatId, {
                delete: {
                    remoteJid: chatId,
                    fromMe: false,
                    id: message.key.id,
                    participant: message.key.participant || senderId
                }
            });
            return true;
        } catch (error) {
            console.error('[antiporn] delete failed:', error?.message || error);
            return false;
        }
    }
}

async function handleAntipornCommand(sock, chatId, userMessage, senderId, isSenderAdmin, message) {
    try {
        if (!isSenderAdmin) {
            await sock.sendMessage(chatId, { text: 'admins only.' }, { quoted: message });
            return;
        }

        const input = String(userMessage || '').trim().toLowerCase();
        const parts = input.split(/\s+/);
        const action = String(parts[1] || '').toLowerCase();

        if (!HF_API_KEY && action === 'on') {
            await sock.sendMessage(chatId, {
                text: 'HF_API_KEY is missing, so anti-porn vision cannot be enabled yet.'
            }, { quoted: message });
            return;
        }

        if (!action) {
            await sock.sendMessage(chatId, {
                text: [
                    '*ANTI-PORN*',
                    '.antiporn on',
                    '.antiporn off',
                    '.antiporn get',
                    '',
                    'Alias: .antip'
                ].join('\n')
            }, { quoted: message });
            return;
        }

        if (action === 'on') {
            setConfig(chatId, true);
            await sock.sendMessage(chatId, {
                text: 'Anti-porn is now ON.\nscan: image, sticker, view-once, video\nlimit: 3 warns'
            }, { quoted: message });
            return;
        }

        if (action === 'off') {
            removeConfig(chatId);
            await sock.sendMessage(chatId, { text: 'Anti-porn is now OFF.' }, { quoted: message });
            return;
        }

        if (action === 'get' || action === 'status') {
            const config = getConfig(chatId);
            await sock.sendMessage(chatId, {
                text: [
                    '*ANTI-PORN*',
                    `status: ${config?.enabled ? 'on' : 'off'}`,
                    `warns: ${WARN_LIMIT}`,
                    `vision: ${HF_API_KEY ? 'ready' : 'missing key'}`
                ].join('\n')
            }, { quoted: message });
            return;
        }

        await sock.sendMessage(chatId, { text: 'Use .antiporn on, off, or get.' }, { quoted: message });
    } catch (error) {
        console.error('[antiporn] command error:', error);
        await sock.sendMessage(chatId, { text: 'Failed to update anti-porn.' }, { quoted: message });
    }
}

async function handleAntipornDetection(sock, chatId, message, senderId) {
    try {
        const config = getConfig(chatId);
        if (!config?.enabled || !HF_API_KEY) return false;
        if (message?.key?.fromMe) return false;

        const payload = extractMediaPayload(message);
        if (!payload) return false;

        const verdict = await scanMediaPayload(payload);
        if (!verdict?.flagged) return false;

        await deleteMessage(sock, chatId, message, senderId);

        const currentWarns = addWarning(chatId, senderId);
        const userNumber = String(senderId || '').split('@')[0];

        if (currentWarns >= WARN_LIMIT) {
            resetWarning(chatId, senderId);

            let removed = true;
            try {
                await sock.groupParticipantsUpdate(chatId, [senderId], 'remove');
            } catch (error) {
                removed = false;
                console.error('[antiporn] remove failed:', error?.message || error);
            }

            await sock.sendMessage(chatId, {
                text: [
                    '*ANTI-PORN*',
                    `@${userNumber}`,
                    removed ? 'removed after 3/3 warns' : 'hit 3/3 warns but could not be removed',
                    `reason: ${verdict.topLabel || 'nsfw media'}`,
                    `warn: ${getWarnDots(WARN_LIMIT, WARN_LIMIT)}`
                ].join('\n'),
                mentions: [senderId]
            });
            return true;
        }

        await sock.sendMessage(chatId, {
            text: buildWarnText(userNumber, currentWarns, WARN_LIMIT),
            mentions: [senderId]
        });
        return true;
    } catch (error) {
        console.error('[antiporn] detection error:', error?.message || error);
        return false;
    }
}

module.exports = {
    handleAntipornCommand,
    handleAntipornDetection
};
