const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');

const WIDTH = 960;
const HEIGHT = 1280;

function safeText(value, fallback = '') {
    const text = String(value ?? fallback).trim();
    return text || fallback;
}

function roundedRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

function drawText(ctx, text, x, y, font, color, align = 'left') {
    ctx.save();
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x, y);
    ctx.restore();
}

function drawCorner(ctx, x, y, w, h, pos) {
    const len = 26;
    ctx.save();
    ctx.strokeStyle = '#c9950c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (pos === 'tl') {
        ctx.moveTo(x, y + len);
        ctx.lineTo(x, y);
        ctx.lineTo(x + len, y);
    } else if (pos === 'tr') {
        ctx.moveTo(x + w - len, y);
        ctx.lineTo(x + w, y);
        ctx.lineTo(x + w, y + len);
    } else if (pos === 'bl') {
        ctx.moveTo(x, y + h - len);
        ctx.lineTo(x, y + h);
        ctx.lineTo(x + len, y + h);
    } else if (pos === 'br') {
        ctx.moveTo(x + w - len, y + h);
        ctx.lineTo(x + w, y + h);
        ctx.lineTo(x + w, y + h - len);
    }
    ctx.stroke();
    ctx.restore();
}

function drawPixelIcon(ctx, type, x, y, scale = 4) {
    const pixelsByType = {
        fire: {
            color1: '#c0392b',
            color2: '#e74c3c',
            color3: '#f0c040',
            a: [[2, 4], [3, 4], [1, 3], [2, 3], [3, 3], [4, 3], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2]],
            b: [[2, 1], [3, 1], [3, 0]],
            c: [[2, 3], [3, 3], [3, 2]]
        },
        bolt: {
            color1: '#9b59b6',
            color2: '#d7bde2',
            color3: '#f0c040',
            a: [[4, 0], [5, 0], [4, 1], [5, 1], [3, 2], [4, 2], [5, 2], [2, 3], [3, 3], [2, 4], [3, 4]],
            b: [[4, 1], [4, 2], [3, 3]],
            c: []
        },
        shield: {
            color1: '#2980b9',
            color2: '#85b7eb',
            color3: '#f0c040',
            a: [[1, 0], [2, 0], [3, 0], [4, 0], [0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [1, 2], [2, 2], [3, 2], [4, 2], [2, 3], [3, 3]],
            b: [[2, 1], [3, 1], [2, 2], [3, 2]],
            c: []
        },
        boot: {
            color1: '#27ae60',
            color2: '#2ecc71',
            color3: '#f0c040',
            a: [[2, 0], [3, 0], [2, 1], [3, 1], [2, 2], [3, 2], [2, 3], [3, 3], [2, 4], [3, 4], [4, 4], [5, 4], [2, 5], [3, 5], [4, 5], [5, 5]],
            b: [[2, 1], [2, 2], [2, 3], [3, 4], [4, 4]],
            c: []
        },
        eye: {
            color1: '#d4aa50',
            color2: '#7F77DD',
            color3: '#f0f0f0',
            a: [[1, 2], [2, 2], [3, 2], [4, 2], [0, 3], [1, 3], [2, 3], [3, 3], [4, 3], [5, 3], [1, 4], [2, 4], [3, 4], [4, 4]],
            b: [[2, 3], [3, 3]],
            c: [[3, 3]]
        }
    };

    const icon = pixelsByType[type] || pixelsByType.eye;
    const drawPixels = (pixels, color) => {
        ctx.fillStyle = color;
        for (const [px, py] of pixels) {
            ctx.fillRect(x + (px * scale), y + (py * scale), scale, scale);
        }
    };

    drawPixels(icon.a, icon.color1);
    drawPixels(icon.b, icon.color2);
    drawPixels(icon.c, icon.color3);
}

async function loadImageFromUrl(url) {
    if (!url) return null;
    try {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 12000,
            maxContentLength: 8 * 1024 * 1024,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        return await loadImage(Buffer.from(res.data));
    } catch {
        return null;
    }
}

