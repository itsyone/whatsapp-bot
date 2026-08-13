const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const isAdmin = require('../../lib/isAdmin');
const isOwnerOrSudo = require('../../lib/isOwner');

const dbPath = path.join(__dirname, '..', '..', 'data', 'activity.sqlite');
const legacyMessageCountPath = path.join(__dirname, '..', '..', 'data', 'messageCount.json');
const legacyActiveMembersPath = path.join(__dirname, '..', '..', 'data', 'activeMembers.json');
const MIN_ACTIVE_MESSAGES = 5;
const MEDALS = ['🥇', '🥈', '🥉', '🏅', '🎖️'];

if (!fs.existsSync(path.dirname(dbPath))) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS member_stats (
    group_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    representative_jid TEXT NOT NULL,
    total_count INTEGER NOT NULL DEFAULT 0,
    last_seen_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, user_key)
);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS message_logs (
    group_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_logs_ts ON message_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_message_logs_group_user ON message_logs(group_id, user_key);

CREATE TABLE IF NOT EXISTS periodic_stats (
    group_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    period_type TEXT NOT NULL, -- 'daily', 'monthly'
    period_key TEXT NOT NULL,  -- e.g. '2026-04-26', '2026-04'
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, user_key, period_type, period_key)
);

CREATE TABLE IF NOT EXISTS jid_mappings (
    group_id TEXT NOT NULL,
    lid_jid TEXT NOT NULL,
    phone_jid TEXT NOT NULL,
    last_updated INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, lid_jid)
);
`);

const selectMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
const setMetaStmt = db.prepare(`
INSERT INTO meta (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const selectMemberStmt = db.prepare(`
SELECT representative_jid, total_count
FROM member_stats
WHERE group_id = ? AND user_key = ?
`);
const upsertAbsoluteStmt = db.prepare(`
INSERT INTO member_stats (group_id, user_key, representative_jid, total_count, last_seen_at)
VALUES (@group_id, @user_key, @representative_jid, @total_count, @last_seen_at)
ON CONFLICT(group_id, user_key) DO UPDATE SET
    representative_jid = CASE
        WHEN member_stats.representative_jid LIKE '%@s.whatsapp.net' THEN member_stats.representative_jid
        WHEN excluded.representative_jid LIKE '%@s.whatsapp.net' THEN excluded.representative_jid
        ELSE member_stats.representative_jid
    END,
    total_count = CASE
        WHEN excluded.total_count > member_stats.total_count THEN excluded.total_count
        ELSE member_stats.total_count
    END,
    last_seen_at = CASE
        WHEN excluded.last_seen_at > member_stats.last_seen_at THEN excluded.last_seen_at
        ELSE member_stats.last_seen_at
    END
`);
const upsertIncrementStmt = db.prepare(`
INSERT INTO member_stats (group_id, user_key, representative_jid, total_count, last_seen_at)
VALUES (@group_id, @user_key, @representative_jid, 1, @last_seen_at)
ON CONFLICT(group_id, user_key) DO UPDATE SET
    representative_jid = CASE
        WHEN member_stats.representative_jid LIKE '%@s.whatsapp.net' THEN member_stats.representative_jid
        WHEN excluded.representative_jid LIKE '%@s.whatsapp.net' THEN excluded.representative_jid
        ELSE member_stats.representative_jid
    END,
    total_count = member_stats.total_count + 1,
    last_seen_at = excluded.last_seen_at
`);
const upsertJidMappingStmt = db.prepare(`
INSERT INTO jid_mappings (group_id, lid_jid, phone_jid, last_updated)
VALUES (@group_id, @lid_jid, @phone_jid, @last_updated)
ON CONFLICT(group_id, lid_jid) DO UPDATE SET
    phone_jid = excluded.phone_jid,
    last_updated = excluded.last_updated
`);
const selectJidMappingStmt = db.prepare(`
SELECT phone_jid FROM jid_mappings WHERE group_id = ? AND lid_jid = ?
`);const deleteMemberStmt = db.prepare(`
DELETE FROM member_stats
WHERE group_id = ? AND user_key = ?
`);
const topMembersStmt = db.prepare(`
SELECT representative_jid AS jid, total_count AS count
FROM member_stats
WHERE group_id = ? AND total_count >= ?
ORDER BY total_count DESC, last_seen_at DESC
`);

const topMonthlyMembersStmt = db.prepare(`
SELECT ms.representative_jid AS jid, ps.count AS count
FROM periodic_stats ps
JOIN member_stats ms ON ps.group_id = ms.group_id AND ps.user_key = ms.user_key
WHERE ps.group_id = ? AND ps.period_type = 'monthly' AND ps.period_key = ? AND ps.count >= ?
ORDER BY ps.count DESC
`);

const insertLogStmt = db.prepare(`
INSERT INTO message_logs (group_id, user_key, timestamp)
VALUES (?, ?, ?)
`);

const cleanupLogsStmt = db.prepare(`
DELETE FROM message_logs WHERE timestamp < ?
`);

const upsertPeriodicStmt = db.prepare(`
INSERT INTO periodic_stats (group_id, user_key, period_type, period_key, count)
VALUES (@group_id, @user_key, @period_type, @period_key, 1)
ON CONFLICT(group_id, user_key, period_type, period_key) DO UPDATE SET
    count = periodic_stats.count + 1
`);

function getMeta(key) {
    return selectMetaStmt.get(key)?.value || '';
}

function setMeta(key, value) {
    setMetaStmt.run(key, String(value || ''));
}

function userKey(jid) {
    return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '') || String(jid || '');
}

