const fs = require('fs');
const path = require('path');

const warningsFilePath = path.join(process.cwd(), 'data', 'warnings.json'); // FIXED: absolute warnings state path

function normalizeWarnJid(value) {
    const digits = String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    return digits ? `${digits}@s.whatsapp.net` : '';
}

function loadWarnings() {
    if (!fs.existsSync(warningsFilePath)) {
        fs.writeFileSync(warningsFilePath, JSON.stringify({}), 'utf8');
    }
    const data = fs.readFileSync(warningsFilePath, 'utf8');
    return JSON.parse(data);
}

async function warningsCommand(sock, chatId, mentionedJids, message) {
    const warnings = loadWarnings();

    const repliedUser = message?.message?.extendedTextMessage?.contextInfo?.participant || '';
    const userToCheck = normalizeWarnJid((mentionedJids || [])[0] || repliedUser); // FIXED: warnings uses ctx.mentionedJids

    if (!userToCheck) {
        await sock.sendMessage(chatId, { text: 'Please mention a user to check warnings.' });
        return;
    }

    const warningEntries = warnings?.[chatId] || {};
    const warningCount = Object.entries(warningEntries).reduce((sum, [jid, count]) => {
        return normalizeWarnJid(jid) === userToCheck ? sum + Number(count || 0) : sum;
    }, 0);

    await sock.sendMessage(chatId, {
        text: `@${userToCheck.split('@')[0]} has ${warningCount} warning(s).`,
        mentions: [userToCheck]
    }, message ? { quoted: message } : {});
}





module.exports = {
  name: 'warnings',
  permissionLevel: 'sudo', // FIXED: central sudo permission
  async execute(ctx) {
    return warningsCommand(ctx.sock || null, ctx.chatId || null, ctx.mentionedJids || null, ctx.message || null);
  }
};
