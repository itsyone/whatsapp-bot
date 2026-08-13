const https = require('https');
const settings = require('../../settings');
const { getStaffRoles, normalizeJid } = require('../../lib/staffRoles');

const MODS_THUMB_URL = 'https://files.catbox.moe/slr8cl.png';
const STAFF_THUMB_URL = 'https://files.catbox.moe/gc9w1c.png';

const thumbCache = new Map();

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

async function getThumb(url) {
    if (!thumbCache.has(url)) {
        thumbCache.set(url, await fetchBuffer(url).catch(() => null));
    }
    return thumbCache.get(url) || null;
}

function toTag(jid) {
    return `@${String(jid).split('@')[0]}`;
}

function pushRoleSection(lines, icon, title, members, footerText) {
    if (!members.length) return;

    lines.push(`┃ ${icon} *${title}*`);
    members.forEach((member, index) => {
        const branch = index === members.length - 1 ? '┗' : '┣';
        lines.push(`┃ ${branch} ${toTag(member)}`);
    });
    if (footerText) {
        lines.push(`┃    ${footerText}`);
    }
    lines.push('┃');
}

function card(lines, thumb, mentions, title, body) {
    return {
        text: lines.join('\n'),
        mentions,
        contextInfo: {
            externalAdReply: {
                title,
                body,
                mediaType: 1,
                mediaUrl: '',
                sourceUrl: '',
                renderLargerThumbnail: false,
                showAdAttribution: false,
                ...(thumb ? { thumbnail: thumb } : {})
            }
        }
    };
}

async function staffCommand(sock, chatId, msg, view = 'staff') {
    try {
        const owner = normalizeJid(`${settings.ownerNumber}@s.whatsapp.net`);
        const roles = getStaffRoles();

        const coOwners = roles.coOwners.filter((jid) => jid !== owner);
        const mods = roles.mods.filter((jid) => jid !== owner && !coOwners.includes(jid));
        const staff = roles.staff.filter((jid) => jid !== owner && !coOwners.includes(jid) && !mods.includes(jid));

        const lines = [];
        let mentions = [];
        let thumb = null;
        let title = '';
        let body = '';

        if (view === 'mods') {
            lines.push('┃ ⚔️ *ᴍᴏᴅᴇʀᴀᴛᴏʀꜱ*');
            lines.push('┃ ━━━━━━━');

            if (mods.length > 0) {
                mods.forEach((member, index) => {
                    const branch = index === mods.length - 1 ? '┗' : '┣';
                    lines.push(`┃ ${branch} ${toTag(member)}`);
                });
                lines.push('┃');
                lines.push('┃ ✧ can remove or add people');
                lines.push('┃ ✧ can use .pm to be promoted as admin');
            } else {
                lines.push('┃ ┗ no moderators set');
            }

            lines.push('┃ ━━━━━━━');
            mentions = [...mods];
            thumb = await getThumb(MODS_THUMB_URL);
            title = 'MODERATORS';
            body = 'staff team roles';
        } else {
            lines.push('┃ 👥 *ꜱᴛᴀꜰꜰ ᴛᴇᴀᴍ*');
            lines.push('┃ ━━━━━━━');
            pushRoleSection(lines, '👑', 'ᴏᴡɴᴇʀ', owner ? [owner] : [], 'can do everything');
            if (coOwners.length > 0) {
                pushRoleSection(lines, '🛡️', 'ᴄᴏ-ᴏᴡɴᴇʀ', coOwners, 'helps manage the whole bot');
            }
            pushRoleSection(lines, '⚔️', 'ᴍᴏᴅᴇʀᴀᴛᴏʀꜱ', mods, 'can remove or add people and use .pm to be promoted as admin');
            pushRoleSection(lines, '✧', 'ꜱᴛᴀꜰꜰ', staff, 'can warn people');

            if (lines[lines.length - 1] === '┃') {
                lines.pop();
            }

            lines.push('┃ ━━━━━━━');
            mentions = [owner, ...coOwners, ...mods, ...staff].filter(Boolean);
            thumb = await getThumb(STAFF_THUMB_URL);
            title = 'STAFF TEAM';
            body = settings.botOwner || 'bot owner';
        }

        await sock.sendMessage(chatId, card(lines, thumb, mentions, title, body), { quoted: msg });
    } catch (error) {
        console.error('Error in staff command:', error);
        await sock.sendMessage(chatId, {
            text: 'Failed to get staff list!'
        }, { quoted: msg });
    }
}





module.exports = {
  name: 'staff',
  permissionLevel: 'sudo', // FIXED: central sudo permission
  async execute(ctx) {
    return staffCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.view || null); // FIXED: ctx.message standardization
  }
};