function mentionTag(jid) {
    return `@${String(jid || '').split('@')[0].split(':')[0]}`;
}

function pickRepresentativeJid(currentJid, nextJid) {
    const current = String(currentJid || '').trim();
    const next = String(nextJid || '').trim();
    if (!current) return next;
    if (!next) return current;
    if (current.endsWith('@s.whatsapp.net')) return current;
    if (next.endsWith('@s.whatsapp.net')) return next;
    return current;
}

function isPhoneJid(jid) {
    return String(jid || '').endsWith('@s.whatsapp.net');
}

function isLidJid(jid) {
    return String(jid || '').endsWith('@lid');
}

function normalizeLegacyCount(entry) {
    if (typeof entry === 'number') return Number(entry || 0);
    if (entry && typeof entry === 'object') {
        if (typeof entry.total === 'number') return Number(entry.total || 0);
        if (typeof entry.count === 'number') return Number(entry.count || 0);
    }
    return 0;
}

function importLegacyFile(filePath, importer) {
    if (!fs.existsSync(filePath)) return;
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8') || '{}');
        importer(parsed);
    } catch (error) {
        console.error(`[active] failed to import ${path.basename(filePath)}:`, error.message);
    }
}

const migrateLegacyData = db.transaction(() => {
    if (getMeta('activity_migration_v1_done') === 'true') return;

    const now = Date.now();

    importLegacyFile(legacyMessageCountPath, (parsed) => {
        for (const [groupId, members] of Object.entries(parsed || {})) {
            if (!String(groupId).endsWith('@g.us')) continue;
            if (!members || typeof members !== 'object' || Array.isArray(members)) continue;

            for (const [jid, rawCount] of Object.entries(members)) {
                const total = normalizeLegacyCount(rawCount);
                if (total <= 0) continue;
                upsertAbsoluteStmt.run({
                    group_id: groupId,
                    user_key: userKey(jid),
                    representative_jid: String(jid || '').trim(),
                    total_count: total,
                    last_seen_at: now
                });
            }
        }
    });

    importLegacyFile(legacyActiveMembersPath, (parsed) => {
        const groups = parsed?.groups || parsed || {};
        for (const [groupId, members] of Object.entries(groups || {})) {
            if (!String(groupId).endsWith('@g.us')) continue;
            if (!members || typeof members !== 'object' || Array.isArray(members)) continue;

            for (const [jid, rawEntry] of Object.entries(members)) {
                const total = normalizeLegacyCount(rawEntry);
                if (total <= 0) continue;
                upsertAbsoluteStmt.run({
                    group_id: groupId,
                    user_key: userKey(jid),
                    representative_jid: String(jid || '').trim(),
                    total_count: total,
                    last_seen_at: now
                });
            }
        }
    });

    setMeta('activity_migration_v1_done', 'true');
});

