const path = require('path');
const axios = require('axios');
const { createCanvas, loadImage, registerFont } = require('canvas');

const W = 512;
const H = 512;

let fontsRegistered = false;

function ensureFontsRegistered() {
    if (fontsRegistered) return;
    const fontsDir = path.join(__dirname, '..', 'fonts');
    const fontDefs = [
        { file: 'NotoSans-Regular.ttf', family: 'Noto Sans', weight: 'normal', style: 'normal' },
        { file: 'NotoSans-Regular.ttf', family: 'Noto Sans', weight: 'bold', style: 'normal' },
        { file: 'NotoSansCJKsc-Regular.otf', family: 'Noto Sans SC', weight: 'normal', style: 'normal' },
        { file: 'DejaVuSans.ttf', family: 'DejaVu Sans', weight: 'normal', style: 'normal' },
        { file: 'DejaVuSans.ttf', family: 'DejaVu Sans', weight: 'bold', style: 'normal' }
    ];

    for (const font of fontDefs) {
        try {
            const fullPath = path.join(fontsDir, font.file);
            registerFont(fullPath, {
                family: font.family,
                weight: font.weight,
                style: font.style
            });
            console.log(`[StatsCard] Registered font: ${font.family} (${font.weight}) from ${font.file}`);
        } catch (e) {
            console.error(`[StatsCard] Failed to register font ${font.file}:`, e.message);
        }
    }

    fontsRegistered = true;
}

// ── COLORS ──────────────────────────────────────────────────────────────────
const COLORS = {
    BG: '#090a0f',
    BG_GRAD: ['#090a0f', '#12141d'],
    PANEL: 'rgba(255,255,255,0.05)',
    BORD: 'rgba(255,255,255,0.18)',
    SUB: '#b0b0b8',
    WHITE: '#ffffff',
    ACCENT: '#5865F2',
    GREEN: '#32d74b',
    ROW_BG: 'rgba(255,255,255,0.04)'
};

// ── HELPERS ─────────────────────────────────────────────────────────────────
function rr(ctx, x, y, w, h, r = 24) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
}

const fr = (ctx, x, y, w, h, r, c) => { 
    ctx.save();
    if (c === COLORS.PANEL) {
        ctx.shadowColor = 'rgba(0,0,0,0.4)';
        ctx.shadowBlur = 20;
    }
    rr(ctx, x, y, w, h, r); ctx.fillStyle = c; ctx.fill(); 
    ctx.restore();
};
const sr = (ctx, x, y, w, h, r, c, lw = 1) => { rr(ctx, x, y, w, h, r); ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.stroke(); };

function t(ctx, s, x, y, c, sz, w = "400", al = "left", bl = "middle", f = "DejaVu Sans", italic = false) {
    const weight = (parseInt(w) >= 600) ? "bold" : "";
    const style = italic ? "italic" : "";
    // FONT FIX: No Color Emoji in stack. Strict unit rendering.
    ctx.font = `${style} ${weight} ${sz}px "${f}", "Noto Sans", sans-serif`;
    ctx.fillStyle = c; ctx.textAlign = al; ctx.textBaseline = bl; 
    ctx.fillText(String(s ?? ''), x, y);
}

async function loadAvatar(sock, jid) {
    if (!sock || !jid) return null;
    try {
        const url = await sock.profilePictureUrl(jid, 'image').catch(() => null);
        if (!url) return null;
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        return await loadImage(Buffer.from(response.data));
    } catch {
        return null;
    }
}