function drawAvatar(ctx, x, y, size, avatar, letter) {
    ctx.save();
    roundedRect(ctx, x, y, size, size, 6);
    ctx.clip();
    ctx.fillStyle = '#1a1208';
    ctx.fillRect(x, y, size, size);
    if (avatar) {
        const ratio = Math.max(size / avatar.width, size / avatar.height);
        const drawW = avatar.width * ratio;
        const drawH = avatar.height * ratio;
        ctx.drawImage(avatar, x + (size - drawW) / 2, y + (size - drawH) / 2, drawW, drawH);
    } else {
        ctx.fillStyle = '#2a1b0b';
        ctx.fillRect(x, y, size, size);
        drawText(ctx, letter, x + size / 2, y + size / 2 + 16, '700 44px serif', '#f0c040', 'center');
    }
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = '#8B6914';
    ctx.lineWidth = 3;
    roundedRect(ctx, x, y, size, size, 6);
    ctx.stroke();
    ctx.restore();
}

function drawProgressBar(ctx, x, y, w, h, pct, fill) {
    ctx.save();
    ctx.fillStyle = '#1a1208';
    ctx.strokeStyle = '#2a1f08';
    ctx.lineWidth = 2;
    roundedRect(ctx, x, y, w, h, 3);
    ctx.fill();
    ctx.stroke();
    const inner = Math.max(0, Math.min(1, Number(pct || 0)));
    if (inner > 0) {
        ctx.fillStyle = fill;
        roundedRect(ctx, x + 2, y + 2, Math.max(8, (w - 4) * inner), h - 4, 2);
        ctx.fill();
    }
    ctx.restore();
}

