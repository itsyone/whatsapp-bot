const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { getRegisteredProfile } = require('../../lib/registrationStore');
let createCanvas = null;
let registerFont = null;
try {
    ({ createCanvas, registerFont } = require('canvas'));
} catch {}

const LIB_DIR = path.join(process.cwd(), 'lib');
const ASSETS_DIR = path.join(process.cwd(), 'assets');
const FONT_DIR = path.join(process.cwd(), 'fonts');

const FALLBACK_QUOTES = [
    'Discipline will take you where motivation cannot.',
    'Small progress is still progress.',
    'Keep going, even if today feels slow.',
    'Consistency beats occasional intensity.',
    'Do it anyway.'
];
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const profilePictureCache = new Map();
let quoteBackgroundCache = null;
let fontsRegistered = false;

function escapeXml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function cleanMentionText(text) {
    return String(text || '')
        .replace(/@\d+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function estimateTextWidth(text, fontSize) {
    return Math.ceil(String(text || '').length * fontSize * 0.58);
}

function wrapText(text, maxWidth, fontSize) {
    const words = cleanMentionText(text).split(' ').filter(Boolean);
    if (!words.length) return [' '];

    const lines = [];
    let current = '';

    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (estimateTextWidth(candidate, fontSize) <= maxWidth) {
            current = candidate;
            continue;
        }

        if (current) lines.push(current);
        current = word;
    }

    if (current) lines.push(current);
    return lines.slice(0, 12);
}

function generateCurrentTime() {
    return new Date().toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit'
    });
}

function getFontPaths() {
    const systemEmojiCandidates = [
        'C:\\Windows\\Fonts\\seguiemj.ttf',
        '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
        '/usr/share/fonts/noto/NotoColorEmoji.ttf',
        '/usr/share/fonts/truetype/ancient-scripts/Symbola_hint.ttf'
    ];
    const emojiFont = systemEmojiCandidates.find((fontPath) => fs.existsSync(fontPath)) || '';
    return {
        nameFontBold: path.join(FONT_DIR, 'segoeuithibd.ttf'),
        nameFontItalic: path.join(FONT_DIR, 'segoeuithis.ttf'),
        textFontRegular: path.join(FONT_DIR, 'SFPRODISPLAYREGULAR.OTF'),
        sfProBold: path.join(FONT_DIR, 'SFPRODISPLAYBOLD.OTF'),
        sfProRegular: path.join(FONT_DIR, 'SFPRODISPLAYREGULAR.OTF'),
        notoSans: path.join(FONT_DIR, 'NotoSansVar.ttf'),
        emojiFont
    };
}

function loadFont(fontPath) {
    if (!fontPath || !fs.existsSync(fontPath)) return 'sans-serif';
    const name = path.basename(fontPath).toLowerCase();
    if (name === 'segoeuithibd.ttf') return 'SegoeUIBold';
    if (name === 'segoeuithis.ttf') return 'SegoeUI';
    if (name === 'sfprodisplaybold.otf') return 'SFPROBold';
    if (name === 'sfprodisplayregular.otf') return 'SFPRO';
    if (name === 'notosansvar.ttf') return 'NotoSans';
    if (name === 'seguiemj.ttf') return 'SegoeUIEmoji';
    if (name === 'notocoloremoji.ttf') return 'NotoColorEmoji';
    if (name === 'symbola_hint.ttf') return 'Symbola';
    return 'sans-serif';
}

function buildFontStack(...families) {
    return families.filter(Boolean).join(', ');
}

function ensureCanvasFonts(fonts) {
    if (fontsRegistered || !registerFont) return;
    const items = [
        [fonts.nameFontBold, 'SegoeUIBold'],
        [fonts.nameFontItalic, 'SegoeUI'],
        [fonts.sfProBold, 'SFPROBold'],
        [fonts.sfProRegular, 'SFPRO'],
        [fonts.notoSans, 'NotoSans'],
        [fonts.emojiFont, loadFont(fonts.emojiFont)]
    ];
    for (const [fontPath, family] of items) {
        if (fontPath && fs.existsSync(fontPath)) {
            try { registerFont(fontPath, { family }); } catch {}
        }
    }
    fontsRegistered = true;
}

function drawRoundRect(ctx, x, y, width, height, radius, color) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
}

