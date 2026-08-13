const https = require('https');
const { getSosRelayChatId, setSosRelayChatId } = require('../../lib/sosRelayStore');
const isOwnerOrSudo = require('../../lib/isOwner');

const SOS_IMAGE_URL = 'https://files.catbox.moe/9lmdod.png';
let thumbCache = null;

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchBuffer(res.headers.location).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function getSosThumb() {
    if (!thumbCache) thumbCache = await fetchBuffer(SOS_IMAGE_URL).catch(() => null);
    return thumbCache;
}

function getMentionTag(jid) {
    return `@${String(jid || '').split('@')[0].split(':')[0]}`;
}

function buildSosPayload(text, mentions, thumb) {
    return {
        text,
        mentions,
        contextInfo: {
            externalAdReply: {
                title: 'SOS / REPORT',
                body: 'priority review',
                mediaType: 1,
                mediaUrl: '',
                renderLargerThumbnail: false,
                showAdAttribution: false,
                sourceUrl: '',
                ...(thumb ? { thumbnail: thumb } : {})
            }
        }
    };
}

async function sosCommand(sock, chatId, message, rawText) {
    try {
        const normalized = String(rawText || '').trim();
        const reporter = message?.key?.participant || message?.key?.remoteJid || '';
        const mention = getMentionTag(reporter);
        const isSecretRoute = /^\.sososososo(?:\s|$)/i.test(normalized);
        const reason = normalized.replace(/^\.s(?:ososososo|os)\b/i, '').trim() || 'No reason provided';
        const thumb = await getSosThumb();

        if (isSecretRoute) {
            const senderId = reporter;
            const allowed = message?.key?.fromMe || await isOwnerOrSudo(senderId).catch(() => false);
            if (!allowed) {
                return;
            }
            if (!String(chatId || '').endsWith('@g.us')) {
                await sock.sendMessage(chatId, { text: 'Use this inside the target group chat.' }, { quoted: message });
                return;
            }

            setSosRelayChatId(chatId);
            await sock.sendMessage(chatId, {
                text: 'SOS relay set for this group.'
            }, { quoted: message });
            return;
        }

        const caption = [
            '*SOS / Report*',
            '',
            `*Reason:* \`${reason}\``,
            `*Reported by:* ${mention}`,
            '',
            '> *Owner/Admin will review this ASAP.*'
        ].join('\n');

        const mentions = reporter ? [reporter] : [];
        const payload = buildSosPayload(caption, mentions, thumb);

        await sock.sendMessage(chatId, payload, { quoted: message });

        const relayChatId = getSosRelayChatId();
        if (relayChatId && relayChatId !== chatId) {
            const forwarded = [
                caption,
                '',
                `*From:* \`${chatId}\``
            ].join('\n');
            await sock.sendMessage(relayChatId, buildSosPayload(forwarded, mentions, thumb));
        }
    } catch (error) {
        console.error('[sos] error:', error?.message || error);
        await sock.sendMessage(chatId, { text: 'Failed to send SOS report.' }, { quoted: message });
    }
}





module.exports = {
  name: 'sos',
  async execute(ctx) {
    return sosCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.rawText || null);
  }
};
