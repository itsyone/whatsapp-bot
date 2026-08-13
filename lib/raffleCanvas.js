const { createCanvas } = require('canvas');

const WIDTH = 680;
const HEIGHT = 400;

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function normalizeName(value) {
    const text = String(value || 'Player').trim().replace(/\s+/g, ' ');
    return text.slice(0, 22) || 'Player';
}

function drawBackground(ctx) {
    ctx.fillStyle = '#050d1a';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    for (let i = 0; i < 120; i++) {
        const x = Math.random() * WIDTH;
        const y = Math.random() * HEIGHT;
        const r = Math.random() * 1.5 + 0.3;
        const alpha = Math.random() * 0.8 + 0.2;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(180,210,255,${alpha})`;
        ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(540, 200, 180, 0, Math.PI * 2);
    ctx.fillStyle = '#0a1f3d';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(560, 195, 155, 0, Math.PI * 2);
    ctx.fillStyle = '#050d1a';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(490, 200, 130, 0, Math.PI * 2);
    ctx.fillStyle = '#0d2244';
    ctx.fill();
}

function drawWheel(ctx) {
    for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2;
        const x = 490 + Math.cos(angle) * 100;
        const y = 200 + Math.sin(angle) * 100;
        ctx.beginPath();
        ctx.moveTo(490, 200);
        ctx.lineTo(x, y);
        ctx.strokeStyle = 'rgba(80,140,255,0.18)';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    const rings = [
        { radius: 75, stroke: 'rgba(80,160,255,0.35)', width: 1.5 },
        { radius: 100, stroke: 'rgba(80,160,255,0.18)', width: 1 },
        { radius: 125, stroke: 'rgba(80,160,255,0.1)', width: 1 }
    ];

    for (const ring of rings) {
        ctx.beginPath();
        ctx.arc(490, 200, ring.radius, 0, Math.PI * 2);
        ctx.strokeStyle = ring.stroke;
        ctx.lineWidth = ring.width;
        ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(490, 200, 50, 0, Math.PI * 2);
    ctx.fillStyle = '#1a3a6e';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,180,255,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = 'bold 28px Georgia';
    ctx.fillStyle = '#a0c4ff';
    ctx.textAlign = 'center';
    ctx.fillText('☽', 490, 210);
}

function drawFrame(ctx) {
    ctx.beginPath();
    ctx.moveTo(40, 40);
    ctx.lineTo(WIDTH - 40, 40);
    ctx.lineTo(WIDTH - 40, HEIGHT - 40);
    ctx.lineTo(40, HEIGHT - 40);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(60,120,255,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(48, 48);
    ctx.lineTo(WIDTH - 48, 48);
    ctx.lineTo(WIDTH - 48, HEIGHT - 48);
    ctx.lineTo(48, HEIGHT - 48);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(60,120,255,0.15)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    const corners = [
        [40, 40],
        [WIDTH - 40, 40],
        [40, HEIGHT - 40],
        [WIDTH - 40, HEIGHT - 40]
    ];

    for (const [cx, cy] of corners) {
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#4a9eff';
        ctx.fill();
    }
}

function drawHeading(ctx) {
    ctx.font = '12px monospace';
    ctx.fillStyle = 'rgba(120,180,255,0.7)';
    ctx.textAlign = 'left';
    ctx.fillText('◈ ◈ ◈  C O M M U N I T Y  ◈ ◈ ◈', 70, 80);

    ctx.beginPath();
    ctx.moveTo(70, 92);
    ctx.lineTo(360, 92);
    ctx.strokeStyle = 'rgba(80,160,255,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
}

function drawInfoBlock(ctx, vars) {
    ctx.textAlign = 'left';

    ctx.font = 'bold 30px Georgia';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('RAFFLE TICKET', 70, 132);

    ctx.font = 'bold 38px monospace';
    ctx.fillStyle = '#80e8ff';
    ctx.shadowColor = 'rgba(74,240,255,0.6)';
    ctx.shadowBlur = 12;
    ctx.fillText(`#${vars.ticketNumber}`, 70, 192);
    ctx.shadowBlur = 0;

    ctx.font = '13px monospace';
    ctx.fillStyle = 'rgba(160,196,255,0.6)';
    ctx.fillText(`POT    ›  $${vars.potAmount}`, 70, 242);
    ctx.fillText(`USER   ›  ${vars.userName}`, 70, 266);

    ctx.font = '12px monospace';
    ctx.fillStyle = 'rgba(160,196,255,0.5)';
    ctx.fillText('DRAW   ›  Tonight 9PM', 70, 290);

    ctx.font = '11px monospace';
    ctx.fillStyle = 'rgba(80,120,200,0.5)';
    ctx.fillText('eclipse.community  •  powered by bot', 70, HEIGHT - 55);

    ctx.beginPath();
    ctx.moveTo(70, HEIGHT - 45);
    ctx.lineTo(360, HEIGHT - 45);
    ctx.strokeStyle = 'rgba(60,100,200,0.3)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
}

function buildRaffleMeta(options = {}) {
    return {
        ticketNumber: Number(options.ticketNumber) || randomInt(1000, 9999),
        userName: normalizeName(options.userName || options.username || 'Player'),
        potAmount: Number(options.potAmount) || Number(options.prize) || randomInt(100, 5000)
    };
}

async function generateRaffleCard(options = {}) {
    const meta = buildRaffleMeta(options);
    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    drawBackground(ctx);
    drawWheel(ctx);
    drawFrame(ctx);
    drawHeading(ctx);
    drawInfoBlock(ctx, meta);

    return {
        buffer: canvas.toBuffer('image/png'),
        ticketNumber: meta.ticketNumber,
        potAmount: meta.potAmount,
        userName: meta.userName
    };
}

module.exports = {
    generateRaffleCard,
    buildRaffleMeta
};
