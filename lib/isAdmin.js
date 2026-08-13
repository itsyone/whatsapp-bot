const METADATA_TTL_MS = 2 * 60 * 1000;
const metadataCache = new Map();
const inflightMetadata = new Map();
const warnedChats = new Map();

function normalize(value) {
    const val = String(value || '').trim();
    if (!val) return '';
    // Strip everything after : or @ to get the base ID
    return val.split('@')[0].split(':')[0];
}

function sameUser(a, b) {
    const left = normalize(a);
    const right = normalize(b);
    return Boolean(left && right && left === right);
}

function participantIds(participant) {
    return [
        participant?.id,
        participant?.jid,
        participant?.participantAlt,
        participant?.lid ? `${String(participant.lid).split('@')[0]}@lid` : '',
        participant?.pn ? `${String(participant.pn).split('@')[0]}@s.whatsapp.net` : '',
        participant?.phoneNumber ? `${String(participant.phoneNumber).split('@')[0]}@s.whatsapp.net` : ''
    ].filter(Boolean);
}

function readCachedMetadata(chatId) {
    const cached = metadataCache.get(chatId);
    if (!cached) return null;
    if (Date.now() - Number(cached.at || 0) > METADATA_TTL_MS) return cached.stale ? cached.data : null;
    return cached.data;
}

async function getGroupMetadataCached(sock, chatId) {
    const fresh = readCachedMetadata(chatId);
    if (fresh) return fresh;

    if (inflightMetadata.has(chatId)) {
        return inflightMetadata.get(chatId);
    }

    const request = (async () => {
        try {
            const metadata = await sock.groupMetadata(chatId);
            metadataCache.set(chatId, { data: metadata, at: Date.now(), stale: true });
            return metadata;
        } catch (err) {
            const fallback = metadataCache.get(chatId)?.data || null;
            if (fallback) return fallback;
            throw err;
        } finally {
            inflightMetadata.delete(chatId);
        }
    })();

    inflightMetadata.set(chatId, request);
    return request;
}

function evaluateAdminStatus(metadata, senderId, botIds = []) {
    const participants = metadata?.participants || [];

    function hasAdminRole(jid) {
        return participants.some((participant) => {
            const isAdminRole = participant.admin === 'admin' || participant.admin === 'superadmin';
            return isAdminRole && participantIds(participant).some((candidate) => sameUser(candidate, jid));
        });
    }

    return {
        isSenderAdmin: hasAdminRole(senderId),
        isBotAdmin: botIds.some((jid) => hasAdminRole(jid))
    };
}

function shouldLogAdminError(chatId, messageText) {
    const text = String(messageText || '').toLowerCase();
    if (text.includes('rate-overlimit')) {
        const last = Number(warnedChats.get(chatId) || 0);
        const now = Date.now();
        if (now - last < 60 * 1000) return false;
        warnedChats.set(chatId, now);
        return false;
    }
    return true;
}

async function isAdmin(sock, chatId, senderId) {
    try {
        const metadata = await getGroupMetadataCached(sock, chatId);
        const botIds = [sock?.user?.id, sock?.user?.lid].filter(Boolean);
        let status = evaluateAdminStatus(metadata, senderId, botIds);

        // Promotions can leave cached metadata stale for a short time.
        // If the bot still appears non-admin, force one fresh fetch.
        if (!status.isBotAdmin) {
            try {
                const freshMetadata = await sock.groupMetadata(chatId);
                metadataCache.set(chatId, { data: freshMetadata, at: Date.now(), stale: true });
                status = evaluateAdminStatus(freshMetadata, senderId, botIds);
            } catch {}
        }

        return status;
    } catch (err) {
        if (shouldLogAdminError(chatId, err?.message || err)) {
            console.error('Error in isAdmin:', err);
        }
        return { isSenderAdmin: false, isBotAdmin: false };
    }
}

module.exports = isAdmin;
