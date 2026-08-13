const path = require('path');
const fetch = require('node-fetch');
const { createCanvas, loadImage, registerFont } = require('canvas');

const WIDTH = 1280;
const HEIGHT = 960;

let fontsRegistered = false;

function ensureFontsRegistered() {
    if (fontsRegistered) return;

    const fontsDir = path.join(__dirname, '..', 'fonts');
    const fontDefs = [
        ['SFPRODISPLAYREGULAR.OTF', 'Retro Sans', '400'],
        ['SFPRODISPLAYBOLD.OTF', 'Retro Sans', '700'],
        ['NotoSansVar.ttf', 'Retro Mono', '400'],
        ['segoeuithibd.ttf', 'Retro UI', '700'],
        ['segoeuithis.ttf', 'Retro UI', '400']
    ];

    for (const [file, family, weight] of fontDefs) {
        try {
            registerFont(path.join(fontsDir, file), { family, weight, style: 'normal' });
        } catch {}
    }

    fontsRegistered = true;
}

function safeText(value, fallback = '') {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text || fallback;
}

function sanitizeName(name) {
    const clean = safeText(name, 'Unknown User');
    return clean.length > 24 ? `${clean.slice(0, 21)}...` : clean;
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

function withShadow(ctx, color, blur, draw) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    draw();
    ctx.restore();
}

function drawBackground(ctx) {
    const bg = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    bg.addColorStop(0, '#070611');
    bg.addColorStop(1, '#0d0b19');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const orb = ctx.createRadialGradient(WIDTH * 0.5, HEIGHT * 0.24, 0, WIDTH * 0.5, HEIGHT * 0.24, 300);
    orb.addColorStop(0, 'rgba(227,58,137,0.30)');
    orb.addColorStop(0.45, 'rgba(227,58,137,0.18)');
    orb.addColorStop(1, 'rgba(227,58,137,0)');
    ctx.fillStyle = orb;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    ctx.save();
    ctx.translate(WIDTH / 2, HEIGHT * 0.82);
    ctx.scale(1.6, 0.52);
    ctx.transform(1, 0, -0.9, 0.34, 0, 0);
    ctx.strokeStyle = 'rgba(57,197,187,0.45)';
    ctx.lineWidth = 2;
    for (let y = -10; y < 420; y += 34) {
        ctx.beginPath();
        ctx.moveTo(-560, y);
        ctx.lineTo(560, y);
        ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(227,58,137,0.28)';
    for (let x = -560; x <= 560; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, -10);
        ctx.lineTo(x, 420);
        ctx.stroke();
    }
    ctx.restore();

    for (let i = 0; i < HEIGHT; i += 4) {
        ctx.fillStyle = i % 8 === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.05)';
        ctx.fillRect(0, i, WIDTH, 2);
    }
}

function drawCassette(ctx) {
    ctx.save();
    ctx.translate(220, 190);
    ctx.rotate(-0.18);

    roundedRect(ctx, -150, -90, 300, 180, 18);
    ctx.fillStyle = '#18172a';
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#39c5bb';
    ctx.stroke();

    ctx.strokeStyle = '#e33a89';
    ctx.setLineDash([10, 6]);
    ctx.beginPath();
    ctx.moveTo(-130, -70);
    ctx.lineTo(130, -70);
    ctx.stroke();

    ctx.strokeStyle = '#39c5bb';
    ctx.setLineDash([6, 10]);
    ctx.beginPath();
    ctx.moveTo(-130, -55);
    ctx.lineTo(130, -55);
    ctx.stroke();
    ctx.setLineDash([]);

    roundedRect(ctx, -118, -42, 236, 92, 8);
    ctx.fillStyle = '#f3f3f5';
    ctx.fill();
    roundedRect(ctx, -118, -42, 236, 24, 8);
    ctx.fillStyle = '#e33a89';
    ctx.fill();

    ctx.font = '20px "Retro Mono"';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText('GOODBYE_MIX.39', 0, -24);

    roundedRect(ctx, -95, -2, 190, 42, 21);
    ctx.fillStyle = '#090812';
    ctx.fill();

    const spools = [
        { x: -55, outer: '#39c5bb' },
        { x: 55, outer: '#e33a89' }
    ];

    for (const spool of spools) {
        ctx.beginPath();
        ctx.arc(spool.x, 20, 18, 0, Math.PI * 2);
        ctx.fillStyle = '#f0f0f0';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(spool.x, 20, 12, 0, Math.PI * 2);
        ctx.fillStyle = spool.outer;
        ctx.fill();
        ctx.strokeStyle = '#161616';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(spool.x - 8, 20);
        ctx.lineTo(spool.x + 8, 20);
        ctx.moveTo(spool.x, 12);
        ctx.lineTo(spool.x, 28);
        ctx.stroke();
    }

    ctx.restore();
}