function drawBubbleCanvas({
    boxWidth,
    boxHeight,
    name,
    safeLines,
    time,
    bubbleFill,
    nameFill,
    textFill,
    timeFill,
    nameFontSize,
    fontSize,
    timeFontSize,
    bubblePaddingX,
    nameY,
    messageStartY,
    lineHeight,
    timeY,
    fonts
}) {
    if (!createCanvas) return null;
    ensureCanvasFonts(fonts);

    const canvas = createCanvas(boxWidth + 38, boxHeight);
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'alphabetic';

    drawRoundRect(ctx, 28, 0, boxWidth, boxHeight, 42, bubbleFill);

    ctx.beginPath();
    ctx.moveTo(2, 56);
    ctx.bezierCurveTo(1, 66, 1, 76, 2, 86);
    ctx.lineTo(28, 86);
    ctx.lineTo(28, 38);
    ctx.closePath();
    ctx.fillStyle = bubbleFill;
    ctx.fill();

    const offsetX = 28;
    ctx.fillStyle = nameFill;
    ctx.font = `600 ${nameFontSize}px ${buildFontStack('"SegoeUIBold"', '"SFPROBold"', '"NotoSans"', '"Segoe UI Emoji"', '"Noto Color Emoji"', 'sans-serif')}`;
    ctx.fillText(name, offsetX + bubblePaddingX, nameY);

    ctx.fillStyle = textFill;
    ctx.font = `400 ${fontSize}px ${buildFontStack('"NotoSans"', '"SFPRO"', '"Segoe UI Emoji"', '"Noto Color Emoji"', 'sans-serif')}`;
    for (let i = 0; i < safeLines.length; i += 1) {
        ctx.fillText(safeLines[i], offsetX + bubblePaddingX, messageStartY + i * lineHeight);
    }

    ctx.fillStyle = timeFill;
    ctx.font = `400 ${timeFontSize}px ${buildFontStack('"SegoeUI"', '"SFPRO"', '"NotoSans"', '"Segoe UI Emoji"', '"Noto Color Emoji"', 'sans-serif')}`;
    const timeWidth = ctx.measureText(time).width;
    ctx.fillText(time, offsetX + boxWidth - bubblePaddingX - timeWidth, timeY);

    return canvas.toBuffer('image/png');
}

function drawBubbleSvg({
    boxWidth,
    boxHeight,
    name,
    safeLines,
    time,
    bubbleFill,
    nameFill,
    textFill,
    timeFill,
    nameFont,
    textFont,
    timeFont,
    nameFontSize,
    fontSize,
    timeFontSize,
    bubblePaddingX,
    nameY,
    messageStartY,
    lineHeight,
    timeY
}) {
    const timeWidth = estimateTextWidth(time, timeFontSize);
    const namePath = textToSVGSpan(name, nameFont, nameFontSize, bubblePaddingX, nameY, 600);
    const messagePaths = safeLines.map((line, i) =>
        textToSVGPath(`${line}   `, textFont, fontSize, bubblePaddingX, messageStartY + i * lineHeight)
    ).join('\n');
    const timePath = textToSVGSpan(
        time,
        timeFont,
        timeFontSize,
        boxWidth - bubblePaddingX - timeWidth,
        timeY
    );
    return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${boxWidth + 38}" height="${boxHeight}">
<style>
.bubble{fill:${bubbleFill};}
.name{fill:${nameFill};}
.text{fill:${textFill};}
.time{fill:${timeFill};}
</style>
<rect x="28" y="0" width="${boxWidth}" height="${boxHeight}" rx="42" ry="42" class="bubble"/>
<path d="M2,56 C1,66 1,76 2,86 L28,86 L28,38 Z"
      fill="${bubbleFill}"
      transform="translate(0, 10)" />
<g class="name" transform="translate(28, 0)">${namePath}</g>
<g class="text" transform="translate(28, 0)">${messagePaths}</g>
<g class="time" transform="translate(28, 0)">${timePath}</g>
</svg>`);
}

function textToSVGPath(text, fontName, fontSize, x, y) {
    const family = escapeXml(fontName || 'sans-serif');
    const safeText = escapeXml(text);
    return `<text x="${x}" y="${y}" font-family="${family}" font-size="${fontSize}" font-weight="400">${safeText}</text>`;
}

function textToSVGSpan(text, fontName, fontSize, x, y, weight = 400) {
    const family = escapeXml(fontName || 'sans-serif');
    const safeText = escapeXml(text);
    return `<text x="${x}" y="${y}" font-family="${family}" font-size="${fontSize}" font-weight="${weight}">${safeText}</text>`;
}

async function getNoProfilePictureIcon() {
    const fallbackSvg = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
  <rect width="100%" height="100%" fill="#1f2c34"/>
  <circle cx="128" cy="100" r="48" fill="#94a3b8"/>
  <rect x="58" y="156" width="140" height="60" rx="30" fill="#94a3b8"/>
</svg>`);

    return sharp(fallbackSvg).png().toBuffer();
}

