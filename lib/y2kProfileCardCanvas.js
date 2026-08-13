const path = require('path');
const axios = require('axios');
const { createCanvas, loadImage, registerFont } = require('canvas');

const SIZE = 1024;
const PANEL_X = 212;
const PANEL_Y = 212;
const PANEL_W = 600;
const PANEL_H = 600;

const THEMES = {
    blue: {
        primary: '#22d3ee',
        secondary: '#67e8f9',
        accent: '#0891b2',
        darkAccent: '#06b6d4',
        glow: 'rgba(34, 211, 238, 0.5)',
        panelText: '#ffffff',
        panelStroke: '#ffffff',
        headerLine: '#ffffff',
        idText: '#ffffff',
        hashtagText: '#ffffff',
        hashtagShadow: '#000000',
        nameShadow: '#ff69b4',
        panelBorder: '#ffffff',
        subtitleColor: '#ffffff',
        xpLabelColor: '#ffffff'
    },
    pink: {
        primary: '#f472b6',
        secondary: '#f9a8d4',
        accent: '#db2777',
        darkAccent: '#ec4899',
        glow: 'rgba(244, 114, 182, 0.5)',
        panelText: '#ffffff',
        panelStroke: '#ffffff',
        headerLine: '#ffffff',
        idText: '#ffffff',
        hashtagText: '#ffffff',
        hashtagShadow: '#000000',
        nameShadow: '#db2777',
        panelBorder: '#ffffff',
        subtitleColor: '#ffffff',
        xpLabelColor: '#ffffff'
    }
};

let fontsRegistered = false;