function drawErrorWindow(ctx) {
    ctx.save();
    ctx.translate(1040, 700);
    ctx.rotate(0.1);

    ctx.fillStyle = '#c7c7c7';
    ctx.fillRect(-180, -95, 320, 170);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.strokeRect(-180, -95, 320, 170);
    ctx.strokeStyle = '#454545';
    ctx.lineWidth = 4;
    ctx.strokeRect(-180, -95, 320, 170);

    const bar = ctx.createLinearGradient(-180, -95, 140, -95);
    bar.addColorStop(0, '#001f7c');
    bar.addColorStop(1, '#1290db');
    ctx.fillStyle = bar;
    ctx.fillRect(-180, -95, 320, 24);

    ctx.font = 'bold 18px "Retro Mono"';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('SYSTEM_HALT.exe', -166, -78);

    ctx.fillStyle = '#d1d1d1';
    ctx.fillRect(114, -91, 18, 18);
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 2;
    ctx.strokeRect(114, -91, 18, 18);
    ctx.beginPath();
    ctx.moveTo(118, -87);
    ctx.lineTo(128, -77);
    ctx.moveTo(128, -87);
    ctx.lineTo(118, -77);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(-125, -4, 22, 0, Math.PI * 2);
    ctx.fillStyle = '#d03747';
    ctx.fill();
    ctx.font = 'bold 24px "Retro Sans"';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText('X', -125, 5);

    ctx.textAlign = 'left';
    ctx.font = '24px "Retro UI"';
    ctx.fillStyle = '#111111';
    ctx.fillText('Warning: session ended.', -86, -6);
    ctx.font = '20px "Retro UI"';
    ctx.fillText('No recovery point found.', -86, 26);

    ctx.fillStyle = '#c9c9c9';
    ctx.fillRect(-5, 46, 78, 26);
    ctx.strokeStyle = '#4c4c4c';
    ctx.lineWidth = 2;
    ctx.strokeRect(-5, 46, 78, 26);
    ctx.fillStyle = '#111111';
    ctx.font = '18px "Retro Mono"';
    ctx.fillText('OK', 24, 64);

    ctx.restore();
}

