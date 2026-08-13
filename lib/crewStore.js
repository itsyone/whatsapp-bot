const fs = require('fs');
const path = require('path');
const { getBotDataPath } = require('./botDataPath');

const INVITE_TTL_MS = 15 * 60 * 1000;

function ensureDbShape(db) {
    const next = db && typeof db === 'object' ? db : {};
    if (!next.crews || typeof next.crews !== 'object') next.crews = {};
    if (!next.naming || typeof next.naming !== 'object') next.naming = {};
    if (!next.invites || typeof next.invites !== 'object') next.invites = {};
    if (!next.meta || typeof next.meta !== 'object') next.meta = {};
    if (!next.meta.raid || typeof next.meta.raid !== 'object') {
        next.meta.raid = { activeUntil: 0, cooldownUntil: 0, members: {} };
    }
    return next;
}

function toUserKey(value) {
    return normalizeJid(value).split('@')[0].split(':')[0];
}

function mergeUniqueByUser(values = []) {
    const seen = new Set();
    const merged = [];
    for (const value of values) {
        const normalized = normalizeJid(value);
        const key = toUserKey(normalized);
        if (!normalized || !key || seen.has(key)) continue;
        seen.add(key);
        merged.push(normalized);
    }
    return merged;
}

function mergeCooldownMaps(...maps) {
    const merged = {};
    for (const map of maps) {
        for (const [key, value] of Object.entries(map && typeof map === 'object' ? map : {})) {
            merged[key] = Math.max(Number(merged[key] || 0), Number(value || 0));
        }
    }
    return merged;
}

function mergeMaroonedUntilMaps(...maps) {
    const merged = {};
    for (const map of maps) {
        for (const [jid, value] of Object.entries(map && typeof map === 'object' ? map : {})) {
            const normalized = normalizeJid(jid);
            if (!normalized) continue;
            merged[normalized] = Math.max(Number(merged[normalized] || 0), Number(value || 0));
        }
    }
    return merged;
}

function mergeCrewEntries(crews = []) {
    if (!crews.length) return null;

    const preferred = [...crews].sort((left, right) => Number(right?.updatedAt || 0) - Number(left?.updatedAt || 0))[0];
    const captain = crews.find((crew) => normalizeJid(crew?.captain))?.captain || preferred?.captain || '';
    const mergedMembers = mergeUniqueByUser(
        crews.flatMap((crew) => Array.isArray(crew?.members) ? crew.members : [])
    );
    const mergedMarooned = mergeUniqueByUser(
        crews.flatMap((crew) => Array.isArray(crew?.marooned) ? crew.marooned : [])
    );
    const mergedBounties = crews.flatMap((crew) => Array.isArray(crew?.bounties) ? crew.bounties : []);
    const mergedFirstMate = crews.find((crew) => normalizeJid(crew?.firstMate))?.firstMate || preferred?.firstMate || '';

    return hydrateCrew(preferred?.chatId || '', {
        ...preferred,
        crewId: normalizeJid(captain),
        captain,
        firstMate: mergedFirstMate,
        members: mergeUniqueByUser([captain, mergedFirstMate, ...mergedMembers]),
        booty: Math.max(...crews.map((crew) => Number(crew?.booty || 0)), Number(preferred?.booty || 0)),
        sailed: crews.some((crew) => Boolean(crew?.sailed)),
        locked: crews.some((crew) => Boolean(crew?.locked)),
        anchored: crews.some((crew) => Boolean(crew?.anchored)),
        marooned: mergedMarooned,
        maroonedUntil: mergeMaroonedUntilMaps(...crews.map((crew) => crew?.maroonedUntil || {})),
        cooldowns: mergeCooldownMaps(...crews.map((crew) => crew?.cooldowns || {})),
        income: {
            lastCollectedAt: Math.min(...crews.map((crew) => Number(crew?.income?.lastCollectedAt || crew?.createdAt || Date.now())))
        },
        bounties: mergedBounties,
        createdAt: Math.min(...crews.map((crew) => Number(crew?.createdAt || Date.now()))),
        updatedAt: Math.max(...crews.map((crew) => Number(crew?.updatedAt || 0)), Number(preferred?.updatedAt || 0))
    });
}

