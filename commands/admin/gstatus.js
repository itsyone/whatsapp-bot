const https = require('https');

const THUMB_URL = 'https://i.ibb.co/HTTzv5V4/f51a4646-e883-4885-a8d5-09368cde504c-removalai-preview.png';
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

function bar(count, maxCount) {
    const ratio = maxCount > 0 ? count / maxCount : 0;
    const filled = Math.max(1, Math.min(4, Math.ceil(ratio * 4)));
    return `${'■'.repeat(filled)}${'□'.repeat(4 - filled)}`;
}

function pad(num) {
    return String(num).padStart(2, '0');
}

async function gstatusCommand(sock, chatId, message) {
    try {
        const groupsMap = await sock.groupFetchAllParticipating();
        const groups = Object.values(groupsMap || {})
            .map((group) => ({
                id: group.id,
                count: Array.isArray(group.participants) ? group.participants.length : 0
            }))
            .sort((a, b) => a.count - b.count);

        const totalGroups = groups.length;
        const totalUsers = groups.reduce((sum, group) => sum + group.count, 0);
        const maxCount = groups.reduce((max, group) => Math.max(max, group.count), 0);

        const breakdown = groups.length
            ? groups.map((group, index) => `GC: ${pad(index + 1)} .. ${group.count} [${bar(group.count, maxCount)}]`)
            : ['GC: 00 .. 0 [□□□□]'];

        const text = [
            '──── STATS REPORT ────',
            `TOTAL GROUPS :: ${pad(totalGroups)}`,
            `TOTAL USERS  :: ${totalUsers}`,
            '',
            '─── BREAKDOWN ─────',
            ...breakdown,
            '─────────────────'
        ].join('\n');

        const thumb = await getThumb();
        await sock.sendMessage(chatId, {
            text,
            contextInfo: {
                externalAdReply: {
                    title: 'GROUP STATUS',
                    body: 'live bot coverage',
                    mediaType: 1,
                    mediaUrl: '',
                    sourceUrl: '',
                    renderLargerThumbnail: false,
                    showAdAttribution: false,
                    ...(thumb ? { thumbnail: thumb } : {})
                }
            }
        }, { quoted: message });
    } catch (error) {
        console.error('[gstatus] error:', error?.message || error);
        await sock.sendMessage(chatId, { text: 'Failed to load bot group status.' }, { quoted: message });
    }
}





module.exports = {
  name: 'gstatus',
  permissionLevel: 'owner', // FIXED: central owner permission
  async execute(ctx) {
    return gstatusCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