function ensureFontsRegistered() {
    if (fontsRegistered) return;

    const fontsDir = path.join(__dirname, '..', 'fonts');
    const fontDefs = [
        {
            file: 'SFPRODISPLAYREGULAR.OTF',
            family: 'SF Pro Display',
            weight: '400',
            style: 'normal'
        },
        {
            file: 'SFPRODISPLAYBOLD.OTF',
            family: 'SF Pro Display',
            weight: '700',
            style: 'normal'
        },
        {
            file: 'segoeuithis.ttf',
            family: 'Segoe UI Historic',
            weight: '400',
            style: 'normal'
        },
        {
            file: 'segoeuithibd.ttf',
            family: 'Segoe UI Historic',
            weight: '700',
            style: 'normal'
        },
        {
            file: 'NotoSansVar.ttf',
            family: 'Noto Sans Custom',
            weight: '400',
            style: 'normal'
        }
    ];

    for (const font of fontDefs) {
        try {
            registerFont(path.join(fontsDir, font.file), {
                family: font.family,
                weight: font.weight,
                style: font.style
            });
        } catch {}
    }

    fontsRegistered = true;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function safeText(value, fallback = '') {
    const text = String(value ?? fallback).trim();
    return text || fallback;
}

function formatCompactCurrency(value) {
    const num = Number(value || 0);
    if (num >= 1000000) return `$${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `$${(num / 1000).toFixed(1)}K`;
    return `$${num.toFixed(0)}`;
}

function roundedRectPath(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
}

function circlePath(ctx, x, y, radius) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.closePath();
}

function fillRoundedRect(ctx, x, y, w, h, r, fillStyle) {
    roundedRectPath(ctx, x, y, w, h, r);
    ctx.fillStyle = fillStyle;
    ctx.fill();
}

function strokeRoundedRect(ctx, x, y, w, h, r, strokeStyle, lineWidth) {
    roundedRectPath(ctx, x, y, w, h, r);
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
}

function drawBackground(ctx) {
    const bg = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    bg.addColorStop(0, '#2d2d3a');
    bg.addColorStop(0.52, '#1f1f2e');
    bg.addColorStop(1, '#18182b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    for (let y = 0; y < SIZE; y += 16) {
        for (let x = 0; x < SIZE; x += 16) {
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    for (let y = 8; y < SIZE; y += 16) {
        for (let x = 8; x < SIZE; x += 16) {
            ctx.beginPath();
            ctx.arc(x, y, 2, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    const vignette = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 220, SIZE / 2, SIZE / 2, 720);
    vignette.addColorStop(0, 'rgba(255,255,255,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, SIZE, SIZE);
}

function drawText(ctx, {
    text,
    x,
    y,
    font,
    color = '#fff',
    align = 'left',
    baseline = 'alphabetic',
    shadowColor = 'transparent',
    shadowBlur = 0,
    shadowOffsetX = 0,
    shadowOffsetY = 0,
    strokeColor,
    strokeWidth = 0,
    maxWidth
}) {
    ctx.save();
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.shadowColor = shadowColor;
    ctx.shadowBlur = shadowBlur;
    ctx.shadowOffsetX = shadowOffsetX;
    ctx.shadowOffsetY = shadowOffsetY;
    if (strokeColor && strokeWidth > 0) {
        ctx.lineWidth = strokeWidth;
        ctx.strokeStyle = strokeColor;
        ctx.strokeText(text, x, y, maxWidth);
    }
    ctx.fillText(text, x, y, maxWidth);
    ctx.restore();
}

function fitText(ctx, text, maxWidth, baseSize, family, weight = '700') {
    let size = baseSize;
    while (size > 18) {
        ctx.font = `${weight} ${size}px "${family}", "Segoe UI Historic", Sans`;
        if (ctx.measureText(text).width <= maxWidth) return size;
        size -= 2;
    }
    return size;
}

function drawStar(ctx, cx, cy, outerRadius, innerRadius, fillStyle, strokeStyle, lineWidth) {
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < 10; i += 1) {
        const angle = (-Math.PI / 2) + (i * Math.PI / 5);
        const radius = i % 2 === 0 ? outerRadius : innerRadius;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
    if (strokeStyle && lineWidth > 0) {
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
    }
    ctx.restore();
}

function drawHeart(ctx, cx, cy, size, fillStyle, strokeStyle, lineWidth) {
    const topCurveHeight = size * 0.3;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy + size * 0.32);
    ctx.bezierCurveTo(
        cx - size * 0.5, cy - topCurveHeight,
        cx - size, cy + size * 0.48,
        cx, cy + size
    );
    ctx.bezierCurveTo(
        cx + size, cy + size * 0.48,
        cx + size * 0.5, cy - topCurveHeight,
        cx, cy + size * 0.32
    );
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
    if (strokeStyle && lineWidth > 0) {
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = strokeStyle;
        ctx.stroke();
    }
    ctx.restore();
}

function drawWindowControls(ctx, x, y, gap, radius) {
    const controls = ['#ef4444', '#facc15', '#22c55e'];
    controls.forEach((color, index) => {
        circlePath(ctx, x + (index * gap), y, radius);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#000000';
        ctx.stroke();
    });
}

function drawSpeechBubble(ctx, x, y, w, h, text) {
    const grad = ctx.createLinearGradient(x, y, x + w, y + h);
    grad.addColorStop(0, '#ff69b4');
    grad.addColorStop(1, '#ff1493');

    ctx.save();
    ctx.shadowColor = 'rgba(255, 105, 180, 0.5)';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetY = 8;
    fillRoundedRect(ctx, x, y, w, h, 28, grad);
    ctx.restore();

    fillRoundedRect(ctx, x, y, w, h, 28, grad);
    strokeRoundedRect(ctx, x, y, w, h, 28, '#ffffff', 4);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + 24, y + h);
    ctx.lineTo(x + 46, y + h);
    ctx.lineTo(x + 34, y + h + 16);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 27, y + h);
    ctx.lineTo(x + 43, y + h);
    ctx.lineTo(x + 35, y + h + 12);
    ctx.closePath();
    ctx.fillStyle = '#ff1493';
    ctx.fill();
    ctx.restore();

    drawText(ctx, {
        text: String(text),
        x: x + w / 2,
        y: y + h / 2 + 14,
        font: '900 44px "SF Pro Display", "Segoe UI Historic", Sans',
        color: '#ffffff',
        align: 'center',
        baseline: 'middle',
        shadowColor: '#000000',
        shadowOffsetX: 3,
        shadowOffsetY: 3
    });
}

function drawIdWindow(ctx, userId, theme) {
    const x = 744;
    const y = 32;
    const w = 248;
    const h = 98;

    ctx.save();
    roundedRectPath(ctx, x, y, w, h, 22);
    ctx.clip();
    ctx.fillStyle = theme.primary;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, w, 36);
    ctx.restore();

    strokeRoundedRect(ctx, x, y, w, h, 22, '#ffffff', 4);

    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000000';
    ctx.beginPath();
    ctx.moveTo(x, y + 36);
    ctx.lineTo(x + w, y + 36);
    ctx.stroke();

    drawText(ctx, {
        text: `@${String(userId).replace('#', '')}`,
        x: x + 16,
        y: y + 22,
        font: '700 14px "SF Pro Display", Sans',
        color: theme.accent,
        baseline: 'middle'
    });

    circlePath(ctx, x + w - 62, y + 18, 6);
    ctx.fillStyle = theme.darkAccent;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#000000';
    ctx.stroke();

    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000000';
    ctx.beginPath();
    ctx.moveTo(x + w - 42, y + 18);
    ctx.lineTo(x + w - 30, y + 18);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + w - 18, y + 12);
    ctx.lineTo(x + w - 8, y + 24);
    ctx.moveTo(x + w - 8, y + 12);
    ctx.lineTo(x + w - 18, y + 24);
    ctx.stroke();

    drawText(ctx, {
        text: `ID: ${userId}`,
        x: x + 124,
        y: y + 69,
        font: '900 24px "SF Pro Display", Sans',
        color: theme.idText,
        align: 'center',
        baseline: 'middle',
        shadowColor: '#000000',
        shadowOffsetX: 2,
        shadowOffsetY: 2
    });
}

function drawPanel(ctx, theme) {
    roundedRectPath(ctx, PANEL_X, PANEL_Y + 8, PANEL_W, PANEL_H, 32);
    ctx.fillStyle = '#000000';
    ctx.fill();

    ctx.save();
    ctx.shadowColor = theme.glow;
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 12;
    const panelGlow = ctx.createLinearGradient(PANEL_X, PANEL_Y, PANEL_X + PANEL_W, PANEL_Y + PANEL_H);
    panelGlow.addColorStop(0, theme.secondary);
    panelGlow.addColorStop(1, theme.primary);
    fillRoundedRect(ctx, PANEL_X, PANEL_Y, PANEL_W, PANEL_H, 32, panelGlow);
    ctx.restore();

    const panelGrad = ctx.createLinearGradient(PANEL_X, PANEL_Y, PANEL_X + PANEL_W, PANEL_Y + PANEL_H);
    panelGrad.addColorStop(0, theme.secondary);
    panelGrad.addColorStop(1, theme.primary);
    fillRoundedRect(ctx, PANEL_X, PANEL_Y, PANEL_W, PANEL_H, 32, panelGrad);
    strokeRoundedRect(ctx, PANEL_X, PANEL_Y, PANEL_W, PANEL_H, 32, theme.panelBorder, 6);
}

function drawPanelHeader(ctx, theme) {
    const y = PANEL_Y + 30;
    drawWindowControls(ctx, PANEL_X + 34, y, 24, 8);

    drawText(ctx, {
        text: 'PLAYER_PROFILE.exe',
        x: PANEL_X + PANEL_W - 22,
        y,
        font: '700 13px "SF Pro Display", Sans',
        color: theme.panelText,
        align: 'right',
        baseline: 'middle'
    });

    ctx.lineWidth = 4;
    ctx.strokeStyle = theme.headerLine;
    ctx.beginPath();
    ctx.moveTo(PANEL_X + 24, PANEL_Y + 56);
    ctx.lineTo(PANEL_X + PANEL_W - 24, PANEL_Y + 56);
    ctx.stroke();
}

async function loadAvatarImage(avatarUrl) {
    if (!avatarUrl) return null;

    try {
        const response = await axios.get(avatarUrl, {
            responseType: 'arraybuffer',
            timeout: 12000,
            maxContentLength: 8 * 1024 * 1024,
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });
        return await loadImage(Buffer.from(response.data));
    } catch {
        return null;
    }
}

function drawAvatarFallback(ctx, x, y, size, username) {
    const grad = ctx.createLinearGradient(x, y, x + size, y + size);
    grad.addColorStop(0, '#6366f1');
    grad.addColorStop(1, '#9333ea');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, size, size);

    drawText(ctx, {
        text: safeText(username, 'U').charAt(0).toUpperCase(),
        x: x + size / 2,
        y: y + size / 2 + 10,
        font: '900 92px "SF Pro Display", Sans',
        color: '#ffffff',
        align: 'center',
        baseline: 'middle',
        shadowColor: '#000000',
        shadowOffsetX: 4,
        shadowOffsetY: 4
    });
}

function drawAvatarFrame(ctx, avatarImage, username) {
    const x = PANEL_X + 36;
    const y = PANEL_Y + 82;
    const size = 180;
    const cx = x + size / 2;
    const cy = y + size / 2;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 6;
    circlePath(ctx, cx, cy, 92);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    ctx.save();
    circlePath(ctx, cx, cy, 84);
    ctx.clip();
    if (avatarImage) {
        const scale = Math.max(size / avatarImage.width, size / avatarImage.height);
        const drawW = avatarImage.width * scale;
        const drawH = avatarImage.height * scale;
        const drawX = x + (size - drawW) / 2;
        const drawY = y + (size - drawH) / 2;
        ctx.drawImage(avatarImage, drawX, drawY, drawW, drawH);
    } else {
        drawAvatarFallback(ctx, x, y, size, username);
    }
    ctx.restore();

    ctx.lineWidth = 6;
    ctx.strokeStyle = '#ffffff';
    circlePath(ctx, cx, cy, 90);
    ctx.stroke();

    ctx.lineWidth = 6;
    ctx.strokeStyle = '#000000';
    circlePath(ctx, cx, cy, 92);
    ctx.stroke();

    fillRoundedRect(ctx, x + 138, y - 8, 48, 48, 10, '#ff69b4');
    strokeRoundedRect(ctx, x + 138, y - 8, 48, 48, 10, '#ffffff', 3);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000000';
    roundedRectPath(ctx, x + 138, y - 4, 48, 48, 10);
    ctx.stroke();
    drawHeart(ctx, x + 162, y + 8, 14, '#ffffff', '#000000', 3);
}

function drawUsernameBlock(ctx, data, theme) {
    const baseX = PANEL_X + 246;
    const name = safeText(data.username, 'NEON_GAMER');
    const subtitle = safeText(data.subtitle, 'Elite Player');
    const rank = safeText(data.rank, 'Diamond');
    const xpCurrent = Number(data.xpCurrent || 0);
    const xpTotal = Math.max(Number(data.xpTotal || 1), 1);
    const xpRatio = clamp(xpCurrent / xpTotal, 0, 1);

    const nameFontSize = fitText(ctx, name, 308, 52, 'SF Pro Display', '900');

    drawText(ctx, {
        text: name,
        x: baseX + 2,
        y: PANEL_Y + 132,
        font: `900 ${nameFontSize}px "SF Pro Display", "Segoe UI Historic", Sans`,
        color: '#ffffff',
        shadowColor: theme.nameShadow,
        shadowOffsetX: 4,
        shadowOffsetY: 4
    });
    drawText(ctx, {
        text: name,
        x: baseX + 4,
        y: PANEL_Y + 134,
        font: `900 ${nameFontSize}px "SF Pro Display", "Segoe UI Historic", Sans`,
        color: 'rgba(255,255,255,0)',
        strokeColor: '#000000',
        strokeWidth: 2
    });

    drawText(ctx, {
        text: subtitle,
        x: baseX,
        y: PANEL_Y + 172,
        font: '700 26px "SF Pro Display", Sans',
        color: theme.subtitleColor,
        shadowColor: '#000000',
        shadowOffsetX: 2,
        shadowOffsetY: 2
    });

    fillRoundedRect(ctx, baseX, PANEL_Y + 192, 170, 48, 24, '#fbbf24');
    strokeRoundedRect(ctx, baseX, PANEL_Y + 192, 170, 48, 24, '#ffffff', 4);
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000000';
    roundedRectPath(ctx, baseX, PANEL_Y + 196, 170, 48, 24);
    ctx.stroke();
    drawText(ctx, {
        text: rank,
        x: baseX + 85,
        y: PANEL_Y + 217,
        font: '900 24px "SF Pro Display", Sans',
        color: '#ffffff',
        align: 'center',
        baseline: 'middle',
        shadowColor: '#000000',
        shadowOffsetX: 2,
        shadowOffsetY: 2
    });

    drawText(ctx, {
        text: `${xpCurrent} XP`,
        x: baseX,
        y: PANEL_Y + 260,
        font: '700 14px "SF Pro Display", Sans',
        color: theme.xpLabelColor,
        shadowColor: '#000000',
        shadowOffsetX: 1,
        shadowOffsetY: 1
    });
    drawText(ctx, {
        text: `${xpTotal} XP`,
        x: baseX + 312,
        y: PANEL_Y + 260,
        font: '700 14px "SF Pro Display", Sans',
        color: theme.xpLabelColor,
        align: 'right',
        shadowColor: '#000000',
        shadowOffsetX: 1,
        shadowOffsetY: 1
    });

    fillRoundedRect(ctx, baseX, PANEL_Y + 268, 314, 24, 12, '#ffffff');
    strokeRoundedRect(ctx, baseX, PANEL_Y + 268, 314, 24, 12, '#000000', 3);

    const fillWidth = Math.round(314 * xpRatio);
    const xpGrad = ctx.createLinearGradient(baseX, 0, baseX + 314, 0);
    xpGrad.addColorStop(0, '#ff69b4');
    xpGrad.addColorStop(1, '#a855f7');
    if (fillWidth > 0) {
        fillRoundedRect(ctx, baseX + 2, PANEL_Y + 270, Math.min(Math.max(fillWidth - 4, 6), 310), 20, 10, xpGrad);
    }
}

function drawEconomyCard(ctx, x, y, label, value, accent) {
    fillRoundedRect(ctx, x, y, 272, 118, 18, '#ffffff');
    strokeRoundedRect(ctx, x, y, 272, 118, 18, '#000000', 4);

    drawText(ctx, {
        text: label,
        x: x + 16,
        y: y + 28,
        font: '700 15px "SF Pro Display", Sans',
        color: accent
    });

    drawText(ctx, {
        text: formatCompactCurrency(value),
        x: x + 16,
        y: y + 78,
        font: '900 42px "SF Pro Display", Sans',
        color: '#111827'
    });
}

function drawBottomInfoBar(ctx, data, theme) {
    const x = PANEL_X + 24;
    const y = PANEL_Y + 510;
    const w = PANEL_W - 48;
    const h = 66;

    fillRoundedRect(ctx, x, y, w, h, 14, '#ffffff');
    strokeRoundedRect(ctx, x, y, w, h, 14, '#000000', 4);

    const third = w / 3;
    ctx.fillStyle = '#d1d5db';
    ctx.fillRect(x + third, y + 14, 1, h - 28);
    ctx.fillRect(x + third * 2, y + 14, 1, h - 28);

    const sections = [
        { title: 'TYPE', value: safeText(data.cardType, 'PREMIUM'), color: theme.accent },
        { title: 'NETWORK', value: safeText(data.network, 'Quantum Net'), color: '#7c3aed' },
        { title: 'STATUS', value: safeText(data.status, 'Active'), color: '#16a34a' }
    ];

    sections.forEach((section, index) => {
        const cx = x + (third * index) + (third / 2);
        drawText(ctx, {
            text: section.title,
            x: cx,
            y: y + 18,
            font: '700 12px "SF Pro Display", Sans',
            color: '#6b7280',
            align: 'center',
            baseline: 'middle'
        });

        if (section.title === 'STATUS') {
            circlePath(ctx, cx - 36, y + 44, 5);
            ctx.fillStyle = '#22c55e';
            ctx.fill();
        }

        drawText(ctx, {
            text: section.value,
            x: section.title === 'STATUS' ? cx + 8 : cx,
            y: y + 44,
            font: '900 18px "SF Pro Display", Sans',
            color: section.color,
            align: 'center',
            baseline: 'middle'
        });
    });
}

function drawHashtagTag(ctx, username, theme) {
    const x = 32;
    const y = 914;
    const w = 272;
    const h = 60;
    const grad = ctx.createLinearGradient(x, y, x + w, y + h);
    grad.addColorStop(0, theme.secondary);
    grad.addColorStop(1, theme.primary);
    fillRoundedRect(ctx, x, y, w, h, 18, grad);
    strokeRoundedRect(ctx, x, y, w, h, 18, '#ffffff', 4);
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000000';
    roundedRectPath(ctx, x, y + 4, w, h, 18);
    ctx.stroke();

    const tagText = `#${safeText(username, 'neon_gamer').toLowerCase()}`;
    const fontSize = fitText(ctx, tagText, w - 24, 30, 'SF Pro Display', '900');
    drawText(ctx, {
        text: tagText,
        x: x + w / 2,
        y: y + h / 2 + 1,
        font: `900 ${fontSize}px "SF Pro Display", Sans`,
        color: theme.hashtagText,
        align: 'center',
        baseline: 'middle',
        shadowColor: theme.hashtagShadow,
        shadowOffsetX: 3,
        shadowOffsetY: 3
    });
}

function drawMediaPanel(ctx) {
    const x = 786;
    const y = 828;
    const w = 206;
    const h = 134;
    fillRoundedRect(ctx, x, y, w, h, 18, '#a78bfa');
    strokeRoundedRect(ctx, x, y, w, h, 18, '#ffffff', 4);

    fillRoundedRect(ctx, x, y, w, 28, 18, '#ffffff');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y + 14, w, 14);
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000000';
    ctx.beginPath();
    ctx.moveTo(x, y + 28);
    ctx.lineTo(x + w, y + 28);
    ctx.stroke();

    drawText(ctx, {
        text: 'Player.exe',
        x: x + 12,
        y: y + 18,
        font: '700 12px "SF Pro Display", Sans',
        color: '#7c3aed',
        baseline: 'middle'
    });

    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000000';
    ctx.beginPath();
    ctx.moveTo(x + w - 18, y + 10);
    ctx.lineTo(x + w - 8, y + 20);
    ctx.moveTo(x + w - 8, y + 10);
    ctx.lineTo(x + w - 18, y + 20);
    ctx.stroke();

    drawText(ctx, {
        text: 'NOW PLAYING',
        x: x + 16,
        y: y + 54,
        font: '700 12px "SF Pro Display", Sans',
        color: '#ffffff',
        shadowColor: '#000000',
        shadowOffsetX: 1,
        shadowOffsetY: 1
    });

    const centerY = y + 90;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 3;

    ctx.beginPath();
    ctx.moveTo(x + 52, centerY - 10);
    ctx.lineTo(x + 52, centerY + 10);
    ctx.lineTo(x + 68, centerY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillRect(x + 82, centerY - 11, 5, 22);
    ctx.strokeRect(x + 82, centerY - 11, 5, 22);
    ctx.fillRect(x + 92, centerY - 11, 5, 22);
    ctx.strokeRect(x + 92, centerY - 11, 5, 22);

    ctx.beginPath();
    ctx.moveTo(x + 114, centerY - 10);
    ctx.lineTo(x + 114, centerY + 10);
    ctx.lineTo(x + 126, centerY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 126, centerY - 10);
    ctx.lineTo(x + 126, centerY + 10);
    ctx.lineTo(x + 138, centerY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x + 156, centerY + 6);
    ctx.lineTo(x + 156, centerY - 8);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 158, centerY - 1, 8, -Math.PI / 3, Math.PI / 3);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 159, centerY - 1, 12, -Math.PI / 3, Math.PI / 3);
    ctx.stroke();
}

