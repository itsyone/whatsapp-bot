const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');
const { getUserData } = require('../../lib/cardClaimStore');

const LOCAL_CARD_DIR = path.join(__dirname, '..', 'LC-MRBC-EN');
const GITHUB_CARD_BASE = 'https://raw.githubusercontent.com/xnx6x/cards-png/main/cards';

const tierEmoji = {
    Common: '⚪',
    Rare: '🔵',
    Epic: '🟣',
    Legendary: '🌟',
    Mythic: '🔥'
};

const tierColor = {
    Common: '#8b9bb4',
    Rare: '#4da3ff',
    Epic: '#b178ff',
    Legendary: '#ffbe3b',
    Mythic: '#ff5a6e'
};

function typeLabel(moveType) {
    const t = String(moveType || '').toUpperCase();
    if (t === 'ENV') return 'Air';
    if (t === 'POW') return 'Power';
    if (t === 'INT') return 'Intelligence';
    if (t === 'DGE') return 'Dodge';
    if (t === 'BLK') return 'Block';
    if (t === 'SPE') return 'Special';
    return 'Unknown';
}

function safeNo(cardNo) {
    const no = String(cardNo || '').trim().replace(/\D/g, '');
    if (!no) return '';
    return no;
}

function cardImageCandidates(card) {
    const rawNo = String(card?.cardNo || '').trim();
    const no = safeNo(card?.cardNo);
    const no3 = no ? no.padStart(3, '0') : '';

    return [
        rawNo ? path.join(LOCAL_CARD_DIR, `${rawNo}.png`) : '',
        no3 ? path.join(LOCAL_CARD_DIR, `${no3}.png`) : '',
        rawNo ? path.join(LOCAL_CARD_DIR, `${rawNo}.webp`) : '',
        no3 ? path.join(LOCAL_CARD_DIR, `${no3}.webp`) : '',
        rawNo ? `${GITHUB_CARD_BASE}/${rawNo}.png` : '',
        no3 ? `${GITHUB_CARD_BASE}/${no3}.png` : '',
        rawNo ? `${GITHUB_CARD_BASE}/${rawNo}.webp` : '',
        no3 ? `${GITHUB_CARD_BASE}/${no3}.webp` : '',
        card?.imageUrl || ''
    ].filter(Boolean);
}

async function tryLoadImageFromSource(src) {
    if (!src) return null;
    if (/^https?:\/\//i.test(src)) {
        const res = await axios.get(src, {
            responseType: 'arraybuffer',
            timeout: 12000,
            headers: { 'User-Agent': 'Mozilla/5.0' },
            maxContentLength: 10 * 1024 * 1024
        });
        return loadImage(Buffer.from(res.data));
    }
    if (fs.existsSync(src)) {
        return loadImage(src);
    }
    return null;
}

async function loadCardImage(card) {
    const candidates = cardImageCandidates(card);
    for (const src of candidates) {
        try {
            const img = await tryLoadImageFromSource(src);
            if (img) return img;
        } catch {}
    }
    return null;
}

function drawRoundedRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
}