function migrateLegacyCrews(db) {
    const entries = Object.entries(db?.crews || {});
    if (!entries.length) return { db, changed: false };

    const grouped = new Map();
    for (const [key, rawCrew] of entries) {
        const hydrated = hydrateCrew(rawCrew?.chatId || '', rawCrew);
        if (!hydrated) continue;
        const captainKey = toUserKey(hydrated.captain || hydrated.crewId || key);
        if (!captainKey) continue;
        const bucket = grouped.get(captainKey) || [];
        bucket.push(hydrated);
        grouped.set(captainKey, bucket);
    }

    const nextCrews = {};
    let changed = false;

    for (const crews of grouped.values()) {
        const merged = mergeCrewEntries(crews);
        if (!merged) continue;
        nextCrews[merged.crewId] = merged;

        if (crews.length > 1) changed = true;
        if (crews.some((crew) => normalizeJid(crew?.crewId) !== normalizeJid(merged.crewId))) {
            changed = true;
        }
    }

    if (Object.keys(nextCrews).length !== Object.keys(db.crews || {}).length) {
        changed = true;
    }

    return {
        db: changed ? { ...db, crews: nextCrews } : db,
        changed
    };
}

function loadDb() {
    const DB_PATH = getBotDataPath('crews.json');
    if (!fs.existsSync(DB_PATH)) {
        fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
        fs.writeFileSync(DB_PATH, JSON.stringify({
            crews: {},
            naming: {},
            invites: {},
            meta: { raid: { activeUntil: 0, cooldownUntil: 0, members: {} } }
        }, null, 2), 'utf8');
    }

    try {
        const parsed = ensureDbShape(JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
        const migrated = migrateLegacyCrews(parsed);
        if (migrated.changed) {
            fs.writeFileSync(DB_PATH, JSON.stringify(ensureDbShape(migrated.db), null, 2), 'utf8');
        }
        return ensureDbShape(migrated.db);
    } catch {
        return ensureDbShape({});
    }
}

function saveDb(db) {
    const DB_PATH = getBotDataPath('crews.json');
    fs.writeFileSync(DB_PATH, JSON.stringify(ensureDbShape(db), null, 2), 'utf8');
}

function normalizeJid(value) {
    return String(value || '').trim();
}

function sameUser(a, b) {
    const left = toUserKey(a);
    const right = toUserKey(b);
    return Boolean(left && right && left === right);
}

function buildCrewId(chatId, captainId) {
    return normalizeJid(captainId);
}

function normalizeMemberList(list, captain, firstMate) {
    const seen = new Set();
    const ordered = [];
    for (const jid of [captain, firstMate, ...(Array.isArray(list) ? list : [])]) {
        const value = normalizeJid(jid);
        const key = value.split('@')[0].split(':')[0];
        if (!value || !key || seen.has(key) || value.endsWith('@g.us')) continue;
        seen.add(key);
        ordered.push(value);
    }
    return ordered;
}

function findInviteKey(invites, chatId, targetId) {
    const normalizedChatId = normalizeJid(chatId);
    const normalizedTargetId = normalizeJid(targetId);
    const directKey = `${normalizedChatId}::${normalizedTargetId}`;
    if (invites?.[directKey]) return directKey;

    return Object.keys(invites || {}).find((key) => {
        const [inviteChatId = '', inviteTargetId = ''] = String(key).split('::');
        return normalizeJid(inviteChatId) === normalizedChatId && sameUser(inviteTargetId, normalizedTargetId);
    }) || '';
}

function hydrateCrew(chatId, crew) {
    if (!crew || typeof crew !== 'object') return null;

    const hydrated = { ...crew };
    hydrated.chatId = normalizeJid(hydrated.chatId || chatId);
    hydrated.crewId = normalizeJid(hydrated.crewId || buildCrewId(hydrated.chatId, hydrated.captain));
    hydrated.members = normalizeMemberList(hydrated.members, hydrated.captain, hydrated.firstMate);
    hydrated.booty = Math.max(0, Number(hydrated.booty || 0));
    hydrated.locked = Boolean(hydrated.locked);
    hydrated.anchored = Boolean(hydrated.anchored);
    hydrated.sailed = Boolean(hydrated.sailed);
    hydrated.title = String(hydrated.title || 'Rising Pirates');
    hydrated.reputation = String(hydrated.reputation || 'Unknown');
    hydrated.trait = String(hydrated.trait || 'Lucky Crew');
    hydrated.rank = String(hydrated.rank || 'Deckhand');
    hydrated.marooned = Array.isArray(hydrated.marooned) ? hydrated.marooned.map(String) : [];
    hydrated.maroonedUntil = hydrated.maroonedUntil && typeof hydrated.maroonedUntil === 'object' ? hydrated.maroonedUntil : {};
    hydrated.cooldowns = hydrated.cooldowns && typeof hydrated.cooldowns === 'object' ? hydrated.cooldowns : {};
    hydrated.income = hydrated.income && typeof hydrated.income === 'object'
        ? hydrated.income
        : { lastCollectedAt: Number(hydrated.createdAt || Date.now()) };
    hydrated.bounties = Array.isArray(hydrated.bounties) ? hydrated.bounties : [];
    return hydrated;
}

function listCrewEntries(db) {
    return Object.entries(db.crews || {})
        .map(([key, crew]) => {
            const hydrated = hydrateCrew(crew?.chatId || '', crew);
            return { key, crew: hydrated };
        })
        .filter(({ crew }) => Boolean(crew));
}

function findCrewEntry(db, chatId, jid = '') {
    const entries = listCrewEntries(db);
    if (!entries.length) return null;
    if (!jid) {
        return entries.find(({ crew }) => normalizeJid(crew.chatId) === normalizeJid(chatId)) || entries[0];
    }

    const byMembership = entries.find(({ crew }) =>
        crew.members.some((memberJid) => sameUser(memberJid, jid))
    );
    if (byMembership) return byMembership;

    return entries.find(({ crew }) => sameUser(crew.captain, jid)) || null;
}

function setNamingPrompt(chatId, senderId) {
    const db = loadDb();
    db.naming[chatId] = { senderId: normalizeJid(senderId), createdAt: Date.now() };
    saveDb(db);
}

function getNamingPrompt(chatId) {
    const db = loadDb();
    return db.naming[chatId] || null;
}

function clearNamingPrompt(chatId) {
    const db = loadDb();
    delete db.naming[chatId];
    saveDb(db);
}

function getCrew(chatId, jid = '') {
    const db = loadDb();
    const entry = findCrewEntry(db, chatId, jid);
    return entry ? hydrateCrew(chatId, entry.crew) : null;
}

function createCrew(chatId, captainId, name) {
    const db = loadDb();
    const crewName = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!crewName) return { ok: false, reason: 'invalid_name' };

    const existingCrew = findCrewEntry(db, chatId, captainId);
    if (existingCrew) return { ok: false, reason: 'exists', crew: existingCrew.crew };

    const crew = hydrateCrew(chatId, {
        chatId,
        crewId: buildCrewId(chatId, captainId),
        name: crewName,
        captain: captainId,
        firstMate: '',
        members: [captainId],
        title: 'Rising Pirates',
        reputation: 'Unknown',
        trait: 'Lucky Crew',
        rank: 'Deckhand',
        booty: 150,
        sailed: false,
        locked: false,
        anchored: false,
        marooned: [],
        maroonedUntil: {},
        cooldowns: {},
        income: { lastCollectedAt: Date.now() },
        bounties: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    });

    db.crews[crew.crewId] = crew;
    delete db.naming[chatId];
    saveDb(db);
    return { ok: true, crew };
}

