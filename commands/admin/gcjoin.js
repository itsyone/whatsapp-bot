const { hasPermission } = require('../../lib/permissionHandler');
const { hasStaffRole } = require('../../lib/staffRoles');

/**
 * Extracts the invite code from a WhatsApp group invite link.
 * @param {string} text - The text containing the link.
 * @returns {string} The invite code or an empty string.
 */
function extractInviteLink(text = '') {
    const match = String(text || '').match(/https?:\/\/chat\.whatsapp\.com\/([A-Za-z0-9]+)/i);
    return match ? match[1] : '';
}

function normalizeErrorText(error) {
    return String(error?.message || error || '').toLowerCase();
}

function buildJoinErrorMessage(error, inviteInfo = null) {
    const errorText = normalizeErrorText(error);

    if (errorText.includes('401') || errorText.includes('not-authorized') || errorText.includes('forbidden')) {
        return 'Unauthorized: The bot may be banned, removed, or blocked from joining this group.'; // FIXED: gcjoin removed-or-banned error
    }
    if (errorText.includes('404')) {
        return 'Invalid link: The group might no longer exist or the link is revoked.'; // FIXED: gcjoin invalid-link error
    }
    if (errorText.includes('410') || errorText.includes('expired')) {
        return 'Expired: The invite link has expired.'; // FIXED: gcjoin expired-link error
    }
    if (errorText.includes('409') || errorText.includes('already')) {
        return 'Already joined: The bot is already a member of this group.'; // FIXED: gcjoin already-joined error
    }
    if (errorText.includes('removed') || errorText.includes('banned')) {
        return 'The bot appears to be removed or banned from this group.'; // FIXED: gcjoin explicit removed error
    }
    if (inviteInfo?.joinApprovalMode) {
        return 'This group requires admin approval, and the join request could not be completed from the invite link.'; // FIXED: gcjoin approval-mode failure text
    }

    return 'Failed to join the group.'; // FIXED: gcjoin generic fallback
}

module.exports = {
    name: 'gcjoin',
    alias: ['gjoin', 'groupjoin'],
    async execute({ sock, chatId, message, rawText, senderId }) {
        const allowed = await hasPermission(senderId, 'sudo') || hasStaffRole(senderId, ['mods']); // FIXED: gcjoin sudo or mods only
        if (!allowed) {
            await sock.sendMessage(chatId, { text: "You don't have permission to use this command." }, { quoted: message });
            return;
        }

        const inviteCode = extractInviteLink(rawText);
        if (!inviteCode) {
            await sock.sendMessage(chatId, {
                text: 'Please provide a valid WhatsApp group invite link.\nUsage: `.gcjoin <link>`' // FIXED: gcjoin unicode-safe usage text
            }, { quoted: message });
            return;
        }

        try {
            let inviteInfo = null;
            try {
                inviteInfo = await sock.groupGetInviteInfo?.(inviteCode);
            } catch (_) {}

            const progressText = inviteInfo?.joinApprovalMode
                ? 'This group requires approval. Sending a join request...'
                : 'Attempting to join the group...';
            await sock.sendMessage(chatId, { text: progressText }, { quoted: message }); // FIXED: gcjoin approval-aware progress text

            const joined = await sock.groupAcceptInvite(inviteCode);

            await sock.sendMessage(chatId, {
                text: inviteInfo?.joinApprovalMode
                    ? (joined
                        ? `Join request sent successfully.\nGroup ID: ${joined}`
                        : 'Join request sent successfully.')
                    : (joined
                        ? `Joined group successfully.\nGroup ID: ${joined}`
                        : 'Joined group successfully.') // FIXED: gcjoin request-vs-join success text
            }, { quoted: message });
        } catch (error) {
            console.error('[gcjoin] error:', error?.message || error);
            let inviteInfo = null;
            try {
                inviteInfo = await sock.groupGetInviteInfo?.(inviteCode);
            } catch (_) {}
            await sock.sendMessage(chatId, { text: buildJoinErrorMessage(error, inviteInfo) }, { quoted: message });
        }
    }
};
