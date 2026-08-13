const {
    getRegisteredProfile,
    linkProfileAliases,
    resolveRegisteredJid
} = require('../../lib/registrationStore');

function normalizeHandle(raw = '') {
    return String(raw || '').trim().replace(/^@+/, '').toLowerCase();
}

function getSenderCandidates(message, senderId) {
    return [...new Set([
        senderId,
        message?.key?.participant,
        message?.key?.participantAlt,
        message?.key?.remoteJid
    ]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .filter((value) => value !== 'status@broadcast' && !value.endsWith('@g.us'))
    )];
}

async function discordrCommand(sock, chatId, message, senderId, rawText) {
    const candidates = getSenderCandidates(message, senderId);
    const canonicalSender = resolveRegisteredJid(candidates) || senderId;
    const profile = getRegisteredProfile(canonicalSender);
    if (!profile) {
        await sock.sendMessage(chatId, {
            text: 'Register first with .register before linking Discord.'
        }, { quoted: message });
        return;
    }

    const handle = normalizeHandle(String(rawText || '').split(/\s+/).slice(1).join(' '));
    if (!handle) {
        await sock.sendMessage(chatId, {
            text: 'Usage: .discordr <discord_username>\nExample: .discordr xnx6x'
        }, { quoted: message });
        return;
    }

    const discordAlias = `discord:${handle}`;
    const aliasOwner = resolveRegisteredJid([discordAlias]);

    if (aliasOwner && aliasOwner !== canonicalSender) {
        await sock.sendMessage(chatId, {
            text: `That Discord handle is already linked to another account.\nAlias: ${discordAlias}`
        }, { quoted: message });
        return;
    }

    linkProfileAliases(canonicalSender, discordAlias);

    await sock.sendMessage(chatId, {
        text: [
            '✅ Discord account linked',
            `WhatsApp profile: ${profile.name || 'User'}`,
            `Discord alias: ${discordAlias}`,
            '',
            'Now the Discord bot can load the same balance, rank, inventory, and profile data when that Discord username sends commands.'
        ].join('\n')
    }, { quoted: message });
}

module.exports = {
    name: 'discordr',
    aliases: ['discordlink', 'linkdiscord'],
    async execute(ctx) {
        return discordrCommand(
            ctx.sock || null,
            ctx.chatId || null,
            ctx.message || null,
            ctx.senderId || null,
            ctx.rawText || null
        );
    }
};