function drawDecorations(ctx, theme) {
    drawStar(ctx, 160, 150, 28, 14, '#ffffff', '#000000', 4);
    drawStar(ctx, 160, 150, 14, 7, '#ff69b4', '#000000', 3);

    drawStar(ctx, 898, 172, 24, 12, '#ffffff', '#000000', 4);
    drawStar(ctx, 898, 172, 12, 6, theme.secondary, '#000000', 3);

    drawStar(ctx, 954, 760, 18, 9, '#ffffff', '#000000', 4);
    drawStar(ctx, 98, 468, 20, 10, '#ffffff', '#000000', 4);
    drawStar(ctx, 98, 468, 10, 5, '#fbbf24', '#000000', 3);

    drawStar(ctx, 818, 804, 28, 14, '#fbbf24', '#ffffff', 4);

    ctx.save();
    ctx.translate(190, 786);
    ctx.rotate(-0.12);
    drawSpeechBubbleIcon(ctx, 0, 0, 42);
    ctx.restore();
}

function drawSpeechBubbleIcon(ctx, x, y, size) {
    ctx.save();
    ctx.beginPath();
    roundedRectPath(ctx, x, y, size, size * 0.76, 12);
    ctx.fillStyle = '#ff69b4';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + size * 0.22, y + size * 0.76);
    ctx.lineTo(x + size * 0.34, y + size * 0.76);
    ctx.lineTo(x + size * 0.22, y + size * 0.96);
    ctx.closePath();
    ctx.fillStyle = '#ff69b4';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000000';
    roundedRectPath(ctx, x, y + 3, size, size * 0.76, 12);
    ctx.stroke();
    ctx.restore();
}

