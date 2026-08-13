const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { createCanvas, loadImage } = require('canvas');
const sharp = require('sharp');
const { generateProfileCard } = require('./y2kProfileCardCanvas');

const OUTPUT_SIZE = 640;
const FRAME_COUNT = 30;
const FPS = 30;
const DURATION_SECONDS = FRAME_COUNT / FPS;

if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
}

function drawStar(ctx, cx, cy, outerRadius, innerRadius, fillStyle, strokeStyle, lineWidth, rotation = 0) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    ctx.beginPath();
    for (let i = 0; i < 10; i += 1) {
        const angle = (-Math.PI / 2) + (i * Math.PI / 5);
        const radius = i % 2 === 0 ? outerRadius : innerRadius;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = strokeStyle;
    ctx.stroke();
    ctx.restore();
}

function drawPulseDot(ctx, x, y, radius, phase) {
    const pulse = 1 + (Math.sin(phase * Math.PI * 2) * 0.28);
    ctx.save();
    ctx.shadowColor = 'rgba(34, 197, 94, 0.7)';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(x, y, radius * pulse, 0, Math.PI * 2);
    ctx.fillStyle = '#22c55e';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.restore();
}

function drawXpShine(ctx, phase) {
    const scale = OUTPUT_SIZE / 512;
    const barX = Math.round(248 * scale);
    const barY = Math.round(322 * scale);
    const barW = Math.round(157 * scale);
    const barH = Math.max(6, Math.round(12 * scale));
    const shineX = barX + ((barW + 40) * phase) - 20;

    ctx.save();
    ctx.beginPath();
    ctx.rect(barX, barY, barW, barH);
    ctx.clip();

    const grad = ctx.createLinearGradient(shineX - 24, 0, shineX + 24, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(shineX - 28, barY, 56, barH);
    ctx.restore();
}

function drawAnimatedOverlays(ctx, phase) {
    const scale = OUTPUT_SIZE / 512;
    const bobA = Math.sin(phase * Math.PI * 2);
    const bobB = Math.cos(phase * Math.PI * 2);
    const bobC = Math.sin(phase * Math.PI * 4);

    drawStar(ctx, 80 * scale, (75 + bobA * 7) * scale, 14 * scale, 7 * scale, '#ffffff', '#000000', Math.max(1, 2 * scale), phase * Math.PI * 2);
    drawStar(ctx, 80 * scale, (75 + bobA * 7) * scale, 7 * scale, 3.5 * scale, '#ff69b4', '#000000', Math.max(1, 1.5 * scale), -phase * Math.PI * 2);

    drawStar(ctx, 448 * scale, (86 + bobB * 7) * scale, 12 * scale, 6 * scale, '#ffffff', '#000000', Math.max(1, 2 * scale), -phase * Math.PI * 2);
    drawStar(ctx, 448 * scale, (86 + bobB * 7) * scale, 6 * scale, 3 * scale, '#67e8f9', '#000000', Math.max(1, 1.5 * scale), phase * Math.PI * 2);

    drawStar(ctx, 474 * scale, (402 + bobB * 8) * scale, 16 * scale, 8 * scale, '#fbbf24', '#ffffff', Math.max(1, 2 * scale), -phase * Math.PI * 2);
    drawStar(ctx, 98 * scale, (468 + bobC * 6) * scale, 10 * scale, 5 * scale, '#fbbf24', '#000000', Math.max(1, 1.5 * scale), phase * Math.PI);
    drawPulseDot(ctx, 427 * scale, 418 * scale, Math.max(2, 4 * scale), phase);
    drawXpShine(ctx, phase);
}

async function renderFrame(baseImage, index) {
    const phase = index / FRAME_COUNT;
    const canvas = createCanvas(OUTPUT_SIZE, OUTPUT_SIZE);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(baseImage, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    drawAnimatedOverlays(ctx, phase);
    return canvas.toBuffer('image/png');
}

function encodeFramesToMp4(framesDir, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(path.join(framesDir, 'frame-%03d.png'))
            .inputFPS(FPS)
            .outputOptions([
                '-pix_fmt yuv420p',
                '-movflags +faststart',
                '-crf 16',
                '-preset medium',
                '-profile:v high',
                `-g ${FPS}`,
                `-t ${DURATION_SECONDS.toFixed(2)}`,
                '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2'
            ])
            .videoCodec('libx264')
            .noAudio()
            .save(outputPath)
            .on('end', resolve)
            .on('error', reject);
    });
}

async function generateAnimatedProfileCard(data = {}) {
    const staticPng = await generateProfileCard(data);
    const resizedBase = await sharp(staticPng)
        .resize(OUTPUT_SIZE, OUTPUT_SIZE, { kernel: sharp.kernel.lanczos3 })
        .png()
        .toBuffer();
    const baseImage = await loadImage(resizedBase);

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-gif-'));
    const videoPath = path.join(workDir, 'profile.mp4');

    try {
        for (let index = 0; index < FRAME_COUNT; index += 1) {
            const frameBuffer = await renderFrame(baseImage, index);
            const framePath = path.join(workDir, `frame-${String(index).padStart(3, '0')}.png`);
            await fs.writeFile(framePath, frameBuffer);
        }

        await encodeFramesToMp4(workDir, videoPath);
        return await fs.readFile(videoPath);
    } finally {
        await fs.remove(workDir).catch(() => {});
    }
}

module.exports = {
    generateAnimatedProfileCard
};