function isCrewMember(chatId, jid) {
    return Boolean(findCrewEntry(loadDb(), chatId, jid));
}

function getMemberRole(chatId, jid) {
    const crew = getCrew(chatId, jid);
    if (!crew || !jid) return null;
    if (sameUser(crew.captain, jid)) return 'Captain';
    if (sameUser(crew.firstMate, jid)) return 'First Mate';
    if (crew.members.some((memberJid) => sameUser(memberJid, jid))) return 'Crew';
    return null;
}

function canManageCrew(chatId, jid) {
    const role = getMemberRole(chatId, jid);
    return role === 'Captain' || role === 'First Mate';
}

function canLeadCrew(chatId, jid) {
    return getMemberRole(chatId, jid) === 'Captain';
}

function updateCrew(chatId, updater, actorJid = '') {
    const db = loadDb();
    const entry = findCrewEntry(db, chatId, actorJid);
    if (!entry?.crew) return { ok: false, reason: 'missing' };

    const nextCrew = updater({
        ...entry.crew,
        members: [...(entry.crew.members || [])],
        marooned: [...(entry.crew.marooned || [])],
        maroonedUntil: { ...(entry.crew.maroonedUntil || {}) },
        cooldowns: { ...(entry.crew.cooldowns || {}) },
        income: { ...(entry.crew.income || {}) },
        bounties: [...(entry.crew.bounties || [])]
    });
    if (!nextCrew) return { ok: false, reason: 'cancelled' };

    const hydrated = hydrateCrew(chatId, nextCrew);
    hydrated.updatedAt = Date.now();

    delete db.crews[entry.key];
    db.crews[hydrated.crewId] = hydrated;
    saveDb(db);
    return { ok: true, crew: hydrated };
}

