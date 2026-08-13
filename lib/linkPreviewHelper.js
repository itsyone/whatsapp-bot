const { getLinkPreview } = require('link-preview-js');
const { getBaileys } = require('./baileys');

async function buildOfficialLinkPreview(sock, link, fallback = {}) {
    const info = await getLinkPreview(link, {
        followRedirects: 'follow',
        timeout: 10000,
        headers: {
            'user-agent': 'WhatsApp/2.24.0',
            'accept-language': 'en-US,en;q=0.9'
        }
    });

    const imageUrl = Array.isArray(info?.images) ? info.images[0] : null;
    const preview = {
        'canonical-url': info?.url || link,
        'matched-text': link,
        title: info?.title || fallback.title || '',
        description: info?.description || fallback.description || ''
    };

    if (!imageUrl) {
        return preview;
    }

    try {
        const { prepareWAMessageMedia } = await getBaileys();
        const uploader = sock?.waUploadToServer;
        if (typeof uploader === 'function') {
            const { imageMessage } = await prepareWAMessageMedia(
                { image: { url: imageUrl } },
                {
                    upload: uploader,
                    mediaTypeOverride: 'thumbnail-link'
                }
            );

            if (imageMessage?.jpegThumbnail) {
                preview.jpegThumbnail = Buffer.from(imageMessage.jpegThumbnail);
            }

            if (imageMessage) {
                preview.highQualityThumbnail = imageMessage; // FIXED: shared high-quality official link preview payload
            }
        }
    } catch (error) {
        console.error('[linkPreviewHelper] high-quality preview build failed:', error?.message || error);
    }

    return preview;
}

module.exports = {
    buildOfficialLinkPreview
};
