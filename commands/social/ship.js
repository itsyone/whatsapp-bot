const axios = require('axios');
const { getRegisteredProfile, resolveRegisteredJid } = require('../../lib/registrationStore');

const CUTE_LINES = [
    { title: 'ꜱʜɪᴘ ʀᴇᴘᴏʀᴛ', body: 'ᴅᴇꜱᴛɪɴʏ ᴄᴀʟʟᴇᴅ 🌸' },
    { title: 'ꜱʜɪᴘ ʀᴇᴘᴏʀᴛ', body: 'ᴛʜᴇ ꜱᴛᴀʀꜱ ꜱᴀɪᴅ ʏᴇꜱ 🌸' },
    { title: 'ʟᴜᴄᴋʏ ꜱᴛᴀʀ', body: 'ʏᴏᴜʀ ʜᴇᴀʀᴛꜱ ᴀʟɪɢɴᴇᴅ 🌸' },
    { title: 'ꜱʜɪᴘ ʀᴇᴘᴏʀᴛ', body: 'ꜱᴏꜰᴛ ᴠɪʙᴇꜱ ᴏɴʟʏ 🌸' },
    { title: 'ʟᴜᴄᴋʏ ꜱᴛᴀʀ', body: 'ʙʟᴜꜱʜ ᴡᴀʀɴɪɴɢ 💔' },
    { title: 'ꜱʜɪᴘ ʀᴇᴘᴏʀᴛ', body: 'ᴄᴜᴛᴇ ᴀʟᴇʀᴛ ᴅᴇᴛᴇᴄᴛᴇᴅ 💔' },
    { title: 'ʟᴜᴄᴋʏ ꜱᴛᴀʀ', body: 'ʜᴇᴀʀᴛ ɢᴏ ʙʀʀ 💔' },
    { title: 'ꜱʜɪᴘ ʀᴇᴘᴏʀᴛ', body: 'ꜰᴀᴛᴇ ᴡᴇɴᴛ ʙʀʀʀ 💔' },
    { title: 'ʟᴜᴄᴋʏ ꜱᴛᴀʀ', body: 'ʜᴜɢ ᴛʜɪꜱ ꜱʜɪᴘ 🫂' },
    { title: 'ꜱʜɪᴘ ʀᴇᴘᴏʀᴛ', body: 'ᴏʜ ᴛʜᴇʏ ᴛᴏᴛᴀʟʟʏ ꜰɪᴛ 🫂' },
    { title: 'ʟᴜᴄᴋʏ ꜱᴛᴀʀ', body: 'ɪᴛꜱ ɢɪᴠɪɴɢ ꜱᴏᴜʟᴍᴀᴛᴇꜱ 🫂' },
    { title: 'ꜱʜɪᴘ ʀᴇᴘᴏʀᴛ', body: 'ᴡᴀʀᴍᴇꜱᴛ ꜱʜɪᴘ ᴇᴠᴇʀ 🫂' },
    { title: 'ʟᴜᴄᴋʏ ꜱᴛᴀʀ', body: 'ᴘɪɴᴋ ꜰʟᴀɢꜱ ᴏɴʟʏ 🩷' },
    { title: 'ꜱʜɪᴘ ʀᴇᴘᴏʀᴛ', body: 'ᴄᴏʀᴇ ᴍᴇᴍᴏʀʏ ᴜɴʟᴏᴄᴋᴇᴅ 🩷' },
    { title: 'ʟᴜᴄᴋʏ ꜱᴛᴀʀ', body: 'ꜱᴏ ᴄᴜᴛᴇ ɪᴛꜱ ᴄʀɪᴍɪɴᴀʟ 🩷' },
    { title: 'ꜱʜɪᴘ ʀᴇᴘᴏʀᴛ', body: 'ʟᴏᴠᴇ ɪꜱ ʀᴇᴀʟ 🩷' }
];

const MYSTERY_DIVIDERS = [
    '·:·.·:·.·:·.·:·.·:·',
    '━ ✦ ━━━━ ✦ ━',
    '~ ♡ ~·~ ♡ ~',
    '· · · ♡ · · ·',
    '╌╌╌ ❀ ╌╌╌',
    '· ˚ · . · ˚ ·'
];

function shipNames(n1, n2) {
    if (!n1 || !n2) return null;
    const a = String(n1).replace(/\s+/g, '');
    const b = String(n2).replace(/\s+/g, '');
    if (/^\d+$/.test(a) || /^\d+$/.test(b)) return null;
    return a.slice(0, Math.ceil(a.length / 2)) + b.slice(Math.floor(b.length / 2));
}