async function getProfilePictureBuffer(sock, senderId) {
    const key = String(senderId || '').trim();
    const cached = profilePictureCache.get(key);
    if (cached && Date.now() - Number(cached.at || 0) < PROFILE_CACHE_TTL_MS) {
        return cached.buffer;
    }

    try {
        const url = await Promise.race([
            sock.profilePictureUrl(senderId, 'image'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('profile-timeout')), 1800))
        ]);
        if (url) {
            const buffer = Buffer.from((await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 2500,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            })).data);
            profilePictureCache.set(key, { buffer, at: Date.now() });
            return buffer;
        }
    } catch (error) {
        const text = String(error?.message || error || '').toLowerCase();
        if (!text.includes('rate-overlimit') && !text.includes('not-authorized')) {
            console.error('Error fetching quote profile picture:', error?.message || error);
        }
    }

    const fallback = await getNoProfilePictureIcon();
    profilePictureCache.set(key, { buffer: fallback, at: Date.now() });
    return fallback;
}

function getMessageText(message) {
    return (
        message?.message?.groupMentionedMessage?.message?.conversation ||
        message?.message?.groupMentionedMessage?.message?.extendedTextMessage?.text ||
        message?.message?.groupMentionedMessage?.message?.imageMessage?.caption ||
        message?.message?.groupMentionedMessage?.message?.videoMessage?.caption ||
        message?.message?.conversation ||
        message?.message?.extendedTextMessage?.text ||
        message?.message?.imageMessage?.caption ||
        message?.message?.documentMessage?.caption ||
        message?.message?.videoMessage?.caption ||
        ''
    );
}

function getContextInfo(message) {
    return (
        message?.message?.extendedTextMessage?.contextInfo ||
        message?.message?.imageMessage?.contextInfo ||
        message?.message?.videoMessage?.contextInfo ||
        message?.message?.documentMessage?.contextInfo ||
        message?.message?.groupMentionedMessage?.message?.extendedTextMessage?.contextInfo ||
        message?.message?.groupMentionedMessage?.message?.imageMessage?.contextInfo ||
        message?.message?.groupMentionedMessage?.message?.videoMessage?.contextInfo ||
        {}
    );
}

function getQuotedMessage(message) {
    return getContextInfo(message)?.quotedMessage || null;
}

function getQuotedParticipant(message) {
    return String(getContextInfo(message)?.participant || '').trim();
}

function getQuotedMentionedTarget(message) {
    const quoted = getQuotedMessage(message);
    const context =
        quoted?.extendedTextMessage?.contextInfo ||
        quoted?.imageMessage?.contextInfo ||
        quoted?.videoMessage?.contextInfo ||
        quoted?.documentMessage?.contextInfo ||
        {};
    const mentioned = Array.isArray(context?.mentionedJid) ? context.mentionedJid : [];
    return String(mentioned.find(Boolean) || '').trim();
}

function getQuotedText(message) {
    const quoted = getQuotedMessage(message);
    return (
        quoted?.groupMentionedMessage?.message?.conversation ||
        quoted?.groupMentionedMessage?.message?.extendedTextMessage?.text ||
        quoted?.groupMentionedMessage?.message?.imageMessage?.caption ||
        quoted?.groupMentionedMessage?.message?.videoMessage?.caption ||
        quoted?.conversation ||
        quoted?.extendedTextMessage?.text ||
        quoted?.imageMessage?.caption ||
        quoted?.documentMessage?.caption ||
        quoted?.videoMessage?.caption ||
        ''
    );
}