function drawAvatarBadge(ctx, avatar, displayName) {
    ctx.save();
    ctx.translate(1060, 170);
    ctx.rotate(0.08);

    roundedRect(ctx, -125, -90, 220, 250, 8);
    ctx.fillStyle = '#17162a';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#39c5bb';
    ctx.stroke();

    ctx.fillStyle = '#39c5bb';
    ctx.fillRect(-125, -90, 220, 18);
    ctx.fillStyle = '#0d0b19';
    ctx.font = 'bold 10px "Retro Mono"';
    ctx.fillText('USER_ID.SYS', -112, -77);

    ctx.beginPath();
    ctx.arc(76, -81, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#e33a89';
    ctx.fill();

    const avatarSize = 84;
    roundedRect(ctx, -62, -48, avatarSize, avatarSize, 10);
    ctx.fillStyle = '#090812';
    ctx.fill();

    ctx.save();
    roundedRect(ctx, -62, -48, avatarSize, avatarSize, 10);
    ctx.clip();
    ctx.drawImage(avatar, -62, -48, avatarSize, avatarSize);
    ctx.restore();

    ctx.strokeStyle = '#e33a89';
    ctx.lineWidth = 3;
    roundedRect(ctx, -62, -48, avatarSize, avatarSize, 10);
    ctx.stroke();

    ctx.font = '14px "Retro Mono"';
    ctx.fillStyle = '#39c5bb';
    ctx.fillText('HANDLE:', -92, 66);

    ctx.fillStyle = '#090812';
    ctx.fillRect(-94, 74, 170, 34);
    ctx.strokeStyle = '#39c5bb';
    ctx.lineWidth = 2;
    ctx.strokeRect(-94, 74, 170, 34);

    ctx.font = '22px "Retro Mono"';
    ctx.fillStyle = '#ffffff';
    const handle = sanitizeName(displayName).toUpperCase();
    ctx.fillText(handle, -84, 98, 146);
    ctx.fillStyle = '#e33a89';
    ctx.fillRect(58, 82, 6, 18);

    for (let i = 0; i < 8; i += 1) {
        ctx.fillStyle = i % 3 === 0 ? '#e33a89' : '#39c5bb';
        ctx.fillRect(-108 + (i * 24), 130, (i % 4 === 0 ? 14 : 8), 10);
    }

    ctx.restore();
}

function wrapText(ctx, text, maxWidth) {
    const words = safeText(text).split(' ');
    const lines = [];
    let line = '';

    for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width <= maxWidth) {
            line = test;
        } else {
            if (line) lines.push(line);
            line = word;
        }
    }

    if (line) lines.push(line);
    return lines.length ? lines : [''];
}

