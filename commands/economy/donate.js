const https = require('https');
const { getBalance, transferBalanceAtomic } = require('../../lib/economy');
const { getRegisteredProfile } = require('../../lib/registrationStore');

const THUMB_URL = 'https://files.catbox.moe/6prieh.png';
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

async function getThumb() {
    if (!thumbCache) thumbCache = await fetchBuffer(THUMB_URL).catch(() => null);
    return thumbCache;
}

function mentionTag(jid) {
    const id = String(jid || '').split('@')[0].split(':')[0];
    return `@${id}`;
}

function getTargetJid(message) {
    const mentioned = message?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentioned[0]) return mentioned[0];
    const quotedParticipant = message?.message?.extendedTextMessage?.contextInfo?.participant;
    if (quotedParticipant) return quotedParticipant;
    return '';
}

function parseAmount(rawText = '') {
    const parts = String(rawText || '').trim().split(/\s+/).slice(1);
    for (const part of parts) {
        if (!part || part.startsWith('@')) continue;
        const cleaned = part.replace(/[^\d]/g, '');
        if (!cleaned) continue;
        const amount = Number(cleaned);
        if (Number.isFinite(amount) && amount > 0) return Math.floor(amount);
    }
    return 0;
}

function payload(text, thumb) {
    return {
        text,
        contextInfo: {
            externalAdReply: {
                title: 'DONATION',
                body: 'wallet transfer',
                mediaType: 1,
                mediaUrl: '',
                renderLargerThumbnail: false,
                showAdAttribution: false,
                sourceUrl: '',
                ...(thumb ? { thumbnail: thumb } : { thumbnailUrl: THUMB_URL })
            }
        }
    };
}

async function donateCommand(sock, chatId, message, senderId, rawText = '') {
    try {
        const senderProfile = getRegisteredProfile(senderId);
        if (!senderProfile) {
            await sock.sendMessage(chatId, { text: 'Register first with `.register`.' }, { quoted: message });
            return;
        }

        const targetId = getTargetJid(message);
        const amount = parseAmount(rawText);

        if (!targetId) {
            await sock.sendMessage(chatId, {
                text: 'Use `.donate 500 @user` or reply with `.donate 500`.'
            }, { quoted: message });
            return;
        }
        if (!amount) {
            await sock.sendMessage(chatId, {
                text: 'Enter a valid amount.\n> `.donate 500 @user`'
            }, { quoted: message });
            return;
        }
        if (targetId === senderId) {
            await sock.sendMessage(chatId, { text: 'You cannot donate to yourself.' }, { quoted: message });
            return;
        }

        const targetProfile = getRegisteredProfile(targetId);
        if (!targetProfile) {
            await sock.sendMessage(chatId, { text: 'That user is not registered yet.' }, { quoted: message });
            return;
        }

        const senderBalance = getBalance(senderId);
        if (senderBalance < amount) {
            await sock.sendMessage(chatId, {
                text: `You need ¥${amount.toLocaleString()}.\n> Wallet: ¥${senderBalance.toLocaleString()}`
            }, { quoted: message });
            return;
        }

        const transfer = await transferBalanceAtomic(senderId, targetId, amount, {
            force: true,
            awardXp: false,
            source: 'donate_transfer',
            category: 'transfer',
            actorJid: senderId
        });
        if (!transfer.ok) {
            await sock.sendMessage(chatId, { text: 'Transfer failed. Please try again.' }, { quoted: message });
            return;
        }

        const thumb = await getThumb();
        await sock.sendMessage(chatId, {
            ...payload([
                `💴 ¥${amount.toLocaleString()} transferred successfully`,
                '',
                `> ${mentionTag(senderId)} ➝ ${mentionTag(targetId)}`
            ].join('\n'), thumb),
            mentions: [senderId, targetId]
        }, { quoted: message });
    } catch (error) {
        console.error('[donate] error:', error.message);
        await sock.sendMessage(chatId, { text: 'Transfer failed.' }, { quoted: message });
    }
}





module.exports = {
  name: 'donate',
  async execute(ctx) {
    return donateCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null, ctx.rawText || null);
  }
};
