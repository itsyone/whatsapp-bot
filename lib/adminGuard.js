const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '../data/anti_admin_guard.json');

function normalizeJidInput(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object') {
        const candidates = [
            value.participantAlt,
            value.pn,
            value.jid,
            value.id,
            value.participant,
            value.user,
            value.author,
            value.lid
        ]
            .map((v) => (typeof v === 'string' ? v.trim() : ''))
            .filter(Boolean);

        const preferred =
            candidates.find((j) => j.endsWith('@s.whatsapp.net')) ||
            candidates.find((j) => j.endsWith('@lid')) ||
            candidates.find((j) => j.endsWith('@g.us')) ||
            candidates.find((j) => j.includes('@'));

        return preferred || '';
    }
    return String(value || '').trim();
}

function toActionJid(value) {
    const jid = normalizeJidInput(value);
    if (!jid) return '';
    // Do not coerce @lid into @s.whatsapp.net. Many LIDs are not direct phone JIDs.
    return jid;
}

function collectCandidateIds(participant) {
    if (!participant || typeof participant !== 'object') return [];
    const out = [];
    if (participant.id) out.push(String(participant.id));
    if (participant.jid) out.push(String(participant.jid));
    if (participant.participantAlt) out.push(String(participant.participantAlt));
    if (participant.lid) out.push(String(participant.lid).includes('@') ? String(participant.lid) : `${participant.lid}@lid`);
    if (participant.pn) out.push(String(participant.pn).includes('@') ? String(participant.pn) : `${participant.pn}@s.whatsapp.net`);
    return out;
}

function preferActionJid(candidates = []) {
    const list = candidates.map(normalizeJidInput).filter(Boolean);
    return (
        list.find((j) => j.endsWith('@s.whatsapp.net')) ||
        list.find((j) => j.endsWith('@lid')) ||
        list.find((j) => j.endsWith('@g.us')) ||
        list[0] ||
        ''
    );
}

function sameUser(a, b) {
    const ja = normalizeJidInput(a);
    const jb = normalizeJidInput(b);
    if (!ja || !jb) return false;
    const na = ja.split('@')[0].split(':')[0];
    const nb = jb.split('@')[0].split(':')[0];
    return Boolean(na && nb && na === nb);
}

async function resolveGroupJid(sock, groupId, value, metadata) {
    const direct = normalizeJidInput(value);
    if (!direct) return '';
    if (direct.endsWith('@s.whatsapp.net') || direct.endsWith('@lid')) return direct;

    const m = metadata || (await sock.groupMetadata(groupId).catch(() => null));
    const participants = Array.isArray(m?.participants) ? m.participants : [];
    for (const p of participants) {
        const ids = collectCandidateIds(p);
        if (ids.some((x) => sameUser(x, direct))) {
            return preferActionJid(ids);
        }
    }
    return direct;
}

function readState() {
    try {
        if (!fs.existsSync(STATE_PATH)) {
            return { groups: {} };
        }
        const raw = fs.readFileSync(STATE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed.groups || typeof parsed.groups !== 'object') {
            parsed.groups = {};
        }
        return parsed;
    } catch {
        return { groups: {} };
    }
}