function drawNote(ctx, displayName, groupName, memberCount) {
    const noteX = 336;
    const noteY = 188;
    const noteW = 520;
    const noteH = 540;

    ctx.save();
    ctx.translate(noteX + (noteW / 2), noteY + (noteH / 2));
    ctx.rotate(0.055);

    ctx.fillStyle = '#e33a89';
    ctx.fillRect((-noteW / 2) + 18, (-noteH / 2) + 16, noteW, noteH);

    ctx.fillStyle = '#f6f7fa';
    ctx.beginPath();
    ctx.moveTo(-noteW / 2, -noteH / 2);
    ctx.lineTo(noteW / 2, (-noteH / 2) + 10);
    ctx.lineTo((noteW / 2) - 10, (noteH / 2) - 24);
    const tear = [
        [190, 0], [170, 12], [145, -2], [120, 16], [96, 2], [72, 18], [46, 0], [20, 16],
        [-8, -2], [-34, 18], [-60, 2], [-88, 16], [-116, -1], [-144, 15], [-170, 4], [-190, 18]
    ];
    for (const [x, y] of tear) {
        ctx.lineTo(x, (noteH / 2) - y);
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(57,197,187,0.30)';
    ctx.lineWidth = 1;
    for (let y = -noteH / 2 + 70; y < noteH / 2 - 36; y += 38) {
        ctx.beginPath();
        ctx.moveTo(-noteW / 2 + 16, y);
        ctx.lineTo(noteW / 2 - 18, y);
        ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(-200, -294, 126, 26);
    ctx.save();
    ctx.rotate(-0.26);
    ctx.fillRect(-248, -300, 128, 24);
    ctx.restore();
    ctx.save();
    ctx.rotate(0.38);
    ctx.fillRect(142, -288, 102, 24);
    ctx.restore();

    withShadow(ctx, '#e33a89', 0, () => {
        ctx.fillStyle = '#111111';
        ctx.font = 'bold 64px "Retro Sans"';
        ctx.fillText('LOG OFF.', -188, -190);
        ctx.fillStyle = '#e33a89';
        ctx.fillText('LOG OFF.', -184, -190);
    });

    ctx.fillStyle = '#1b1930';
    ctx.font = '38px "Retro UI"';
    ctx.fillText('Hey...', -184, -122);
    ctx.fillText('Looks like the session is over.', -184, -72);

    ctx.font = '34px "Retro UI"';
    const bodyLines = wrapText(
        ctx,
        `${sanitizeName(displayName)} just logged off from ${safeText(groupName, 'the group')}. Thanks for stopping by the neon side.`,
        370
    );
    let y = -8;
    for (const line of bodyLines.slice(0, 4)) {
        ctx.fillText(line, -184, y);
        y += 42;
    }

    ctx.fillStyle = '#e33a89';
    ctx.font = 'bold 44px "Retro Sans"';
    ctx.fillText(`Goodbye, ${sanitizeName(displayName)}!`, -184, 206, 392);

    ctx.fillStyle = '#39c5bb';
    ctx.font = 'bold 48px "Retro Mono"';
    ctx.fillText('39', 132, 286);

    ctx.fillStyle = '#1b1930';
    ctx.font = '24px "Retro Mono"';
    ctx.fillText(`GROUP: ${safeText(groupName, 'Unknown Group').slice(0, 22)}`, -184, 278);
    ctx.fillText(`MEMBERS LEFT: ${Math.max(0, Number(memberCount || 0))}`, -184, 314);

    ctx.strokeStyle = '#e33a89';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(-160, 348);
    ctx.bezierCurveTo(-40, 320, 40, 380, 180, 340);
    ctx.stroke();

    ctx.restore();
}

function drawGlitches(ctx) {
    ctx.fillStyle = '#39c5bb';
    ctx.fillRect(0, 390, 156, 32);
    ctx.fillStyle = '#121212';
    ctx.font = 'bold 18px "Retro Mono"';
    ctx.fillText('ERR_CONNECTION', 14, 412);

    ctx.fillStyle = '#e33a89';
    ctx.fillRect(1160, 545, 84, 22);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(1234, 545, 12, 22);
    ctx.fillStyle = '#000000';
    ctx.fillRect(1204, 545, 24, 22);

    ctx.strokeStyle = '#39c5bb';
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(116, 600);
    ctx.lineTo(154, 532);
    ctx.lineTo(126, 486);
    ctx.lineTo(174, 412);
    ctx.stroke();

    ctx.strokeStyle = '#ffff00';
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(910, 744);
    ctx.lineTo(986, 814);
    ctx.moveTo(986, 744);
    ctx.lineTo(910, 814);
    ctx.stroke();
}

async function loadAvatar(avatarUrl) {
    if (!avatarUrl) return null;

    try {
        const response = await fetch(avatarUrl);
        if (!response.ok) return null;
        const buffer = await response.buffer();
        return await loadImage(buffer);
    } catch {
        return null;
    }
}

function createFallbackAvatar(displayName) {
    const avatarCanvas = createCanvas(320, 320);
    const ctx = avatarCanvas.getContext('2d');

    const gradient = ctx.createLinearGradient(0, 0, 320, 320);
    gradient.addColorStop(0, '#39c5bb');
    gradient.addColorStop(1, '#e33a89');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 320, 320);

    ctx.fillStyle = 'rgba(9,8,18,0.28)';
    ctx.beginPath();
    ctx.arc(160, 160, 124, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 120px "Retro Sans"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(sanitizeName(displayName).charAt(0).toUpperCase(), 160, 168);

    return avatarCanvas;
}

async function createGoodbyeCard({ displayName, groupName, memberCount, avatarUrl }) {
    ensureFontsRegistered();

    const safeName = sanitizeName(displayName);
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    const avatar = (await loadAvatar(avatarUrl)) || createFallbackAvatar(safeName);

    drawBackground(ctx);
    drawCassette(ctx);
    drawErrorWindow(ctx);
    drawAvatarBadge(ctx, avatar, safeName);
    drawNote(ctx, safeName, groupName, memberCount);
    drawGlitches(ctx);

    return canvas.toBuffer('image/png');
}

module.exports = {
    createGoodbyeCard
};