async function fetchRandomQuote() {
    try {
        const response = await axios.get('https://zenquotes.io/api/random', {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const item = Array.isArray(response.data) ? response.data[0] : null;
        if (item?.q) return item.q;
    } catch {}

    return FALLBACK_QUOTES[Math.floor(Math.random() * FALLBACK_QUOTES.length)];
}

async function getQuoteBackgroundBuffer() {
    if (quoteBackgroundCache) return quoteBackgroundCache;

    const localFallbackPath = path.join(ASSETS_DIR, 'redacted-image.png');
    if (fs.existsSync(localFallbackPath)) {
        quoteBackgroundCache = fs.readFileSync(localFallbackPath);
        return quoteBackgroundCache;
    }

    return null;
}

function buildPatternSvg(width, height) {
    const tiles = [];
    const stepX = 170;
    const stepY = 170;

    for (let y = 30; y < height + stepY; y += stepY) {
        for (let x = 20; x < width + stepX; x += stepX) {
            const offset = ((x + y) / 37) % 18;
            tiles.push(`
  <g transform="translate(${x + offset}, ${y - (offset / 2)})" stroke="rgba(255,255,255,0.06)" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="18" cy="18" r="14" />
    <path d="M56 4l20 20-20 20-20-20z" />
    <path d="M108 5c14 0 25 11 25 25s-11 25-25 25S83 44 83 30 94 5 108 5z" />
    <path d="M100 30h16M108 22v16" />
    <path d="M10 72c9-15 30-21 45-11 8 5 12 13 12 24 0 17-13 29-33 29-16 0-30-12-30-29 0-4 1-8 3-13z" />
    <path d="M87 88c0-10 8-18 18-18s18 8 18 18-8 18-18 18-18-8-18-18z" />
    <path d="M150 80l14 14M164 80l-14 14" />
    <path d="M17 138h28M31 124v28" />
  </g>`);
        }
    }

    return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#0b141a"/>
  ${tiles.join('\n')}
</svg>`);
}

async function createWhatsAppQuote(text, name, senderId, sock, opts = {}) {
    const WIDTH = 1024;
    const HEIGHT = 1024;

    let cleanText = cleanMentionText(text);
    if (!cleanText) cleanText = ' ';

    // ===== PROFILE PIC =====
    const dp = await getProfilePictureBuffer(sock, senderId);

    const textLength = cleanText.length;
    const isBlockyText = /[\u2502\u256d\u2570\u25b0\u25b1\u2022]|orientation|meter|scan|vibe/i.test(cleanText);
    const longTextScale =
        isBlockyText ? 0.54 :
        textLength > 90 ? 0.56 :
        textLength > 70 ? 0.62 :
        textLength > 50 ? 0.72 :
        textLength > 32 ? 0.86 :
        1;
    const avatarSize = Number(opts.avatarSize || Math.round(112 * Math.min(1, longTextScale + 0.24)));

    const avatar = await sharp(dp)
        .resize(avatarSize, avatarSize, { fit: 'cover' })
        .composite([{
            input: Buffer.from(`<svg><circle cx="${avatarSize/2}" cy="${avatarSize/2}" r="${avatarSize/2}" fill="white"/></svg>`),
            blend: 'dest-in'
        }])
        .png()
        .toBuffer();

    // ===== TEXT SETTINGS =====
    const fontSize = Number(opts.fontSize || Math.round(46 * longTextScale + 6));
    const nameFontSize = Number(opts.nameFontSize || Math.round(35 * Math.min(1, longTextScale + 0.12)));
    const timeFontSize = Number(opts.timeFontSize || Math.round(18 * Math.min(1, longTextScale + 0.18)));
    const bubbleMaxWidth = Number(opts.bubbleMaxWidth || 760);
    const bubblePaddingX = Math.round(42 * Math.min(1, longTextScale + 0.18));
    const bubblePaddingTop = Math.round(20 * Math.min(1, longTextScale + 0.12));
    const bubblePaddingBottom = Math.round(16 * Math.min(1, longTextScale + 0.12));
    const reserveTimeWidth = Math.max(84, Math.round(108 * Math.min(1, longTextScale + 0.16)));
    const textAreaWidth = bubbleMaxWidth - (bubblePaddingX * 2);

    const lines = wrapText(cleanText, textAreaWidth - reserveTimeWidth, fontSize);
    const safeLines = lines.length ? lines : [' '];

    const maxLineWidth = Math.max(...safeLines.map(l => estimateTextWidth(l, fontSize)));

    const minimumBoxWidth = Number(opts.minimumBoxWidth || Math.round(420 * Math.min(1, longTextScale + 0.1)));
    const boxWidth = Math.max(
        minimumBoxWidth,
        Math.min(
            bubbleMaxWidth,
            Math.max(maxLineWidth + reserveTimeWidth, estimateTextWidth(name, nameFontSize)) + (bubblePaddingX * 2)
        )
    );

    const lineHeight = Number(opts.lineHeight || Math.round(fontSize * 1.08));
    const nameHeight = Number(opts.nameHeight || Math.round(nameFontSize * 1.1));
    const bottomMargin = Math.max(10, Math.round(timeFontSize * 0.4));

    const boxHeight =
        bubblePaddingTop +
        nameHeight +
        safeLines.length * lineHeight +
        bubblePaddingBottom +
        bottomMargin;

    const time = generateCurrentTime();
    const textLeft = bubblePaddingX;

    const nameY = bubblePaddingTop + nameFontSize;
    const messageStartY = nameY + Math.round(fontSize * 0.9);
    const timeY = boxHeight - Math.max(12, Math.round(timeFontSize * 0.45));

    // ===== COLORS =====
    const bubbleFill = '#2b2b2f';
    const nameFill = '#25D366';
    const textFill = '#f5f5f7';
    const timeFill = '#a1a1aa';

    const fonts = getFontPaths();

    const nameFont = buildFontStack(
        loadFont(fonts.notoSans),
        loadFont(fonts.nameFontBold),
        loadFont(fonts.sfProBold),
        loadFont(fonts.emojiFont),
        '"Segoe UI Emoji"',
        '"Noto Color Emoji"',
        '"Symbola"',
        'sans-serif'
    );

    const textFont = buildFontStack(
        loadFont(fonts.notoSans),
        loadFont(fonts.textFontRegular),
        loadFont(fonts.emojiFont),
        '"Segoe UI Emoji"',
        '"Noto Color Emoji"',
        '"Symbola"',
        'sans-serif'
    );

    const timeFont = buildFontStack(
        loadFont(fonts.nameFontItalic),
        loadFont(fonts.textFontRegular),
        loadFont(fonts.notoSans),
        loadFont(fonts.emojiFont),
        '"Segoe UI Emoji"',
        '"Noto Color Emoji"',
        '"Symbola"',
        'sans-serif'
    );

    const bubbleBuffer = drawBubbleCanvas({
        boxWidth,
        boxHeight,
        name,
        safeLines,
        time,
        bubbleFill,
        nameFill,
        textFill,
        timeFill,
        nameFontSize,
        fontSize,
        timeFontSize,
        bubblePaddingX,
        nameY,
        messageStartY,
        lineHeight,
        timeY,
        fonts
    }) || drawBubbleSvg({
        boxWidth,
        boxHeight,
        name,
        safeLines,
        time,
        bubbleFill,
        nameFill,
        textFill,
        timeFill,
        nameFont,
        textFont,
        timeFont,
        nameFontSize,
        fontSize,
        timeFontSize,
        bubblePaddingX,
        nameY,
        messageStartY,
        lineHeight,
        timeY
    });

    let background;
    try {
        const bgInput = await getQuoteBackgroundBuffer();
        if (!bgInput) throw new Error('missing quote background');

        const wallpaperBase = await sharp(bgInput)
            .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'centre' })
            .modulate({ brightness: 1.15, saturation: 1.04 })
            .png()
            .toBuffer();

        const wallpaperSoft = await sharp(bgInput)
            .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'centre' })
            .modulate({ brightness: 1.02, saturation: 0.98 })
            .blur(0.45)
            .png()
            .toBuffer();

        const wallpaperPattern = await sharp(buildPatternSvg(WIDTH, HEIGHT)).png().toBuffer();

        const wallpaperGlow = await sharp({
            create: {
                width: WIDTH,
                height: HEIGHT,
                channels: 4,
                background: { r: 18, g: 21, b: 26, alpha: 1 }
            }
        })
            .composite([
                { input: wallpaperSoft, top: 0, left: 0, blend: 'over', opacity: 1 },
                { input: wallpaperBase, top: 0, left: 0, blend: 'screen', opacity: 0.92 },
                { input: wallpaperPattern, top: 0, left: 0, blend: 'soft-light', opacity: 0.92 }
            ])
            .png()
            .toBuffer();

        background = wallpaperGlow;
    } catch {
        background = await sharp(buildPatternSvg(WIDTH, HEIGHT))
            .modulate({ brightness: 0.98, saturation: 0.95 })
            .png()
            .toBuffer();
    }

    const blueTint = await sharp({
        create: {
            width: WIDTH,
            height: HEIGHT,
            channels: 4,
            background: { r: 38, g: 60, b: 110, alpha: 0.06 }
        }
    }).png().toBuffer();

    const topGlow = await sharp({
        create: {
            width: WIDTH,
            height: HEIGHT,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 0 }
        }
    })
        .composite([{
            input: Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <defs>
    <radialGradient id="g" cx="50%" cy="30%" r="65%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.10)"/>
      <stop offset="55%" stop-color="rgba(170,205,255,0.04)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
</svg>`)
        }])
        .png()
        .toBuffer();

    const spacing = Math.max(8, Math.round(avatarSize * 0.08));
    const clusterWidth = avatarSize + spacing + boxWidth;
    const avatarLeft = Number(opts.avatarLeft || Math.max(42, Math.round((WIDTH - clusterWidth) / 2) + 6));
    const bubbleLeft = avatarLeft + avatarSize + spacing - Math.round(avatarSize * 0.18);
    const bubbleTop = Number(opts.topOffset || 132);
    const avatarTop = bubbleTop + Math.max(8, Math.floor((boxHeight - avatarSize) / 2) + 8);

    const overlay = await sharp({
        create: {
            width: WIDTH,
            height: HEIGHT,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0.01 }
        }
    }).png().toBuffer();

    return await sharp(background)
        .composite([
            { input: blueTint, top: 0, left: 0, blend: 'soft-light' },
            { input: topGlow, top: 0, left: 0, blend: 'screen' },
            { input: overlay, top: 0, left: 0 },
            { input: avatar, top: avatarTop, left: avatarLeft },
            { input: bubbleBuffer, top: bubbleTop, left: bubbleLeft }
        ])
        .webp({ quality: 100, effort: 6 })
        .toBuffer();
}