function formatDate(value) {
    const ts = Number(value || 0);
    if (!ts) return 'Not tracked';
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return 'Not tracked';
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function sanitizeText(value, fallback = 'Unknown') {
    const textValue = String(value ?? '').replace(/\s+/g, ' ').trim();
    return textValue.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim() || fallback;
}

async function generateStatsCard(data = {}) {
    ensureFontsRegistered();

    const canvas = createCanvas(W * 2, (H + 10) * 2);
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);

    // STYLE: Background Gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, COLORS.BG_GRAD[0]);
    bgGrad.addColorStop(1, COLORS.BG_GRAD[1]);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H + 10);

    // Data Mapping
    const username = sanitizeText(data.username || data.name, 'User');
    const userTag = sanitizeText(data.userTag, 'user');
    const groupName = sanitizeText(data.groupName, 'Private Chat');
    const createdOn = data.createdOn || 'N/A';
    const joinedOn = data.joinedOn || 'N/A';
    const rank = Math.max(0, Number(data.rank || 0));
    const level = Math.max(0, Number(data.level || 0));
    const tz = data.jid && data.jid.startsWith('92') ? 'PKT' : 'WIB';
    
    const stats = {
        today: String(data.msgToday || 0),
        week: String(data.msg7d || 0),
        month: String(data.msgMonth || 0),
        group: String(data.groupMessages || 0),
        global: String(data.allMessages || 0)
    };
    
    const topGroups = Array.isArray(data.topGroups) ? data.topGroups.slice(0, 2) : [];
    const chartSeries = Array.isArray(data.chartSeries) ? data.chartSeries : [0];
    const avatar = await loadAvatar(data.sock, data.jid);

    // ── HEADER ──────────────────────────────────────────────────────────────────
    const avS = 52, avX = 20, avY = 24;
    ctx.save();
    ctx.beginPath(); ctx.arc(avX + avS/2, avY + avS/2, avS/2, 0, Math.PI*2); ctx.clip();
    if (avatar) ctx.drawImage(avatar, avX, avY, avS, avS);
    else fr(ctx, avX, avY, avS, avS, 26, "#1a1d29");
    ctx.restore();

    t(ctx, username, 82, avY + 12, COLORS.WHITE, 18, "800");
    t(ctx, userTag, 82, avY + 32, COLORS.SUB, 11, "400");
    t(ctx, groupName, 82, avY + 48, COLORS.SUB, 10, "400", "left", "middle", "DejaVu Sans", true);

    // LAYOUT: Capsules top right
    const drawCapsule = (lb, val, x) => {
        const capW = 80;
        fr(ctx, x, 24, capW, 42, 12, COLORS.PANEL);
        sr(ctx, x, 24, capW, 42, 12, COLORS.BORD);
        t(ctx, lb, x + capW/2, 35, COLORS.SUB, 8, "900", "center");
        t(ctx, val.split(',')[0], x + capW/2, 51, COLORS.WHITE, 11, "800", "center");
    };
    drawCapsule("CREATED", createdOn, W - 182);
    drawCapsule("JOINED", joinedOn, W - 94);

    // ── MIDDLE PANELS (3 side by side) ──────────────────────────────────────────
    const gridY = 100, pW = 154, pH = 120, gap = 10;
    
    const drawRow = (x, y, w, lb, val) => {
        fr(ctx, x + 8, y, w - 16, 32, 10, COLORS.ROW_BG);
        t(ctx, lb, x + 16, y + 16, COLORS.WHITE, 10, "400");
        t(ctx, val, x + w - 16, y + 16, COLORS.WHITE, 11, "600", "right", "middle", "DejaVu Sans", true);
    };

    // Panel 1: Ranks
    fr(ctx, 20, gridY, pW, pH, 24, COLORS.PANEL); sr(ctx, 20, gridY, pW, pH, 24, COLORS.BORD);
    t(ctx, "Server Ranks", 34, gridY + 20, COLORS.WHITE, 11, "800");
    t(ctx, "RANK", 20 + pW - 20, gridY + 20, COLORS.SUB, 8, "900", "right");
    drawRow(20, gridY + 42, pW, "Rank", `#${rank}`);
    drawRow(20, gridY + 80, pW, "Level", String(level));

    // Panel 2: Messages
    const mX = 20 + pW + gap;
    fr(ctx, mX, gridY, pW, pH, 24, COLORS.PANEL); sr(ctx, mX, gridY, pW, pH, 24, COLORS.BORD);
    t(ctx, "Messages", mX + 14, gridY + 20, COLORS.WHITE, 11, "800");
    t(ctx, "MSGS", mX + pW - 20, gridY + 20, COLORS.SUB, 8, "900", "right");
    const mRow = (lb, val, y) => {
        fr(ctx, mX + 8, y, pW - 16, 24, 8, COLORS.ROW_BG);
        t(ctx, lb, mX + 14, y + 12, COLORS.WHITE, 9, "400");
        t(ctx, val, mX + pW - 14, y + 12, COLORS.WHITE, 10, "600", "right", "middle", "DejaVu Sans", true);
    };
    mRow("Today", stats.today, gridY + 38);
    mRow("Week", stats.week, gridY + 66);
    mRow("Month", stats.month, gridY + 94);

    // Panel 3: Info
    const iX = mX + pW + gap;
    fr(ctx, iX, gridY, pW, pH, 24, COLORS.PANEL); sr(ctx, iX, gridY, pW, pH, 24, COLORS.BORD);
    t(ctx, "Activity Info", iX + 14, gridY + 20, COLORS.WHITE, 11, "800");
    t(ctx, "INFO", iX + pW - 20, gridY + 20, COLORS.SUB, 8, "900", "right");
    drawRow(iX, gridY + 42, pW, "Group", stats.group);
    drawRow(iX, gridY + 80, pW, "Global", stats.global);

    // ── BOTTOM PANELS (Top Groups + Chart) ──────────────────────────────────────
    const botY = gridY + pH + gap, botW = 236, botH = 140;
    
    // Top Groups
    fr(ctx, 20, botY, botW, botH, 24, COLORS.PANEL); sr(ctx, 20, botY, botW, botH, 24, COLORS.BORD);
    t(ctx, "Top Groups & Chats", 34, botY + 22, COLORS.WHITE, 11, "800");
    topGroups.forEach((g, i) => {
        const y = botY + 45 + (i * 44);
        fr(ctx, 30, y, botW - 20, 38, 12, COLORS.ROW_BG);
        t(ctx, `# ${Array.from(g.name).slice(0, 15).join('')}`, 42, y + 19, COLORS.WHITE, 10, "400");
        t(ctx, String(g.count), botW, y + 19, COLORS.SUB, 10, "600", "right", "middle", "DejaVu Sans", true);
    });

    // Chart Panel
    const chX = 20 + botW + gap;
    fr(ctx, chX, botY, botW, botH, 24, COLORS.PANEL); sr(ctx, chX, botY, botW, botH, 24, COLORS.BORD);
    t(ctx, "Charts", chX + 14, botY + 22, COLORS.WHITE, 11, "800");
    fr(ctx, chX + botW - 70, botY + 18, 8, 8, 4, COLORS.GREEN);
    t(ctx, "Activity", chX + botW - 58, botY + 22, COLORS.SUB, 9, "400");

    const vals = chartSeries.length ? chartSeries.map(v => Number(v || 0)) : [0, 0, 0];
    const maxV = Math.max(...vals, 1);
    const cX = chX + 15, cY = botY + 45, cW = botW - 30, cH = botH - 60;
    
    const pts = vals.map((v, i) => ({
        x: cX + (i / Math.max(1, vals.length - 1)) * cW,
        y: cY + cH - (v / maxV) * cH
    }));

    // CHART STYLE: Bezier Curve + Glowing Green Line
    const drawCurve = (closed) => {
        ctx.beginPath();
        if (closed) ctx.moveTo(pts[0].x, cY + cH);
        ctx.lineTo(pts[0].x, pts[0].y);
        for (let i = 0; i < pts.length - 1; i++) {
            const cp1x = pts[i].x + (pts[i+1].x - pts[i].x) / 2;
            ctx.bezierCurveTo(cp1x, pts[i].y, cp1x, pts[i+1].y, pts[i+1].x, pts[i+1].y);
        }
        if (closed) {
            ctx.lineTo(pts[pts.length - 1].x, cY + cH);
            ctx.closePath();
        }
    };

    drawCurve(true);
    const grad = ctx.createLinearGradient(0, cY, 0, cY + cH);
    grad.addColorStop(0, "rgba(35,165,89,0.4)");
    grad.addColorStop(1, "rgba(35,165,89,0)");
    ctx.fillStyle = grad; ctx.fill();

    ctx.save();
    ctx.shadowBlur = 8; ctx.shadowColor = COLORS.GREEN;
    drawCurve(false);
    ctx.strokeStyle = COLORS.GREEN; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.restore();

    // ── FOOTER ──────────────────────────────────────────────────────────────────
    t(ctx, `Timezone: ${tz}`, 24, 480, COLORS.SUB, 9, "600");
    t(ctx, "Powered by Wistoria Bot", W - 24, 480, COLORS.SUB, 9, "600", "right");

    return canvas.toBuffer('image/png');
}

async function generateStatsCard2(data = {}) {
    // Keep generateStatsCard2 for backward compatibility but using the same engine
    return generateStatsCard(data);
}

module.exports = {
    generateStatsCard,
    generateStatsCard2
};