function sanitizeData(data = {}) {
    const gender = String(data.gender || '').trim().toLowerCase() === 'female' ? 'female' : 'male';
    const requestedTheme = THEMES[data.theme] ? data.theme : '';
    const theme = requestedTheme || (gender === 'female' ? 'pink' : 'blue');
    return {
        username: safeText(data.username, 'NEON_GAMER'),
        userId: safeText(data.userId, '#847293'),
        subtitle: safeText(data.subtitle, 'Elite Player'),
        bankBalance: Number(data.bankBalance ?? 125000),
        walletBalance: Number(data.walletBalance ?? 8450),
        rank: safeText(data.rank, 'Diamond'),
        level: Number(data.level ?? 42),
        xpCurrent: Number(data.xpCurrent ?? 7850),
        xpTotal: Math.max(Number(data.xpTotal ?? 10000), 1),
        cardType: safeText(data.cardType, 'PREMIUM'),
        network: safeText(data.network, 'Quantum Net'),
        status: safeText(data.status, 'Active'),
        avatarUrl: data.avatarUrl || null,
        gender,
        theme // FIXED: gender-based profile theme
    };
}

async function generateProfileCard(data = {}) {
    ensureFontsRegistered();

    const input = sanitizeData(data);
    const theme = THEMES[input.theme];
    const avatarImage = await loadAvatarImage(input.avatarUrl);
    const canvas = createCanvas(SIZE, SIZE);
    const ctx = canvas.getContext('2d');

    drawBackground(ctx);
    drawSpeechBubble(ctx, 32, 32, 96, 76, input.level);
    drawIdWindow(ctx, input.userId, theme);
    drawDecorations(ctx, theme);
    drawPanel(ctx, theme);
    drawPanelHeader(ctx, theme);
    drawAvatarFrame(ctx, avatarImage, input.username);
    drawUsernameBlock(ctx, input, theme);
    drawEconomyCard(ctx, PANEL_X + 24, PANEL_Y + 348, 'BANK', input.bankBalance, theme.accent);
    drawEconomyCard(ctx, PANEL_X + 304, PANEL_Y + 348, 'WALLET', input.walletBalance, '#db2777');
    drawBottomInfoBar(ctx, input, theme);
    drawMediaPanel(ctx);
    drawHashtagTag(ctx, input.username, theme);

    return canvas.toBuffer('image/png');
}

module.exports = {
    generateProfileCard
};