function makeBar(score) {
    const capped = Math.min(score, 100);
    const filled = Math.round(capped / 10);
    return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

function getVerdict(score) {
    if (score === 9999) return "_The simulation glitched and now you're soulmates_ 💥";
    if (score >= 90) return '_Written in the stars fr_ 💘';
    if (score >= 70) return '_Pretty good ngl, shoot your shot_ 🏹';
    if (score >= 50) return '_Could work with some effort_ 🤞';
    if (score >= 30) return '_Bestie behavior only_ 💀';
    return '_The universe said nah_ 🚫';
}

function getThumb(score) {
    if (score === 9999) return 'https://files.catbox.moe/7divys.jpg';
    if (score >= 70) return 'https://files.catbox.moe/7divys.jpg';
    if (score >= 50) return 'https://files.catbox.moe/nzlmi1.jpg';
    if (score >= 30) return 'https://files.catbox.moe/kp0z6u.png';
    return 'https://files.catbox.moe/e655v8.png';
}

function randomCuteLine() {
    return CUTE_LINES[Math.floor(Math.random() * CUTE_LINES.length)];
}

function randomDivider() {
    return MYSTERY_DIVIDERS[Math.floor(Math.random() * MYSTERY_DIVIDERS.length)];
}

function isJustNumber(value) {
    return /^\d+$/.test(String(value || '').trim());
}

function getContextInfo(msg) {
    return (
        msg?.message?.extendedTextMessage?.contextInfo ||
        msg?.message?.imageMessage?.contextInfo ||
        msg?.message?.videoMessage?.contextInfo ||
        {}
    );
}

async function getDisplayName(sock, jid, chatId) {
    // 1. Try registered profile name first
    const resolvedJid = resolveRegisteredJid([jid]) || jid;
    const profile = getRegisteredProfile(resolvedJid);
    if (profile?.name) return profile.name;

    // 2. Try group metadata notify name
    if (chatId && chatId.endsWith('@g.us')) {
        try {
            const meta = await sock.groupMetadata(chatId);
            const num = String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
            const participant = meta?.participants?.find(p => {
                const candidates = [p.id, p.jid, p.lid].map(v => String(v || '').split('@')[0].split(':')[0].replace(/\D/g, ''));
                return candidates.includes(num);
            });
            const name = participant?.notify || participant?.name;
            if (name) return name;
        } catch {}
    }

    // 3. Fallback to sock.getName
    const num = String(jid || '').split('@')[0].split(':')[0];
    try {
        const name = await sock.getName(jid);
        if (name && name !== num) return name;
    } catch {}

    return num;
}

function normalizeForCompare(jid) {
    return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function pickTargets(msg, participants, sender) {
    const contextInfo = getContextInfo(msg);
    let mentioned = Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid.filter(Boolean) : [];
    const replied = contextInfo?.participant || contextInfo?.remoteJid || '';
    const senderNum = normalizeForCompare(sender);
    
    // Filter out self-mentions (WhatsApp sometimes auto-injects sender)
    mentioned = mentioned.filter(jid => normalizeForCompare(jid) !== senderNum);

    if (mentioned.length >= 2) return [mentioned[0], mentioned[1]];
    if (mentioned.length === 1) return [sender, mentioned[0]];
    if (replied && normalizeForCompare(replied) !== senderNum && !replied.endsWith('@g.us')) return [sender, replied];
    if (participants.length < 2) return [null, null];
    const others = participants.filter(p => normalizeForCompare(p.id) !== senderNum);
    if (others.length === 0) return [null, null];
    const randomOther = others[Math.floor(Math.random() * others.length)];
    return [sender, randomOther.id];
}

async function shipCommand(sock, chatId, msg) {
    try {
        const sender = msg?.key?.participant || msg?.key?.remoteJid || '';
        let participants = [];
        const isGroup = chatId.endsWith('@g.us');
        
        if (isGroup) {
            const meta = await sock.groupMetadata(chatId);
            participants = Array.isArray(meta?.participants) ? meta.participants : [];
        } else {
            participants = [{ id: chatId }, { id: sender }];
        }

        const [first, second] = pickTargets(msg, participants, sender);
        if (!first || !second || normalizeForCompare(first) === normalizeForCompare(second)) {
            await sock.sendMessage(chatId, { text: '❌ I need two different people for ship.' }, { quoted: msg });
            return;
        }

        const score = Math.random() < 0.2 ? 9999 : Math.floor(Math.random() * 101);
        const verdict = getVerdict(score);
        const thumbUrl = getThumb(score);
        const scoreDisplay = score === 9999 ? '9999%' : `${score}%`;
        const cuteLine = randomCuteLine();

        const bar = makeBar(score);
        const vibeLine = score === 9999
            ? '*Vibe —* reality.exe crashed'
            : score >= 70
                ? '*Vibe —* dangerously cute'
                : score >= 40
                    ? '*Vibe —* mixed signals but possible'
                    : '*Vibe —* emotional damage';

        const text = `*[ � SHIP ]*\n\n✦ @${first.split('@')[0]}  ×  @${second.split('@')[0]} ✦\n\n*Compatibility:* ${scoreDisplay}\n${bar}\n\n${vibeLine}\n*Verdict:* ${verdict}`;

        let thumbnail = null;
        try {
            const { data } = await axios.get(thumbUrl, { 
                responseType: 'arraybuffer',
                timeout: 5000 
            });
            thumbnail = Buffer.from(data);
        } catch (thumbErr) {
            console.error('Ship thumbnail fetch failed:', thumbErr.message);
        }

        await sock.sendMessage(chatId, {
            text,
            mentions: [first, second],
            contextInfo: {
                externalAdReply: {
                    title: cuteLine.title,
                    body: cuteLine.body,
                    thumbnail,
                    mediaType: 1,
                    mediaUrl: '',
                    sourceUrl: '',
                    showAdAttribution: false,
                    renderLargerThumbnail: false
                }
            }
        }, { quoted: msg });
    } catch (error) {
        console.error('Ship command error:', error);
        await sock.sendMessage(chatId, { text: '❌ Ship failed! Make sure this is a group.' }, { quoted: msg });
    }
}





module.exports = {
  name: 'ship',
  async execute(ctx) {
    return shipCommand(ctx.sock || null, ctx.chatId || null, ctx.message || ctx.msg || null);
  }
};
