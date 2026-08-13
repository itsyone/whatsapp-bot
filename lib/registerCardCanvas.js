const path = require('path');
const axios = require('axios');
const { createCanvas, loadImage, registerFont } = require('canvas');

const SIZE = 1024;
const THEMES = {
    blue: {
        background: ['#0d2f3f', '#0a3a4a', '#0c2e3c', '#081e2a'],
        dot: '#56d4e8',
        blobA: [30, 180, 210],
        blobB: [255, 100, 180],
        blobC: [20, 160, 190],
        borderA: 'rgba(86,212,232,0.75)',
        borderB: 'rgba(86,212,232,0.3)',
        borderC: 'rgba(255,130,200,0.2)',
        borderD: 'rgba(255,130,200,0.5)',
        statusGlow: '#52ffaa',
        primaryTextGlow: '#56d4e8',
        secondaryGlow: '#ff80c0'
    },
    pink: {
        background: ['#3b102a', '#541436', '#40112d', '#220816'],
        dot: '#f9a8d4',
        blobA: [244, 114, 182],
        blobB: [255, 170, 210],
        blobC: [236, 72, 153],
        borderA: 'rgba(244,114,182,0.75)',
        borderB: 'rgba(244,114,182,0.3)',
        borderC: 'rgba(249,168,212,0.2)',
        borderD: 'rgba(249,168,212,0.5)',
        statusGlow: '#52ffaa',
        primaryTextGlow: '#f472b6',
        secondaryGlow: '#f9a8d4'
    }
};
let fontsRegistered = false;

function ensureFontsRegistered() {
    if (fontsRegistered) return;

    const fontsDir = path.join(__dirname, '..', 'fonts');
    const fontDefs = [
        ['SFPRODISPLAYREGULAR.OTF', 'SF Pro Display', '400'],
        ['SFPRODISPLAYBOLD.OTF', 'SF Pro Display', '700'],
        ['NotoSansVar.ttf', 'Noto Sans Custom', '400']
    ];

    for (const [file, family, weight] of fontDefs) {
        try {
            registerFont(path.join(fontsDir, file), { family, weight, style: 'normal' });
        } catch {}
    }

    fontsRegistered = true;
}

function safeText(value, fallback = '') {
    const text = String(value ?? fallback).trim();
    return text || fallback;
}