function setRecruitInvite(chatId, targetId, inviterId) {
    const db = loadDb();
    const crew = getCrew(chatId, inviterId);
    if (!crew) return false;

    const existingKey = findInviteKey(db.invites, chatId, targetId);
    if (existingKey) delete db.invites[existingKey];

    db.invites[`${chatId}::${normalizeJid(targetId)}`] = {
        chatId,
        crewId: crew.crewId,
        targetId,
        inviterId,
        createdAt: Date.now()
    };
    saveDb(db);
    return true;
}

function getRecruitInvite(chatId, targetId) {
    const db = loadDb();
    const key = findInviteKey(db.invites, chatId, targetId);
    const invite = db.invites[key];
    if (!invite) return null;
    if (Date.now() - Number(invite.createdAt || 0) > INVITE_TTL_MS) {
        delete db.invites[key];
        saveDb(db);
        return null;
    }
    return invite;
}

function clearRecruitInvite(chatId, targetId) {
    const db = loadDb();
    const key = findInviteKey(db.invites, chatId, targetId);
    if (key) {
        delete db.invites[key];
        saveDb(db);
    }
}

function acceptRecruitInvite(chatId, targetId) {
    const invite = getRecruitInvite(chatId, targetId);
    if (!invite) return { ok: false, reason: 'missing_invite' };
    if (findCrewEntry(loadDb(), chatId, targetId)) {
        clearRecruitInvite(chatId, targetId);
        return { ok: false, reason: 'already_in_crew' };
    }

    const result = updateCrew(chatId, (crew) => {
        if (crew.members.some((memberJid) => sameUser(memberJid, targetId))) return null;
        crew.members.push(targetId);
        return crew;
    }, invite.inviterId);

    clearRecruitInvite(chatId, targetId);
    if (!result.ok) return result;
    return { ok: true, crew: result.crew, invite };
}

function declineRecruitInvite(chatId, targetId) {
    const invite = getRecruitInvite(chatId, targetId);
    if (!invite) return { ok: false, reason: 'missing_invite' };
    clearRecruitInvite(chatId, targetId);
    return { ok: true, invite };
}

function addBooty(chatId, amount, actorJid = '') {
    return updateCrew(chatId, (crew) => {
        crew.booty = Math.max(0, Number(crew.booty || 0) + Number(amount || 0));
        return crew;
    }, actorJid);
}

module.exports = {
    loadDb,
    saveDb,
    getCrew,
    setNamingPrompt,
    getNamingPrompt,
    clearNamingPrompt,
    createCrew,
    isCrewMember,
    getMemberRole,
    canManageCrew,
    canLeadCrew,
    updateCrew,
    setRecruitInvite,
    getRecruitInvite,
    clearRecruitInvite,
    acceptRecruitInvite,
    declineRecruitInvite,
    addBooty
};
