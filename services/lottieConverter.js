const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');

// Mock a browser environment for lottie-web
const { window } = new JSDOM('', { pretendToBeVisual: true });
global.window = window;
global.document = window.document;
global.navigator = window.navigator;
global.Node = window.Node;
global.Element = window.Element;
global.HTMLElement = window.HTMLElement;

// Import lottie-web after setting up the environment
const lottie = require('lottie-web');

/**
 * Converts a Lottie JSON file to an animated WebP buffer using JSDOM + SVG + Sharp.
 * This is a lightweight alternative to Puppeteer.
 */
async function lottieToWebp(animationData, options = {}) {
    if (typeof animationData === 'string') {
        animationData = JSON.parse(fs.readFileSync(animationData, 'utf8'));
    }

    const fps = options.fps || animationData.fr || 30;
    const width = options.width || 512;
    const height = options.height || 512;
    const maxFrames = options.maxFrames || 150;

    const tempDir = path.join(os.tmpdir(), `lottie-svg-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
        const container = window.document.createElement('div');
        container.style.width = `${width}px`;
        container.style.height = `${height}px`;

        const animation = lottie.loadAnimation({
            container: container,
            renderer: 'svg',
            loop: false,
            autoplay: false,
            animationData: animationData,
        });

        const totalFrames = Math.min(animation.totalFrames, maxFrames);
        console.log(`[Lottie] Rendering ${totalFrames} frames via SVG...`);

        for (let i = 0; i < totalFrames; i++) {
            animation.goToAndStop(i, true);
            
            // Get the SVG string
            const svgString = container.innerHTML;
            
            // Convert SVG to PNG buffer using Sharp (SVG -> PNG is very reliable in Sharp)
            const pngBuffer = await sharp(Buffer.from(svgString))
                .resize(width, height)
                .png()
                .toBuffer();
                
            const framePath = path.join(tempDir, `frame-${String(i).padStart(4, '0')}.png`);
            fs.writeFileSync(framePath, pngBuffer);
        }

        const outPath = path.join(tempDir, 'output.webp');

        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(path.join(tempDir, 'frame-%04d.png'))
                .inputOptions([`-framerate ${fps}`])
                .outputOptions([
                    '-vcodec libwebp',
                    '-lossless 0',
                    '-q:v 75',
                    '-loop 0',
                    '-preset default',
                    '-an',
                    '-vsync 0',
                    '-vf scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'
                ])
                .toFormat('webp')
                .on('error', reject)
                .on('end', resolve)
                .save(outPath);
        });

        const resultBuffer = fs.readFileSync(outPath);
        return resultBuffer;

    } finally {
        // Cleanup
        try {
            const files = fs.readdirSync(tempDir);
            for (const file of files) {
                fs.unlinkSync(path.join(tempDir, file));
            }
            fs.rmdirSync(tempDir);
        } catch (e) {
            console.error('[Lottie] Cleanup error:', e);
        }
    }
}

module.exports = { lottieToWebp };