async function generateShowcase(cards) {
    const cols = 4;
    const rows = 2;
    const count = Math.min(cards.length, cols * rows);

    const cardW = 360;
    const cardH = 470;
    const gap = 24;
    const pad = 28;
    const headerH = 96;

    const width = pad * 2 + cols * cardW + (cols - 1) * gap;
    const height = headerH + pad + rows * cardH + (rows - 1) * gap + pad;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, '#06112b');
    bg.addColorStop(1, '#090d1c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#dbe7ff';
    ctx.font = 'bold 56px Sans';
    ctx.fillText('Monster Showcase', pad, 68);
    ctx.fillStyle = '#8da7d1';
    ctx.font = '28px Sans';
    ctx.fillText(`${cards.length} cards owned`, pad, 98);

    for (let i = 0; i < count; i += 1) {
        const card = cards[i];
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = pad + col * (cardW + gap);
        const y = headerH + pad + row * (cardH + gap);

        const tier = card.tier || 'Common';
        const tint = tierColor[tier] || '#8b9bb4';

        ctx.save();
        drawRoundedRect(ctx, x, y, cardW, cardH, 24);
        ctx.clip();

        const panel = ctx.createLinearGradient(x, y, x, y + cardH);
        panel.addColorStop(0, '#13213a');
        panel.addColorStop(1, '#0a1325');
        ctx.fillStyle = panel;
        ctx.fillRect(x, y, cardW, cardH);

        const img = await loadCardImage(card);
        if (img) {
            const imgBoxX = x + 12;
            const imgBoxY = y + 12;
            const imgBoxW = cardW - 24;
            const imgBoxH = cardH - 128;
            ctx.drawImage(img, imgBoxX, imgBoxY, imgBoxW, imgBoxH);
        } else {
            ctx.fillStyle = '#1c2b43';
            ctx.fillRect(x + 12, y + 12, cardW - 24, cardH - 128);
            ctx.fillStyle = '#9fb4d6';
            ctx.font = 'bold 28px Sans';
            ctx.fillText('No Art', x + 24, y + 60);
        }

        ctx.fillStyle = 'rgba(0, 0, 0, 0.56)';
        ctx.fillRect(x, y + cardH - 116, cardW, 116);

        ctx.fillStyle = '#f2f7ff';
        ctx.font = 'bold 36px Sans';
        const name = String(card.cardName || 'Unknown');
        const shortName = name.length > 16 ? `${name.slice(0, 16)}…` : name;
        ctx.fillText(shortName, x + 16, y + cardH - 72);

        ctx.fillStyle = tint;
        ctx.font = '28px Sans';
        const tEmoji = tierEmoji[tier] || '⚪';
        const sub = `${tEmoji} ${tier} • ₳ ${Number(card.value || 0).toLocaleString()}`;
        ctx.fillText(sub, x + 16, y + cardH - 34);

        ctx.restore();

        ctx.strokeStyle = `${tint}88`;
        ctx.lineWidth = 3;
        drawRoundedRect(ctx, x, y, cardW, cardH, 24);
        ctx.stroke();

        ctx.fillStyle = '#b9cae9';
        ctx.font = '22px Sans';
        const badge = `${typeLabel(card.moveType)} • #${card.cardNo || 'N/A'}`;
        ctx.fillText(badge, x + 16, y + 30);
    }

    return canvas.toBuffer('image/png');
}

function buildShowcaseText(cards) {
    const top = cards.slice(0, 3);
    const lines = ['🏆 *Monster Showcase*', ''];

    for (const c of top) {
        const tier = c.tier || 'Common';
        const tEmoji = tierEmoji[tier] || '⚪';
        lines.push(`🎴 *${c.cardName || 'Unknown'}*`);
        lines.push(`   ${tEmoji} ${tier} • ${typeLabel(c.moveType)}`);
        lines.push(`   🆔 ${c.cardNo || 'N/A'} • ₳ ${Number(c.value || 0).toLocaleString()}`);
        lines.push('');
    }

    lines.push('────────────');
    lines.push(`📦 Collection: *${cards.length} cards*`);
    return lines.join('\n');
}

async function showcaseCommand(sock, chatId, message) {
    try {
        const senderId = message?.key?.participant || message?.key?.remoteJid || '';
        const inv = getUserData(senderId);
        const cards = [...(inv.cards || [])].sort((a, b) => Number(b.value || 0) - Number(a.value || 0));

        if (!cards.length) {
            await sock.sendMessage(chatId, {
                text: 'No cards in inventory yet. Claim cards first.'
            }, { quoted: message });
            return;
        }

        const gridCards = cards.slice(0, 8);
        const imageBuffer = await generateShowcase(gridCards);
        const caption = buildShowcaseText(cards);

        await sock.sendMessage(chatId, {
            image: imageBuffer,
            caption
        }, { quoted: message });
    } catch (error) {
        console.error('Error in showcase command:', error);
        await sock.sendMessage(chatId, {
            text: 'Showcase failed.'
        }, { quoted: message });
    }
}






module.exports = {
  name: 'showcase',
  async execute(ctx) {
    return showcaseCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
