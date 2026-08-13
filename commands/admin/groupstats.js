const fs = require('fs');
const path = require('path');
const { getDropStatus } = require('../../lib/dropSystem');
const { getGuardConfig } = require('../../lib/adminGuard');
const { loadUserGroupData } = require('../../lib/index');

const ANTISM_SETTINGS = path.join(process.cwd(), 'data', 'antismSettings.json'); // FIXED: absolute antism settings path

function readJsonSafe(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function onOff(value) {
    return value ? 'ON' : 'OFF';
}

function mark(value) {
    return value ? '✓' : '✗';
}

async function groupStatsCommand(sock, chatId, message) {
    try {
        if (!chatId.endsWith('@g.us')) {
            await sock.sendMessage(chatId, {
                text: 'This command only works in groups.'
            }, { quoted: message });
            return;
        }

        const metadata = await sock.groupMetadata(chatId);
        const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
        const admins = participants.filter((p) => Boolean(p?.admin));
        const data = loadUserGroupData();
        const antism = readJsonSafe(ANTISM_SETTINGS, {});
        const drops = getDropStatus(chatId);
        const guard = getGuardConfig(chatId);

        const welcomeOn = Boolean(data?.welcome?.[chatId]?.enabled);
        const goodbyeOn = Boolean(data?.goodbye?.[chatId]?.enabled);
        const antiLinkOn = Boolean(data?.antilink?.[chatId]?.enabled);
        const antiStatusOn = Boolean(antism?.[chatId]?.enabled);
        const antiDemoteOn = Boolean(guard?.antiDemote);
        const dropsOn = Boolean(drops?.enabled);

        const text = [
            '╭━━〔 🏰 STATS 〕━━╮',
            '',
            `📛 ${String(metadata?.subject || 'Group').trim() || 'Group'}`,
            `👥 ${participants.length}`,
            `👑 ${admins.length}`,
            '',
            '┣━━〔 ⚙️ SETTINGS 〕',
            `┃ ${mark(welcomeOn)} Welcome     : ${onOff(welcomeOn)}`,
            `┃ ${mark(goodbyeOn)} Goodbye     : ${onOff(goodbyeOn)}`,
            `┃ ${mark(antiLinkOn)} Anti-Link   : ${onOff(antiLinkOn)}`,
            `┃ ${mark(antiStatusOn)} Anti-Status : ${onOff(antiStatusOn)}`,
            `┃ ${mark(antiDemoteOn)} Anti-Demote : ${onOff(antiDemoteOn)}`,
            '',
            '┣━━〔 🎁 DROPS 〕',
            `┃ ${mark(dropsOn)} Candy   : ${onOff(dropsOn)}`,
            `┃ ${mark(dropsOn)} Coin    : ${onOff(dropsOn)}`,
            `┃ ${mark(false)} XP      : OFF`,
            `┃ ${mark(dropsOn)} Sticker : ${onOff(dropsOn)}`,
            `┃ ${mark(dropsOn)} Mystery : ${onOff(dropsOn)}`,
            '',
            '╰━━➤ .help >'
        ].join('\n');

        await sock.sendMessage(chatId, { text }, { quoted: message });
    } catch (error) {
        console.error('Error in groupstats command:', error);
        await sock.sendMessage(chatId, {
            text: 'Failed to read group stats.'
        }, { quoted: message });
    }
}





module.exports = {
  name: 'groupstats',
  permissionLevel: 'sudo', // FIXED: central sudo permission
  async execute(ctx) {
    return groupStatsCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
  }
};