migrateLegacyData();

const mergeAliasRows = db.transaction((groupId, primaryJid, aliases = []) => {
    const primaryKey = userKey(primaryJid);
    const primaryRow = selectMemberStmt.get(groupId, primaryKey) || {
        representative_jid: String(primaryJid || '').trim(),
        total_count: 0
    };

    let mergedCount = Number(primaryRow.total_count || 0);
    let representativeJid = pickRepresentativeJid(primaryRow.representative_jid, primaryJid);

    for (const aliasJid of aliases) {
        const aliasKey = userKey(aliasJid);
        if (!aliasKey || aliasKey === primaryKey) continue;

        const aliasRow = selectMemberStmt.get(groupId, aliasKey);
        if (!aliasRow) continue;

        mergedCount += Number(aliasRow.total_count || 0);
        representativeJid = pickRepresentativeJid(representativeJid, aliasRow.representative_jid || aliasJid);
        deleteMemberStmt.run(groupId, aliasKey);
    }

    upsertAbsoluteStmt.run({
        group_id: groupId,
        user_key: primaryKey,
        representative_jid: representativeJid,
        total_count: mergedCount,
        last_seen_at: Date.now()
    });
});

function incrementMessageCount(groupId, userId, aliases = []) {
    if (!groupId || !String(groupId).endsWith('@g.us') || !userId) return;

    const aliasList = [...new Set(
        [userId, ...[].concat(aliases || [])]
            .map((value) => String(value || '').trim())
            .filter(Boolean)
            .filter((value) => value !== 'status@broadcast' && !value.endsWith('@g.us'))
    )];

    const primaryJid = aliasList.find((value) => isPhoneJid(value)) || String(userId || '').trim();
    mergeAliasRows(groupId, primaryJid, aliasList);

    upsertIncrementStmt.run({
        group_id: groupId,
        user_key: userKey(primaryJid),
        representative_jid: primaryJid,
        last_seen_at: Date.now()
    });

    // Store LID to phone JID mapping if both are available
    const lidJid = aliasList.find((value) => value.endsWith('@lid'));
    const phoneJid = aliasList.find((value) => isPhoneJid(value));
    if (lidJid && phoneJid) {
        upsertJidMappingStmt.run({
            group_id: groupId,
            lid_jid: lidJid,
            phone_jid: phoneJid,
            last_updated: Date.now()
        });
    }

    // Log the message for time-based stats
    const now = Date.now();
    const uKey = userKey(primaryJid);
    insertLogStmt.run(groupId, uKey, now);

    // Update periodic aggregates
    const dateObj = new Date(now);
    const dayKey = dateObj.toISOString().split('T')[0];
    const monthKey = dayKey.slice(0, 7);

    upsertPeriodicStmt.run({ group_id: groupId, user_key: uKey, period_type: 'daily', period_key: dayKey });
    upsertPeriodicStmt.run({ group_id: groupId, user_key: uKey, period_type: 'monthly', period_key: monthKey });

    // Occasional cleanup (1% chance)
    if (Math.random() < 0.01) {
        cleanupLogsStmt.run(now - (30 * 24 * 60 * 60 * 1000));
    }
}

function getActiveMembers(groupId) {
    const thisMonth = new Date().toISOString().slice(0, 7);
    return topMonthlyMembersStmt.all(groupId, thisMonth, MIN_ACTIVE_MESSAGES).map((row) => ({
        jid: row.jid,
        count: row.count
    }));
}

