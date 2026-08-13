const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

/** Draw the cinematic red-to-black vignette */
function drawVignette(ctx, w, h) {
    const radial = ctx.createRadialGradient(w / 2, h / 2, h * 0.25, w / 2, h / 2, h * 0.85);
    radial.addColorStop(0, 'rgba(0,0,0,0)');
    radial.addColorStop(1, 'rgba(0,0,0,0.82)');
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, w, h);
}

/** Draw horizontal scan-line overlay for a TV / game feel */
function drawScanlines(ctx, w, h) {
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = '#000';
    for (let y = 0; y < h; y += 4) {
        ctx.fillRect(0, y, w, 2);
    }
    ctx.restore();
}

/** Draw a subtle red film-grain / blood-tint layer */
function drawBloodTint(ctx, w, h) {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(120,0,0,0.18)');
    grad.addColorStop(0.5, 'rgba(80,0,0,0.08)');
    grad.addColorStop(1, 'rgba(40,0,0,0.22)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
}

/** Draw chromatic-aberration ghost text (red/blue offset copies) */
function drawGhostText(ctx, text, x, y, fontSize) {
    ctx.save();
    ctx.font = `900 ${fontSize}px Impact, Arial Black, sans-serif`;
    ctx.globalAlpha = 0.35;

    // Red ghost — shift left
    ctx.fillStyle = '#ff1a1a';
    ctx.fillText(text, x - 5, y - 3);

    // Blue ghost — shift right
    ctx.fillStyle = '#1a1aff';
    ctx.fillText(text, x + 5, y + 3);

    ctx.restore();
}

/** Draw the main "WASTED" lettering with GTA-accurate styling */
function drawWastedText(ctx, w, h) {
    const text = 'WASTED';
    const fontSize = Math.round(w * 0.175);
    const x = w / 2;
    const y = h / 2 + fontSize * 0.35;

    // Chromatic aberration ghosts
    drawGhostText(ctx, text, x, y, fontSize);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `900 ${fontSize}px Impact, Arial Black, sans-serif`;

    // Deep drop shadow (3 layers for depth)
    const shadows = [
        { blur: 28, color: 'rgba(0,0,0,0.95)', ox: 0, oy: 10 },
        { blur: 14, color: 'rgba(180,0,0,0.7)', ox: 3, oy: 6 },
        { blur: 6,  color: 'rgba(255,80,80,0.4)', ox: 0, oy: 2 },
    ];
    shadows.forEach(s => {
        ctx.shadowColor   = s.color;
        ctx.shadowBlur    = s.blur;
        ctx.shadowOffsetX = s.ox;
        ctx.shadowOffsetY = s.oy;
        ctx.fillStyle     = '#d40000';
        ctx.fillText(text, x, y);
    });

    // Final crisp pass — white-red gradient fill
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur  = 0;
    const textGrad = ctx.createLinearGradient(x - 300, y - fontSize, x + 300, y);
    textGrad.addColorStop(0, '#ff6666');
    textGrad.addColorStop(0.45, '#cc0000');
    textGrad.addColorStop(1, '#880000');
    ctx.fillStyle = textGrad;
    ctx.fillText(text, x, y);

    // Thin bright highlight stroke
    ctx.strokeStyle = 'rgba(255,200,200,0.3)';
    ctx.lineWidth   = 1.5;
    ctx.strokeText(text, x, y);

    ctx.restore();
}

/** Draw "You Died" sub-text like a dark souls homage */
function drawSubText(ctx, w, h) {
    ctx.save();
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'alphabetic';
    const fontSize = Math.round(w * 0.045);
    ctx.font         = `italic 600 ${fontSize}px Georgia, serif`;
    ctx.fillStyle    = 'rgba(200,200,200,0.55)';
    ctx.shadowColor  = '#000';
    ctx.shadowBlur   = 8;
    ctx.fillText('— You Died —', w / 2, h / 2 + Math.round(w * 0.175) * 0.8);
    ctx.restore();
}

/** Draw corner timestamps / HUD details for realism */
function drawHUD(ctx, w, h, username) {
    ctx.save();
    ctx.font      = `500 ${Math.round(w * 0.028)}px monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.textAlign = 'left';
    ctx.fillText(`Player: ${username}`, 18, 26);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,80,80,0.45)';
    ctx.fillText('OFFLINE', w - 18, 26);
    ctx.restore();
}

// ──────────────────────────────────────────────
//  Core image builder
// ──────────────────────────────────────────────

async function buildWastedImage(profilePicUrl, username) {
    const W = 600, H = 600;
    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');

    // 1 — Load & draw profile picture (cover-fit)
    const avatar = await loadImage(profilePicUrl);
    const scale  = Math.max(W / avatar.width, H / avatar.height);
    const sw     = avatar.width  * scale;
    const sh     = avatar.height * scale;
    ctx.drawImage(avatar, (W - sw) / 2, (H - sh) / 2, sw, sh);

    // 2 — Desaturate slightly using a grayscale composite trick
    ctx.save();
    ctx.globalCompositeOperation = 'saturation';
    ctx.fillStyle = 'hsl(0,0%,40%)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // 3 — Cinematic layers (order matters)
    drawBloodTint(ctx, W, H);
    drawVignette(ctx, W, H);
    drawScanlines(ctx, W, H);

    // 4 — WASTED text + HUD
    drawWastedText(ctx, W, H);
    drawSubText(ctx, W, H);
    drawHUD(ctx, W, H, username);

    return canvas.toBuffer('image/jpeg', { quality: 0.93 });
}

// ──────────────────────────────────────────────
//  Command handler
// ──────────────────────────────────────────────

async function wastedCommand(sock, chatId, message) {
    let userToWaste;

    // Mentioned user
    if (message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
        userToWaste = message.message.extendedTextMessage.contextInfo.mentionedJid[0];
    }
    // Replied-to user
    else if (message.message?.extendedTextMessage?.contextInfo?.participant) {
        userToWaste = message.message.extendedTextMessage.contextInfo.participant;
    }

    if (!userToWaste) {
        await sock.sendMessage(chatId, {
            text: '💀 Mention someone or reply to their message to waste them!',
        }, { quoted: message });
        return;
    }

    try {
        // Resolve profile picture
        let profilePic;
        try {
            profilePic = await sock.profilePictureUrl(userToWaste, 'image');
        } catch {
            profilePic = 'https://i.imgur.com/2wzGhpF.jpeg';
        }

        const username   = userToWaste.split('@')[0];
        const imageBuffer = await buildWastedImage(profilePic, username);

        const captions = [
            `⚰️ *WASTED* ☠️\n\n@${username} has been eliminated.\n_Rest in pieces._`,
            `💀 *WASTED* 🩸\n\n@${username} didn't make it out alive.`,
            `🔴 *WASTED* 🔴\n\n@${username} — game over. No respawn.`,
        ];
        const caption = captions[Math.floor(Math.random() * captions.length)];

        await sock.sendMessage(chatId, {
            image: imageBuffer,
            caption,
            mentions: [userToWaste],
        }, { quoted: message });

    } catch (error) {
        console.error('Error in wasted command:', error);
        await sock.sendMessage(chatId, {
            text: '❌ Failed to generate wasted image. Try again later.',
        }, { quoted: message });
    }
}




module.exports = {
  name: 'wasted',
  async execute(ctx) {
    return wastedCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