function writeState(state) {
    try {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch {}
}

function ensureGroup(state, groupId) {
    if (!state.groups[groupId]) {
        state.groups[groupId] = {
            trackedAdmins: [],
            antiDemote: false,
            antiPromote: false,
            controllerJid: ''
        };
    }
    if (!Array.isArray(state.groups[groupId].trackedAdmins)) {
        state.groups[groupId].trackedAdmins = [];
    }
    if (typeof state.groups[groupId].antiDemote !== 'boolean') {
        state.groups[groupId].antiDemote = false;
    }
    if (typeof state.groups[groupId].antiPromote !== 'boolean') {
        state.groups[groupId].antiPromote = false;
    }
    if (typeof state.groups[groupId].controllerJid !== 'string') {
        state.groups[groupId].controllerJid = '';
    }
    return state.groups[groupId];
}

function getGuardConfig(groupId) {
    const state = readState();
    const g = ensureGroup(state, groupId);
    return {
        antiDemote: g.antiDemote,
        antiPromote: g.antiPromote,
        trackedAdmins: g.trackedAdmins,
        controllerJid: g.controllerJid
    };
}

function setGuardConfig(groupId, patch = {}) {
    const state = readState();
    const g = ensureGroup(state, groupId);
    if (typeof patch.antiDemote === 'boolean') g.antiDemote = patch.antiDemote;
    if (typeof patch.antiPromote === 'boolean') g.antiPromote = patch.antiPromote;
    if (typeof patch.controllerJid === 'string') g.controllerJid = patch.controllerJid;
    writeState(state);
    return {
        antiDemote: g.antiDemote,
        antiPromote: g.antiPromote,
        trackedAdmins: g.trackedAdmins,
        controllerJid: g.controllerJid
    };
}

async function safeParticipantsUpdate(sock, groupId, participants, action) {
    if (!participants || !participants.length) return;
    try {
        await sock.groupParticipantsUpdate(groupId, participants, action);
    } catch (e) {
        console.error(`[AdminGuard] Failed ${action}:`, e?.message || e);
    }
}

function mentionTag(jid) {
    const n = normalizeJidInput(jid);
    if (!n) return '@unknown';
    return `@${n.split('@')[0].split(':')[0]}`;
}

function isSelfActor(sock, jid) {
    if (!jid) return false;
    const me = sock?.user || {};
    const candidates = [
        me.id,
        me.jid,
        me.lid,
        me.participantAlt,
        me.pn
    ].map(normalizeJidInput).filter(Boolean);
    return candidates.some((x) => sameUser(x, jid));
}

async function processAdminGuard(sock, update, isOwnerOrSudo) {
    const groupId = toActionJid(update?.id);
    if (!groupId || !groupId.endsWith('@g.us')) return false;

    const action = String(update?.action || '');
    if (action !== 'promote' && action !== 'demote') return false;

    const metadata = await sock.groupMetadata(groupId).catch(() => null);

    const authorJid = await resolveGroupJid(sock, groupId, update?.author, metadata);
    const targets = (
        await Promise.all((update?.participants || []).map((p) => resolveGroupJid(sock, groupId, p, metadata)))
    ).filter(Boolean);
    if (!targets.length) return false;

    // Ignore events caused by this bot itself (supports both normal JID and LID identities).
    if (isSelfActor(sock, authorJid)) return false;

    const state = readState();
    const g = ensureGroup(state, groupId);

    const ownerAction = authorJid ? await isOwnerOrSudo(authorJid).catch(() => false) : false;
    const controllerExempt = g.controllerJid && sameUser(authorJid, g.controllerJid);
    if (ownerAction || controllerExempt) {
        if (ownerAction && action === 'promote') {
            const set = new Set(g.trackedAdmins);
            for (const jid of targets) set.add(jid);
            g.trackedAdmins = Array.from(set);
            writeState(state);
        }
        return false;
    }

    if (action === 'demote' && g.antiDemote) {
        await Promise.all([
            authorJid ? safeParticipantsUpdate(sock, groupId, [authorJid], 'demote') : Promise.resolve(),
            safeParticipantsUpdate(sock, groupId, targets, 'promote')
        ]);

        g.trackedAdmins = g.trackedAdmins.filter((jid) => !sameUser(jid, authorJid));
        writeState(state);

        await sock.sendMessage(groupId, {
            text:
`⚠️ WISTORIA GUARD

Anti-demote triggered
attacker : ${mentionTag(authorJid)}
action   : attacker demoted
restore  : victim promoted back`,
            mentions: [authorJid, ...targets].filter(Boolean)
        });
        return true;
    }

    if (action === 'promote' && g.antiPromote) {
        await Promise.all([
            authorJid ? safeParticipantsUpdate(sock, groupId, [authorJid], 'demote') : Promise.resolve(),
            safeParticipantsUpdate(sock, groupId, targets, 'demote')
        ]);

        g.trackedAdmins = g.trackedAdmins.filter((jid) => !sameUser(jid, authorJid));
        writeState(state);

        await sock.sendMessage(groupId, {
            text:
`⚠️ WISTORIA GUARD

Anti-promote triggered
attacker : ${mentionTag(authorJid)}
action   : attacker demoted
rollback : unauthorized promote reverted`,
            mentions: [authorJid, ...targets].filter(Boolean)
        });
        return true;
    }

    return false;
}

module.exports = {
    processAdminGuard,
    normalizeJidInput,
    getGuardConfig,
    setGuardConfig
};