function drawBadge(ctx, text, x, y, active = false) {
    ctx.save();
    ctx.font = 'italic 18px serif';
    const width = ctx.measureText(text).width + 28;
    ctx.fillStyle = '#110e06';
    ctx.strokeStyle = active ? '#5a3e10' : '#3a2808';
    ctx.lineWidth = 2;
    roundedRect(ctx, x, y, width, 34, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = active ? '#c9950c' : '#8B6914';
    ctx.fillText(text, x + 14, y + 23);
    ctx.restore();
    return width;
}

function clampStat(value) {
    return Math.max(15, Math.min(150, Math.round(value)));
}

function percentLabel(value) {
    return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

async function generateSkillCard(data = {}) {
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    const avatar = await loadImageFromUrl(data.avatarUrl);

    ctx.fillStyle = '#0d0a07';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const grad = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
    grad.addColorStop(0, 'rgba(201,149,12,0.12)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(127,119,221,0.10)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const cardX = 60;
    const cardY = 60;
    const cardW = WIDTH - 120;
    const cardH = HEIGHT - 120;

    ctx.save();
    ctx.fillStyle = '#0d0a07';
    ctx.strokeStyle = '#8B6914';
    ctx.lineWidth = 4;
    roundedRect(ctx, cardX, cardY, cardW, cardH, 8);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    drawCorner(ctx, cardX + 12, cardY + 12, cardW - 24, cardH - 24, 'tl');
    drawCorner(ctx, cardX + 12, cardY + 12, cardW - 24, cardH - 24, 'tr');
    drawCorner(ctx, cardX + 12, cardY + 12, cardW - 24, cardH - 24, 'bl');
    drawCorner(ctx, cardX + 12, cardY + 12, cardW - 24, cardH - 24, 'br');

    drawAvatar(ctx, cardX + 36, cardY + 36, 120, avatar, safeText(data.name, 'U').charAt(0).toUpperCase());
    drawText(ctx, safeText(data.name, 'Unknown Adventurer'), cardX + 182, cardY + 78, '700 42px serif', '#f0c040');
    drawText(ctx, safeText(data.className, 'Rogue System User'), cardX + 182, cardY + 115, 'italic 24px serif', '#a07830');

    ctx.save();
    ctx.fillStyle = '#1a1208';
    ctx.strokeStyle = '#5a3e10';
    ctx.lineWidth = 2;
    roundedRect(ctx, cardX + 182, cardY + 136, 136, 42, 4);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    drawText(ctx, 'LV', cardX + 206, cardY + 165, '700 18px monospace', '#7a5820');
    drawText(ctx, String(data.level || 0), cardX + 260, cardY + 165, '700 22px monospace', '#f0c040');

    const statTop = cardY + 212;
    const statW = 176;
    const statGap = 18;
    const stats = data.stats || [];
    stats.forEach((stat, index) => {
        const x = cardX + 36 + (index * (statW + statGap));
        ctx.save();
        ctx.fillStyle = '#110e06';
        ctx.strokeStyle = '#3a2808';
        ctx.lineWidth = 2;
        roundedRect(ctx, x, statTop, statW, 92, 4);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        drawText(ctx, String(stat.value), x + (statW / 2), statTop + 44, '700 28px monospace', '#f0c040', 'center');
        drawText(ctx, stat.key, x + (statW / 2), statTop + 72, '400 18px serif', '#6a4818', 'center');
    });

    ctx.save();
    ctx.fillStyle = '#3a2808';
    ctx.fillRect(cardX + 36, cardY + 332, cardW - 72, 2);
    ctx.fillStyle = '#8B6914';
    ctx.beginPath();
    ctx.arc(cardX + cardW / 2, cardY + 333, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    drawText(ctx, 'ACTIVE SKILLS', cardX + 36, cardY + 382, '700 18px serif', '#8B6914');

    const skills = data.skills || [];
    skills.forEach((skill, index) => {
        const top = cardY + 414 + (index * 108);
        ctx.save();
        ctx.fillStyle = '#0f0c06';
        ctx.strokeStyle = '#2a1f08';
        ctx.lineWidth = 2;
        roundedRect(ctx, cardX + 36, top, cardW - 72, 82, 4);
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.fillStyle = '#0d0a07';
        ctx.strokeStyle = '#3a2808';
        ctx.lineWidth = 2;
        roundedRect(ctx, cardX + 50, top + 14, 54, 54, 4);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        drawPixelIcon(ctx, skill.iconType, cardX + 62, top + 24, 5);

        drawText(ctx, skill.name, cardX + 126, top + 34, '400 26px serif', '#d4aa50');

        ctx.save();
        ctx.fillStyle = '#1a1208';
        ctx.strokeStyle = skill.rankColor;
        ctx.lineWidth = 2;
        roundedRect(ctx, cardX + cardW - 126, top + 16, 52, 28, 3);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        drawText(ctx, skill.rank, cardX + cardW - 100, top + 37, '700 15px monospace', skill.rankColor, 'center');

        drawProgressBar(ctx, cardX + 126, top + 50, cardW - 230, 16, skill.pct / 100, skill.color);
        drawText(ctx, percentLabel(skill.pct), cardX + cardW - 78, top + 64, '700 14px monospace', '#8B6914', 'center');
    });

    drawText(ctx, 'EXPERIENCE', cardX + 36, cardY + 970, '400 22px serif', '#6a4818');
    drawText(ctx, safeText(data.xpText, '0 / 0 XP'), cardX + cardW - 36, cardY + 970, '700 18px monospace', '#8B6914', 'right');
    drawProgressBar(ctx, cardX + 36, cardY + 990, cardW - 72, 24, data.xpPct || 0, '#c9950c');

    let badgeX = cardX + 36;
    const badgeY = cardY + 1046;
    (data.badges || []).forEach((badge, index) => {
        badgeX += drawBadge(ctx, badge, badgeX, badgeY, index < 2) + 12;
        if (badgeX > cardX + cardW - 180) badgeX = cardX + 36;
    });

    return canvas.toBuffer('image/png');
}

module.exports = {
    generateSkillCard,
    clampStat
};
