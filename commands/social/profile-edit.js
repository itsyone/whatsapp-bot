const { getRegisteredProfile, updateRegisteredProfile } = require('../../lib/registrationStore');

const RENAME_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatRemaining(ms) {
    const total = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

async function renameCommand(sock, chatId, message, senderId, rawText) {
    const profile = getRegisteredProfile(senderId);
    if (!profile) {
        await sock.sendMessage(chatId, { text: 'Register first with `.register`.' }, { quoted: message });
        return;
    }

    const name = normalizeText(
        String(rawText || '')
            .replace(/^\.rename\b/i, '')
            .replace(/^\.edit\b/i, '')
    );
    if (!name) {
        await sock.sendMessage(chatId, { text: 'Usage: .edit <new name>' }, { quoted: message });
        return;
    }

    if (name.length < 2 || name.length > 30) {
        await sock.sendMessage(chatId, { text: 'Name must be between 2 and 30 characters.' }, { quoted: message });
        return;
    }

    const now = Date.now();
    const nextAllowedAt = Number(profile.renameChangedAt || 0) + RENAME_COOLDOWN_MS;
    if (Number(profile.renameChangedAt || 0) > 0 && now < nextAllowedAt) {
        await sock.sendMessage(chatId, {
            text: `You can rename again in ${formatRemaining(nextAllowedAt - now)}.`
        }, { quoted: message });
        return;
    }

    const updated = updateRegisteredProfile(senderId, {
        name,
        renameChangedAt: now
    });

    await sock.sendMessage(chatId, {
        text: `Name updated to *${updated.name}*.`
    }, { quoted: message });
}

async function editBioCommand(sock, chatId, message, senderId, rawText) {
    const profile = getRegisteredProfile(senderId);
    if (!profile) {
        await sock.sendMessage(chatId, { text: 'Register first with `.register`.' }, { quoted: message });
        return;
    }

    const bio = normalizeText(
        String(rawText || '')
            .replace(/^\.editbio\b/i, '')
            .replace(/^\.bio\b/i, '')
    );

    if (!bio) {
        await sock.sendMessage(chatId, {
            text: profile.bio ? `Current bio: ${profile.bio}` : 'Usage: .bio <new bio>'
        }, { quoted: message });
        return;
    }

    const updated = updateRegisteredProfile(senderId, {
        bio,
        bioUpdatedAt: Date.now()
    });

    await sock.sendMessage(chatId, {
        text: updated.bio ? `Bio updated to:\n${updated.bio}` : 'Bio cleared.'
    }, { quoted: message });
}

async function setAgeCommand(sock, chatId, message, senderId, rawText) {
    const profile = getRegisteredProfile(senderId);
    if (!profile) {
        await sock.sendMessage(chatId, { text: 'Register first with `.register`.' }, { quoted: message });
        return;
    }

    const value = normalizeText(String(rawText || '').replace(/^\.setage\b/i, ''));
    const age = Math.floor(Number(value));
    if (!Number.isFinite(age) || age < 5 || age > 100) {
        await sock.sendMessage(chatId, { text: 'Usage: .setage <5-100>' }, { quoted: message });
        return;
    }

    const updated = updateRegisteredProfile(senderId, {
        age,
        ageUpdatedAt: Date.now()
    });

    await sock.sendMessage(chatId, {
        text: `Age updated to *${updated.age}*.`
    }, { quoted: message });
}

module.exports = {
    renameCommand,
    editBioCommand,
    setAgeCommand
};