async function collapseDisplayDuplicates(sock, members = []) {
    const merged = new Map();

    for (const member of members) {
        let displayName = '';
        try {
            displayName = String(await sock.getName(member.jid) || '').trim();
        } catch {}

        const keyBase = displayName.toLowerCase().replace(/\s+/g, ' ').trim();
        const displayKey = keyBase && !/^\+?\d+$/.test(keyBase)
            ? `name:${keyBase}`
            : `jid:${userKey(member.jid)}`;

        const existing = merged.get(displayKey);
        if (!existing) {
            merged.set(displayKey, { ...member });
            continue;
        }

        const canMergeByName = displayKey.startsWith('name:');

        if (!canMergeByName) {
            const fallbackKey = `jid:${userKey(member.jid)}`;
            const fallbackExisting = merged.get(fallbackKey);
            if (fallbackExisting) {
                fallbackExisting.count += member.count;
                fallbackExisting.jid = pickRepresentativeJid(fallbackExisting.jid, member.jid);
            } else {
                merged.set(fallbackKey, { ...member });
            }
            continue;
        }

        existing.count += member.count;
        existing.jid = pickRepresentativeJid(existing.jid, member.jid);
    }

    return Array.from(merged.values()).sort((a, b) => b.count - a.count);
}

function buildMessage(members) {
    const lines = ['*╭─〔 Active 〕*', ''];

    members.forEach((member, index) => {
        const medal = MEDALS[index] || '🏆';
        lines.push(`*│* ${index + 1}. ${medal} ${mentionTag(member.jid)}`);
        lines.push(`*│* 💬 ${member.count.toLocaleString()} msgs`);
        lines.push('');
    });

    if (lines[lines.length - 1] === '') lines.pop();
    lines.push('*╰────────*');
    return lines.join('\n');
}

async function topMembers(sock, chatId, message, isGroup, senderId) {
    if (!isGroup) {
        await sock.sendMessage(chatId, {
            text: 'This command is only available in group chats.'
        }, message ? { quoted: message } : {});
        return;
    }

    const senderIsAdmin = await isAdmin(sock, chatId, senderId);
    const senderIsOwner = await isOwnerOrSudo(senderId);

    if (!senderIsAdmin && !senderIsOwner) {
        await sock.sendMessage(chatId, {
            text: '❌ This command is restricted to group admins only.'
        }, message ? { quoted: message } : {});
        return;
    }

    const members = await collapseDisplayDuplicates(sock, getActiveMembers(chatId));
    if (!members.length) {
        await sock.sendMessage(chatId, {
            text: `No active members yet.\n> Need at least ${MIN_ACTIVE_MESSAGES} messages.`
        }, message ? { quoted: message } : {});
        return;
    }

    await sock.sendMessage(chatId, {
        text: buildMessage(members),
        mentions: members.map((member) => member.jid)
    }, message ? { quoted: message } : {});
}