function drawRoundedRect(ctx, x, y, w, h, r) {
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

function drawStar(ctx, cx, cy, size, color, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = size * 1.5;
    ctx.font = `${size}px "Noto Sans Custom", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✦', cx, cy);
    ctx.restore();
}

function drawPixelHeart(ctx, x, y, scale = 1, color = '#ff8fc4', alpha = 1) {
    const pixels = [
        [0, 1], [1, 1], [3, 1], [4, 1],
        [0, 0], [1, 0], [2, 0], [3, 0], [4, 0],
        [1, -1], [2, -1], [3, -1],
        [2, -2]
    ];

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = scale * 3;
    for (const [dx, dy] of pixels) {
        ctx.fillRect(x + dx * scale, y + dy * scale, scale, scale);
    }
    ctx.restore();
}

function drawWaveform(ctx, cx, y, width, amplitude, segments, color, alpha, lineWidth = 1.5) {
    const waveData = [
        0.3, 0.75, 0.4, 1, 0.5, 0.85, 0.15, 0.9, 0.55, 1,
        0.35, 0.7, 0.25, 0.6, 0.18, 0.82, 0.5, 0.92, 0.3, 0.72,
        0.42, 0.58, 0.82, 0.32, 0.65, 1, 0.45, 0.72, 0.22, 0.88,
        0.5, 0.78, 0.38, 0.62, 0.9, 0.45, 0.7, 0.28, 0.55, 0.85
    ];

    const step = width / segments;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i <= segments; i += 1) {
        const px = cx - (width / 2) + (i * step);
        const idx = i % waveData.length;
        const dy = ((waveData[idx] * 2) - 1) * amplitude;
        if (i === 0) ctx.moveTo(px, y + dy);
        else ctx.lineTo(px, y + dy);
    }
    ctx.stroke();
    ctx.restore();
}

function drawText(ctx, text, x, y, font, color, options = {}) {
    ctx.save();
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = options.align || 'left';
    ctx.textBaseline = options.baseline || 'alphabetic';
    ctx.shadowColor = options.shadowColor || 'transparent';
    ctx.shadowBlur = options.shadowBlur || 0;
    ctx.shadowOffsetX = options.shadowOffsetX || 0;
    ctx.shadowOffsetY = options.shadowOffsetY || 0;
    ctx.fillText(text, x, y, options.maxWidth);
    ctx.restore();
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

function drawBlob(ctx, cx, cy, r, rVal, gVal, bVal, alpha) {
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(${rVal},${gVal},${bVal},${alpha})`);
    grad.addColorStop(1, `rgba(${rVal},${gVal},${bVal},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
}

function fitCenterText(ctx, text, maxWidth, baseSize) {
    let size = baseSize;
    while (size > 20) {
        ctx.font = `700 ${size}px "SF Pro Display", "Noto Sans Custom", sans-serif`;
        if (ctx.measureText(text).width <= maxWidth) return size;
        size -= 2;
    }
    return size;
}

async function generateRegisterCard(data = {}) {
    ensureFontsRegistered();

    const name = safeText(data.name, 'NEW USER');
    const userId = safeText(data.userId, '#000001');
    const dob = safeText(data.dob, '--/--/----');
    const age = Number(data.age || 0);
    const bio = safeText(data.bio, 'new recruit');
const network = safeText(data.network, 'WISTORIA');
    const cardType = safeText(data.cardType, 'STARTER');
    const status = safeText(data.status, 'ACTIVE');
    const avatarUrl = data.avatarUrl || null;
    const gender = String(data.gender || '').trim().toLowerCase() === 'female' ? 'female' : 'male';
    const theme = gender === 'female' ? THEMES.pink : THEMES.blue; // FIXED: register card gender theme

    const avatar = await loadImageFromUrl(avatarUrl);
    const canvas = createCanvas(SIZE, SIZE);
    const ctx = canvas.getContext('2d');

    const bg = ctx.createLinearGradient(0, 0, SIZE * 0.7, SIZE);
    bg.addColorStop(0, theme.background[0]);
    bg.addColorStop(0.4, theme.background[1]);
    bg.addColorStop(0.75, theme.background[2]);
    bg.addColorStop(1, theme.background[3]);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = theme.dot;
    for (let gx = 0; gx < SIZE; gx += 28) {
        for (let gy = 0; gy < SIZE; gy += 28) {
            ctx.beginPath();
            ctx.arc(gx, gy, 1, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.restore();

    drawBlob(ctx, SIZE * 0.12, SIZE * 0.18, 300, theme.blobA[0], theme.blobA[1], theme.blobA[2], 0.13);
    drawBlob(ctx, SIZE * 0.88, SIZE * 0.82, 260, theme.blobB[0], theme.blobB[1], theme.blobB[2], 0.09);
    drawBlob(ctx, SIZE * 0.5, SIZE * 0.5, 360, theme.blobC[0], theme.blobC[1], theme.blobC[2], 0.05);

    const CM = 36;
    const CW = SIZE - (CM * 2);
    const CH = SIZE - (CM * 2);
    const CR = 40;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 48;
    ctx.shadowOffsetY = 14;
    drawRoundedRect(ctx, CM, CM, CW, CH, CR);
    ctx.fillStyle = 'rgba(0,0,0,0.01)';
    ctx.fill();
    ctx.restore();

    ctx.save();
    drawRoundedRect(ctx, CM, CM, CW, CH, CR);
    const cardFill = ctx.createLinearGradient(CM, CM, CM, CM + CH);
    cardFill.addColorStop(0, 'rgba(255,255,255,0.09)');
    cardFill.addColorStop(0.5, 'rgba(255,255,255,0.05)');
    cardFill.addColorStop(1, 'rgba(255,255,255,0.03)');
    ctx.fillStyle = cardFill;
    ctx.fill();
    ctx.restore();

    ctx.save();
    drawRoundedRect(ctx, CM, CM, CW, CH, CR);
    const borderGrad = ctx.createLinearGradient(CM, CM, CM, CM + CH);
    borderGrad.addColorStop(0, theme.borderA);
    borderGrad.addColorStop(0.35, theme.borderB);
    borderGrad.addColorStop(0.7, theme.borderC);
    borderGrad.addColorStop(1, theme.borderD);
    ctx.strokeStyle = borderGrad;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    drawRoundedRect(ctx, CM, CM, CW, 160, CR);
    const sheen = ctx.createLinearGradient(CM, CM, CM, CM + 160);
    sheen.addColorStop(0, 'rgba(255,255,255,0.1)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.fill();
    ctx.restore();

    ctx.save();
    drawRoundedRect(ctx, CM, CM, CW, CH, CR);
    ctx.clip();
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.strokeStyle = '#56d4e8';
    ctx.lineWidth = 1;
    for (let i = -4; i < 14; i += 1) {
        ctx.beginPath();
        ctx.moveTo((SIZE * 0.6) + (i * 36), CM);
        ctx.lineTo((SIZE * 0.6) + (i * 36) + (SIZE * 0.3), CM + (SIZE * 0.3));
        ctx.stroke();
    }
    ctx.restore();
    drawWaveform(ctx, SIZE / 2, SIZE * 0.705, SIZE * 0.72, 10, 40, '#56d4e8', 0.07, 1);
    drawWaveform(ctx, SIZE / 2, SIZE * 0.715, SIZE * 0.60, 7, 36, '#ff8fc4', 0.05, 1);
    ctx.restore();

    const tlX = CM + 22;
    const tlY = CM + 22;
    ctx.save();
    drawRoundedRect(ctx, tlX, tlY, 198, 34, 17);
    ctx.fillStyle = 'rgba(86,212,232,0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(86,212,232,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    drawText(ctx, '◈  ID', tlX + 12, tlY + 17, '700 10px monospace', 'rgba(86,212,232,0.65)', {
        baseline: 'middle'
    });
    drawText(ctx, String(userId).toUpperCase(), tlX + 50, tlY + 17, '700 13px monospace', '#e0f9ff', {
        baseline: 'middle',
        shadowColor: '#56d4e8',
        shadowBlur: 8
    });

    const panelW = 230;
    const panelH = 64;
    const trX = SIZE - CM - 22 - panelW;
    const trY = CM + 22;
    ctx.save();
    drawRoundedRect(ctx, trX, trY, panelW, panelH, 18);
    const panelFill = ctx.createLinearGradient(trX, trY, trX, trY + panelH);
    panelFill.addColorStop(0, 'rgba(86,212,232,0.13)');
    panelFill.addColorStop(1, 'rgba(86,212,232,0.06)');
    ctx.fillStyle = panelFill;
    ctx.fill();
    ctx.strokeStyle = 'rgba(86,212,232,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    drawText(ctx, 'STATUS', trX + 14, trY + 19, '400 9px monospace', 'rgba(150,230,245,0.55)', {
        baseline: 'middle'
    });
    ctx.save();
    ctx.beginPath();
    ctx.arc(trX + 82, trY + 19, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#52ffaa';
    ctx.shadowColor = '#52ffaa';
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.restore();
    drawText(ctx, status.toUpperCase(), trX + 94, trY + 19, '700 13px monospace', '#a0ffd0', {
        baseline: 'middle',
        shadowColor: '#52ffaa',
        shadowBlur: 8
    });
    drawText(ctx, 'NET', trX + 14, trY + 44, '400 9px monospace', 'rgba(150,230,245,0.45)', {
        baseline: 'middle'
    });
    drawText(ctx, network.toUpperCase(), trX + 46, trY + 44, '700 11px monospace', '#b8eeff', {
        baseline: 'middle'
    });

    drawPixelHeart(ctx, tlX + 4, tlY + 58, 5, '#ff80c0', 0.95);
    drawStar(ctx, SIZE - CM - 30, CM + 108, 14, '#56d4e8', 0.75);
    drawStar(ctx, SIZE - CM - 62, CM + 128, 9, '#ffd6ea', 0.55);
    drawStar(ctx, CM + 60, CM + 115, 10, '#56d4e8', 0.5);
    drawStar(ctx, SIZE * 0.5 - 240, SIZE * 0.86, 9, '#aaeeff', 0.4);
    drawStar(ctx, SIZE * 0.5 + 225, SIZE * 0.86, 8, '#ffb8d8', 0.45);

    const avCx = SIZE / 2;
    const avCy = 355;
    const avR = 112;

    let outerHalo = ctx.createRadialGradient(avCx, avCy, avR * 0.6, avCx, avCy, avR + 70);
    outerHalo.addColorStop(0, 'rgba(50,200,230,0.3)');
    outerHalo.addColorStop(0.5, 'rgba(50,200,230,0.12)');
    outerHalo.addColorStop(1, 'rgba(50,200,230,0)');
    ctx.fillStyle = outerHalo;
    ctx.beginPath();
    ctx.arc(avCx, avCy, avR + 70, 0, Math.PI * 2);
    ctx.fill();

    const pinkHalo = ctx.createRadialGradient(avCx, avCy + 40, avR * 0.4, avCx, avCy + 40, avR + 55);
    pinkHalo.addColorStop(0, 'rgba(255,100,180,0.2)');
    pinkHalo.addColorStop(1, 'rgba(255,100,180,0)');
    ctx.fillStyle = pinkHalo;
    ctx.beginPath();
    ctx.arc(avCx, avCy + 40, avR + 55, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(avCx, avCy, avR + 30, 0, Math.PI * 2);
    ctx.setLineDash([8, 14]);
    ctx.strokeStyle = 'rgba(86,212,232,0.38)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(avCx, avCy, avR + 18, 0, Math.PI * 2);
    const ring2 = ctx.createLinearGradient(avCx - avR, avCy - avR, avCx + avR, avCy + avR);
    ring2.addColorStop(0, 'rgba(86,212,232,0.75)');
    ring2.addColorStop(0.5, 'rgba(255,130,200,0.55)');
    ring2.addColorStop(1, 'rgba(86,212,232,0.75)');
    ctx.strokeStyle = ring2;
    ctx.lineWidth = 2.2;
    ctx.shadowColor = '#56d4e8';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(avCx, avCy, avR + 7, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(86,212,232,0.5)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = '#56d4e8';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = '#56d4e8';
    ctx.shadowBlur = 8;
    [0, 90, 180, 270].forEach((deg) => {
        const rad = (deg * Math.PI) / 180;
        const tr = avR + 18;
        ctx.beginPath();
        ctx.moveTo(avCx + Math.cos(rad) * tr, avCy + Math.sin(rad) * tr);
        ctx.lineTo(avCx + Math.cos(rad) * (tr + 12), avCy + Math.sin(rad) * (tr + 12));
        ctx.stroke();
    });
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(avCx, avCy, avR, 0, Math.PI * 2);
    ctx.clip();
    if (avatar) {
        const asp = avatar.width / avatar.height;
        let sw = avR * 2;
        let sh = avR * 2;
        if (asp > 1) sw = sh * asp;
        else sh = sw / asp;
        ctx.drawImage(avatar, avCx - (sw / 2), avCy - (sh / 2), sw, sh);
    } else {
        const fb = ctx.createRadialGradient(avCx, avCy - 20, 10, avCx, avCy, avR);
        fb.addColorStop(0, '#1a6878');
        fb.addColorStop(1, '#0a3040');
        ctx.fillStyle = fb;
        ctx.beginPath();
        ctx.arc(avCx, avCy, avR, 0, Math.PI * 2);
        ctx.fill();
        drawText(ctx, name.charAt(0).toUpperCase(), avCx, avCy + 8, '700 110px "SF Pro Display", sans-serif', 'rgba(255,255,255,0.92)', {
            align: 'center',
            baseline: 'middle',
            shadowColor: '#56d4e8',
            shadowBlur: 18
        });
    }
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(avCx, avCy, avR, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.restore();

    const nameY = avCy + avR + 58;
    const nameFontSize = fitCenterText(ctx, name, 540, 56);
    drawText(ctx, name, (SIZE / 2) + 2, nameY + 3, `700 ${nameFontSize}px "SF Pro Display", sans-serif`, 'rgba(0,0,0,0.45)', {
        align: 'center'
    });
    drawText(ctx, name, SIZE / 2, nameY, `700 ${nameFontSize}px "SF Pro Display", sans-serif`, '#ffffff', {
        align: 'center',
        shadowColor: '#56d4e8',
        shadowBlur: 24
    });

    const ulY = nameY + 14;
    const ulW = 340;
    ctx.save();
    ctx.strokeStyle = '#56d4e8';
    ctx.lineWidth = 1.8;
    ctx.shadowColor = '#56d4e8';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    for (let i = 0; i <= 26; i += 1) {
        const wx = (SIZE / 2) - (ulW / 2) + (i * (ulW / 26));
        const wy = ulY + (Math.sin(i * 0.72) * 3.5);
        if (i === 0) ctx.moveTo(wx, wy);
        else ctx.lineTo(wx, wy);
    }
    ctx.stroke();
    ctx.restore();

    drawText(ctx, '✦  new recruit  ✦', SIZE / 2, nameY + 40, '400 13px monospace', 'rgba(86,212,232,0.7)', {
        align: 'center'
    });
    drawWaveform(ctx, SIZE / 2, nameY + 55, SIZE * 0.55, 9, 38, '#56d4e8', 0.22, 1.6);

    const sepY = nameY + 70;
    ctx.save();
    const sg = ctx.createLinearGradient((SIZE / 2) - 300, sepY, (SIZE / 2) + 300, sepY);
    sg.addColorStop(0, 'rgba(86,212,232,0)');
    sg.addColorStop(0.25, 'rgba(86,212,232,0.5)');
    sg.addColorStop(0.5, 'rgba(255,130,200,0.6)');
    sg.addColorStop(0.75, 'rgba(86,212,232,0.5)');
    sg.addColorStop(1, 'rgba(86,212,232,0)');
    ctx.strokeStyle = sg;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo((SIZE / 2) - 300, sepY);
    ctx.lineTo((SIZE / 2) + 300, sepY);
    ctx.stroke();
    ctx.restore();

    const infoY = sepY + 30;
    const colL = (SIZE / 2) - 210;
    const colR = (SIZE / 2) + 210;
    const infoGap = 40;
    const infoItems = [
        { label: 'DATE OF BIRTH', value: dob },
        { label: 'AGE', value: age > 0 ? String(age) : '--' },
        { label: 'BIO', value: bio.length > 24 ? `${bio.slice(0, 24)}...` : bio }
    ];

    infoItems.forEach((item, i) => {
        const iy = infoY + (i * infoGap);
        if (i % 2 === 0) {
            ctx.save();
            ctx.fillStyle = 'rgba(86,212,232,0.04)';
            drawRoundedRect(ctx, colL - 8, iy - 15, (colR - colL) + 16, 28, 6);
            ctx.fill();
            ctx.restore();
        }

        drawText(ctx, item.label, colL, iy, '400 10px monospace', 'rgba(86,212,232,0.65)', {
            baseline: 'middle'
        });

        ctx.save();
        ctx.setLineDash([2, 6]);
        ctx.strokeStyle = 'rgba(86,212,232,0.18)';
        ctx.lineWidth = 1;
        const lx = colL + (item.label.length * 6.4) + 16;
        const rx = colR - (String(item.value).length * 9) - 12;
        if (rx > lx + 10) {
            ctx.beginPath();
            ctx.moveTo(lx, iy);
            ctx.lineTo(rx, iy);
            ctx.stroke();
        }
        ctx.restore();

        const isAge = item.label === 'AGE';
        drawText(ctx, String(item.value), colR, iy, '700 15px monospace', isAge ? '#ffd6ea' : '#e8f8ff', {
            align: 'right',
            baseline: 'middle',
            shadowColor: isAge ? '#ff80c0' : '#56d4e8',
            shadowBlur: 8
        });
    });

    const stripH = 90;
    const stripY = SIZE - CM - stripH - 4;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetY = 5;
    drawRoundedRect(ctx, CM + 4, stripY, CW - 8, stripH, 26);
    ctx.fillStyle = 'rgba(0,0,0,0.01)';
    ctx.fill();
    ctx.restore();

    ctx.save();
    drawRoundedRect(ctx, CM + 4, stripY, CW - 8, stripH, 26);
    const stripFill = ctx.createLinearGradient(0, stripY, 0, stripY + stripH);
    stripFill.addColorStop(0, 'rgba(86,212,232,0.2)');
    stripFill.addColorStop(0.5, 'rgba(20,60,80,0.45)');
    stripFill.addColorStop(1, 'rgba(86,212,232,0.1)');
    ctx.fillStyle = stripFill;
    ctx.fill();
    ctx.restore();

    ctx.save();
    drawRoundedRect(ctx, CM + 4, stripY, CW - 8, stripH, 26);
    const stripBorder = ctx.createLinearGradient(CM, 0, SIZE - CM, 0);
    stripBorder.addColorStop(0, 'rgba(86,212,232,0.6)');
    stripBorder.addColorStop(0.5, 'rgba(255,130,200,0.5)');
    stripBorder.addColorStop(1, 'rgba(86,212,232,0.6)');
    ctx.strokeStyle = stripBorder;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    const stripCy = stripY + (stripH / 2);
    const scols = [CM + 60, SIZE / 2, SIZE - CM - 60];
    const stripItems = [
        { label: 'CARD', value: cardType.toUpperCase(), color: '#c8f0ff', glow: '#56d4e8', align: 'left' },
        { label: 'NETWORK', value: network.toUpperCase(), color: '#ffb8de', glow: '#ff80c0', align: 'center' },
        { label: 'SYNC', value: 'STABLE', color: '#a0ffd0', glow: '#52ffaa', align: 'right' }
    ];

    stripItems.forEach((item, i) => {
        drawText(ctx, item.label, scols[i], stripCy - 12, '400 9px monospace', 'rgba(150,220,240,0.6)', {
            align: item.align
        });
        drawText(ctx, item.value, scols[i], stripCy + 14, `700 ${i === 1 ? 17 : 16}px monospace`, item.color, {
            align: item.align,
            shadowColor: item.glow,
            shadowBlur: 14
        });
    });

    [1, 2].forEach((si) => {
        const vx = (scols[si - 1] + scols[si]) / 2;
        ctx.save();
        const vg = ctx.createLinearGradient(0, stripY + 12, 0, stripY + stripH - 12);
        vg.addColorStop(0, 'rgba(86,212,232,0)');
        vg.addColorStop(0.5, 'rgba(86,212,232,0.35)');
        vg.addColorStop(1, 'rgba(86,212,232,0)');
        ctx.strokeStyle = vg;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(vx, stripY + 12);
        ctx.lineTo(vx, stripY + stripH - 12);
        ctx.stroke();
        ctx.restore();
    });

drawText(ctx, '∞  WISTORIA SYSTEM  ·  REGISTRY LINK  ·  AUTH:OK  ∞', SIZE / 2, SIZE - CM + 16, '400 9px monospace', 'rgba(86,212,232,0.3)', {
        align: 'center'
    });

    return canvas.toBuffer('image/png');
}

module.exports = {
    generateRegisterCard
};