async function quoteCommand(sock, chatId, message) {
    try {
        const contextInfo = getContextInfo(message);
        const quotedParticipant = getQuotedParticipant(message);
        const quotedMentionTarget = getQuotedMentionedTarget(message);
        const quotedText = getQuotedText(message).trim();
        const targetId = quotedMentionTarget || quotedParticipant || message?.key?.participant || message?.key?.remoteJid || '';
        const registered = getRegisteredProfile(targetId);
        let senderName = String(registered?.name || '').trim() || targetId.split('@')[0] || 'Unknown';
        try {
            const lookupJid = targetId || message?.key?.remoteJid || '';
            const quotedName = await sock.getName(lookupJid);
            if (quotedName) senderName = String(quotedName).trim();
        } catch {}
        const rawText = getMessageText(message).trim();
        const argsText = rawText.replace(/^\.quote\b/i, '').trim();
        if (!quotedText && !quotedParticipant) {
            senderName = String(message?.pushName || senderName || 'Unknown').trim();
        }

        let text = quotedText || argsText;
        if (!text) {
            text = await fetchRandomQuote();
        }

        const stickerBuffer = await createWhatsAppQuote(text, senderName, targetId, sock);

        await sock.sendMessage(
            chatId,
            {
                sticker: stickerBuffer
            },
            { quoted: message }
        );
    } catch (error) {
        console.error('Error in quote command:', error);
        await sock.sendMessage(
            chatId,
            { text: 'Failed to generate quote image.' },
            { quoted: message }
        );
    }
}

module.exports = {
    quoteCommand,
    createWhatsAppQuote,
    getQuotedText,
    getContextInfo,
    getQuotedParticipant,
    getQuotedMentionedTarget
};