async function inactiveMembers(sock, chatId, message, isGroup) {
    if (!isGroup) {
        await sock.sendMessage(chatId, {
            text: 'This command is only available in group chats.'
        }, message ? { quoted: message } : {});
        return;
    }

    try {
        const meta = await sock.groupMetadata(chatId);
        const participants = Array.isArray(meta?.participants) ? meta.participants : [];
        
        const rows = db.prepare(`SELECT user_key, representative_jid, total_count FROM member_stats WHERE group_id = ?`).all(chatId);
        
        const countsByJid = new Map();
        const countsByKey = new Map();
        rows.forEach((row) => {
            countsByJid.set(row.representative_jid, Number(row.total_count || 0));
            countsByKey.set(row.user_key, Number(row.total_count || 0));
        });

        // Load JID mappings from the activity database (LID -> phone key)
        const mappings = db.prepare('SELECT lid_jid, phone_jid FROM jid_mappings WHERE group_id = ?').all(chatId);
        const lidToPhoneKey = new Map();
        mappings.forEach((m) => lidToPhoneKey.set(m.lid_jid, userKey(m.phone_jid)));

        const inactive = participants
            .map((p) => {
                const jid = p.id;
                let count = countsByJid.get(jid) || countsByKey.get(userKey(jid)) || 0;
                if (count === 0 && jid.endsWith('@lid')) {
                    const phoneKey = lidToPhoneKey.get(jid);
                    if (phoneKey) count = countsByKey.get(phoneKey) || 0;
                }
                return { jid, count };
            })
            .filter((entry) => entry.jid && entry.count < MIN_ACTIVE_MESSAGES)
            .sort((a, b) => a.count - b.count);
        
        if (!inactive.length) {
            await sock.sendMessage(chatId, { text: 'Everyone in this group is active! ??' }, { quoted: message });
            return;
        }

        const displayCount = Math.min(inactive.length, 20);
        const targets = inactive.slice(0, displayCount);
        const lines = ['*╭─〔 Inactive 〕*', '', `Need \`${MIN_ACTIVE_MESSAGES}+\` messages to count as active.`, ''];
        targets.forEach((entry, i) => {
            lines.push(`*│* ${i + 1}. ${mentionTag(entry.jid)}`);
            lines.push(`*│* 💬 ${entry.count.toLocaleString()} msgs`);
            lines.push('');
        });

        if (inactive.length > displayCount) {
            lines.push(`_...and ${inactive.length - displayCount} more inactive members._`);
        } else if (lines[lines.length - 1] === '') {
            lines.pop();
        }

        lines.push('*╰────────*');

        await sock.sendMessage(chatId, {
            text: lines.join('\n'),
            mentions: targets.map((entry) => entry.jid)
        }, { quoted: message });

    } catch (error) {
        console.error('Error in inactiveMembers:', error);
        await sock.sendMessage(chatId, { text: 'Failed to fetch inactive members.' }, { quoted: message });
    }
}

async function activityCommand(sock, chatId, message, isGroup) {
    if (!isGroup) {
        await sock.sendMessage(chatId, { text: 'This command is only available in group chats.' }, message ? { quoted: message } : {});
        return;
    }

    const meta = await sock.groupMetadata(chatId);
    const totalMembers = Math.max(1, Number(meta?.participants?.length || 1));
    const rows = db.prepare('SELECT COUNT(*) AS active FROM member_stats WHERE group_id = ? AND total_count >= ?').get(chatId, MIN_ACTIVE_MESSAGES);
    const active = Math.max(0, Number(rows?.active || 0));
    const percent = Math.max(0, Math.min(100, Math.round((active / totalMembers) * 100)));
    const barFilled = Math.max(0, Math.min(10, Math.round(percent / 10)));
    const bar = '◈'.repeat(barFilled) + '◇'.repeat(10 - barFilled);

    await sock.sendMessage(chatId, {
        text: `*╭─〔 Pulse 〕*\n*│ \`${percent}%\`  ·  \`${active}/${totalMembers} active\`*\n*│ ${bar}*\n*╰────────*`
    }, message ? { quoted: message } : {});
}

const exportArr = [
    {
        name: 'topmembers',
        alias: ['active'],
        async execute(ctx) {
            return topMembers(
                ctx.sock,
                ctx.chatId,
                ctx.message,
                Boolean(ctx.chatId && ctx.chatId.endsWith('@g.us')),
                ctx.senderId
            );
        }
    },
    {
        name: 'inactive',
        async execute(ctx) {
            return inactiveMembers(
                ctx.sock,
                ctx.chatId,
                ctx.message,
                Boolean(ctx.chatId && ctx.chatId.endsWith('@g.us'))
            );
        }
    },
    {
        name: 'activity',
        async execute(ctx) {
            return activityCommand(
                ctx.sock,
                ctx.chatId,
                ctx.message,
                Boolean(ctx.chatId && ctx.chatId.endsWith('@g.us'))
            );
        }
    }
];

exportArr.incrementMessageCount = incrementMessageCount;
exportArr.getActiveMembers = getActiveMembers;
exportArr.topMembers = topMembers;
exportArr.activityCommand = activityCommand;

module.exports = exportArr;
