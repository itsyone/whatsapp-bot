const https = require('https');

const THUMB_URL = 'https://i.ibb.co/xq6kyc5h/jpeg-optimizer-Brazilian-Miku-icon.jpg';
let thumbCache = null;

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchBuffer(res.headers.location).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function getThumb() {
    if (!thumbCache) thumbCache = await fetchBuffer(THUMB_URL).catch(() => null);
    return thumbCache;
}

function pickTargetJid(message, senderId) {
    const ctx = message?.message?.extendedTextMessage?.contextInfo || {};
    const mentioned = Array.isArray(ctx.mentionedJid) ? ctx.mentionedJid.filter(Boolean) : [];
    if (mentioned.length) return mentioned[0];
    if (ctx.participant) return String(ctx.participant);
    return senderId;
}

function percentageFromSeed(seedText) {
    void seedText;
    return Math.floor(Math.random() * 101);
}

function makeBar(percent, size = 10) {
    const filled = Math.round((percent / 100) * size);
    return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

function getVerdict(percent) {
    if (percent >= 95) return 'ʟᴇɢᴇɴᴅᴀʀʏ ʟᴇᴠᴇʟ ɴɪɢɢᴀ';
    if (percent >= 80) return '𝗜𝗖𝗢𝗡𝗜𝗖 𝗡𝗜𝗚𝗚𝗘𝗥';
    if (percent >= 60) return 'nah a bit too much, ʙᴇ ᴄᴀʀᴇꜰᴜʟ ᴡɪᴛʜ ᴛʜɪs ᴏɴᴇ ⚠️';
    if (percent >= 40) return 'balanced, ɴɪɢɢᴀ ᴏʀ ʜᴏᴍɪᴇ, ʟɪᴋᴇ ᴀ ʟɪɢʜᴛ sʜᴀᴅᴏᴡ 🌗';
    if (percent >= 20) return 'ᴀ ʟɪᴛᴛʟᴇ white, sᴛɪʟʟ ᴄᴜᴛᴇ 🌙';
    return 'sʜᴀᴅᴏᴡ ᴍᴏᴅᴇ ᴀᴄᴛɪᴠᴀᴛᴇᴅ 🖤';
}

async function whiteCommand(sock, chatId, message, senderId) {
    try {
        const target = pickTargetJid(message, senderId);
        const number = String(target).split('@')[0].split(':')[0] || 'user';
        const percent = percentageFromSeed(number);
        const bar = makeBar(percent);
        const verdict = getVerdict(percent);
        const thumb = await getThumb();

        await sock.sendMessage(chatId, {
            text:
                `╭─〔 *👨🏿 ɴɪɢɢᴀ ᴏ ᴍᴇᴛᴇʀ* 〕─╮\n` +
                `│\n` +
                `│  👤 @${number}\n` +
                `│\n` +
                `│  ᴘᴏᴡᴇʀ  : *${percent}%*\n` +
                `│  ᴍᴇᴛᴇʀ  : ${bar}\n` +
                `│\n` +
                `│  ✦ ${verdict}\n` +
                `│\n` +
                `╰────────────────╯`,
            mentions: [target].filter(Boolean),
            contextInfo: {
                externalAdReply: {
                    title: '👨🏿 ɴɪɢɢᴀ ᴏ ᴍᴇᴛᴇʀ',
                    body: `${percent}% — ${verdict}`,
                    mediaType: 1,
                    renderLargerThumbnail: false,
                    showAdAttribution: false,
                    ...(thumb ? { thumbnail: thumb } : {})
                }
            }
        }, { quoted: message });

    } catch (error) {
        console.error('Error in white command:', error);
        await sock.sendMessage(chatId, { text: '❌ ꜰᴀɪʟᴇᴅ ᴛᴏ sᴄᴀɴ ᴡʜɪᴛᴇ ᴍᴇᴛᴇʀ' }, { quoted: message });
    }
}





module.exports = {
  name: 'white',
  async execute(ctx) {
    return whiteCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null);
  }
};
