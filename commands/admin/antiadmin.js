const isAdmin = require('../../lib/isAdmin');
const isOwnerOrSudo = require('../../lib/isOwner');
const { getGuardConfig, setGuardConfig } = require('../../lib/adminGuard');

function parseAction(userMessage = '') {
    const parts = String(userMessage || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    return {
        command: parts[0] || '',
        action: parts[1] || 'get'
    };
}

function buildStatusText(config = {}) {
    return [
        '*WISTORIA GUARD*',
        `anti-demote: ${config.antiDemote ? 'on' : 'off'}`,
        `anti-promote: ${config.antiPromote ? 'on' : 'off'}`,
        `controller: ${config.controllerJid || 'not set'}`
    ].join('\n');
}

async function ensureAdminAccess(sock, chatId, senderId, message) {
    if (!String(chatId || '').endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: 'This command only works in groups.' }, { quoted: message });
        return false;
    }

    const adminStatus = await isAdmin(sock, chatId, senderId);
    if (!adminStatus?.isBotAdmin) {
        await sock.sendMessage(chatId, { text: 'Make the bot admin first.' }, { quoted: message });
        return false;
    }

    const allowed = adminStatus.isSenderAdmin || await isOwnerOrSudo(senderId).catch(() => false);
    if (!allowed) {
        await sock.sendMessage(chatId, { text: 'Only group admins can change Wistoria Guard.' }, { quoted: message });
        return false;
    }

    return true;
}

async function updateGuardCommand(sock, chatId, userMessage, senderId, message) {
    if (!(await ensureAdminAccess(sock, chatId, senderId, message))) {
        return;
    }

    const { command, action } = parseAction(userMessage);
    const current = getGuardConfig(chatId);

    if (action === 'get' || action === 'status') {
        await sock.sendMessage(chatId, {
            text: [
                buildStatusText(current),
                '',
                'Usage:',
                '.antidemote on/off/get',
                '.antipromote on/off/get'
            ].join('\n')
        }, { quoted: message });
        return;
    }

    if (action !== 'on' && action !== 'off') {
        await sock.sendMessage(chatId, {
            text: 'Use `on`, `off`, or `get`.\n\n.antidemote on/off/get\n.antipromote on/off/get'
        }, { quoted: message });
        return;
    }

    const enabled = action === 'on';
    const patch = command === '.antipromote'
        ? { antiPromote: enabled }
        : command === '.antidemote'
            ? { antiDemote: enabled }
            : { antiDemote: enabled, antiPromote: enabled };
    const next = setGuardConfig(chatId, patch);

    await sock.sendMessage(chatId, {
        text: [
            '*WISTORIA GUARD UPDATED*',
            `anti-demote: ${next.antiDemote ? 'on' : 'off'}`,
            `anti-promote: ${next.antiPromote ? 'on' : 'off'}`
        ].join('\n')
    }, { quoted: message });
}

async function antiDemoteCommand(sock, chatId, userMessage, senderId, isSenderAdmin, message) {
    return updateGuardCommand(sock, chatId, userMessage, senderId, message);
}

async function antiPromoteCommand(sock, chatId, userMessage, senderId, isSenderAdmin, message) {
    return updateGuardCommand(sock, chatId, userMessage, senderId, message);
}

async function antiAdminCommand(sock, chatId, userMessage, senderId, isSenderAdmin, message) {
    return updateGuardCommand(sock, chatId, userMessage, senderId, message);
}

module.exports = {
    antiDemoteCommand,
    antiPromoteCommand,
    antiAdminCommand
};
