const path = require('path');
const Database = require('better-sqlite3');
const { generateStatsCard, generateStatsCard2 } = require('../../lib/statsCardCanvas');
const { getRegisteredProfile, resolveRegisteredJid, getRawRegistrationProfiles } = require('../../lib/registrationStore');

const dbPath = path.join(__dirname, '..', '..', 'data', 'activity.sqlite');
const db = new Database(dbPath, { readonly: true });

const getUserRowsStmt = db.prepare(`
SELECT group_id, representative_jid, total_count, last_seen_at
FROM member_stats
WHERE user_key = ?
ORDER BY total_count DESC, last_seen_at DESC
`);

const getGroupRowStmt = db.prepare(`
SELECT representative_jid, total_count, last_seen_at
FROM member_stats
WHERE group_id = ? AND user_key = ?
LIMIT 1
`);

const getPhoneJidStmt = db.prepare(`
SELECT representative_jid
FROM member_stats
WHERE user_key = ? AND representative_jid LIKE '%@s.whatsapp.net'
LIMIT 1
`);

const getGroupRankStmt = db.prepare(`
SELECT COUNT(*) + 1 AS rank
FROM member_stats
WHERE group_id = ? AND total_count > ?
`);

const getLogsCountStmt = db.prepare(`
SELECT COUNT(*) AS count
FROM message_logs
WHERE group_id = ? AND user_key = ? AND timestamp > ?
`);

const getMonthCountStmt = db.prepare(`
SELECT SUM(count) as count FROM periodic_stats
WHERE group_id = ? AND user_key = ? AND period_type = 'monthly' AND period_key = ?
`);

const groupNameCache = new Map();

function normalizeJid(value) {
    return String(value || '').trim();
}

function userKey(jid) {
    return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '') || String(jid || '');
}

function safeName(value, fallback = 'USER') {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text || fallback;
}

function mentionTag(jid) {
    const raw = String(jid || '').split('@')[0].split(':')[0];
    if (raw.length >= 10 && /^\d+$/.test(raw)) {
        return `+${raw}`;
    }
    return `@${raw}`;
}

async function resolveTarget(message, senderId) {
    const contextInfo = message?.message?.extendedTextMessage?.contextInfo || {};
    const mentioned = Array.isArray(contextInfo.mentionedJid) ? contextInfo.mentionedJid : [];
    const rawTarget = mentioned[0] || contextInfo.participant || senderId;
    return resolveRegisteredJid(rawTarget) || rawTarget;
}

async function getDisplayName(sock, jid, fallback) {
    try {
        const name = await sock.getName(jid);
        if (name) return safeName(name, fallback);
    } catch {}
    return safeName(fallback, mentionTag(jid));
}

function formatDate(value) {
    const ts = Number(value || 0);
    if (!ts) return 'Not tracked';
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return 'Not tracked';
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

async function resolveGroupName(sock, groupId, currentChatId, currentGroupName) {
    const safeGroupId = String(groupId || '').trim();
    if (!safeGroupId) return 'Unknown Group';
    if (safeGroupId === currentChatId && currentGroupName) return currentGroupName;
    if (groupNameCache.has(safeGroupId)) return groupNameCache.get(safeGroupId);

    let resolved = safeGroupId;
    try {
        const meta = await sock.groupMetadata(safeGroupId);
        if (meta?.subject) resolved = safeName(meta.subject, resolved);
    } catch {}

    if (resolved === safeGroupId) {
        resolved = `Group ${safeGroupId.split('@')[0]}`;
    }

    groupNameCache.set(safeGroupId, resolved);
    return resolved;
}

async function buildTopGroups(sock, rows, currentChatId, currentGroupName) {
    const groups = rows.slice(0, 3);
    return Promise.all(groups.map(async (row) => ({
        icon: '💬',
        name: await resolveGroupName(sock, row.group_id, currentChatId, currentGroupName),
        count: Number(row.total_count || 0)
    })));
}

async function statsCommand(sock, rawChatId, message, senderId) {
    try {
        const chatId = rawChatId;
        
        const targetJid = await resolveTarget(message, senderId);
        const normalizedTarget = normalizeJid(targetJid);
        const key = userKey(normalizedTarget);
        if (!key) {
            await sock.sendMessage(chatId, { text: 'Could not resolve a user for stats.' }, { quoted: message });
            return;
        }

        const profile = getRegisteredProfile(normalizedTarget) || {};
        const displayName = await getDisplayName(sock, normalizedTarget, profile.name || targetJid.split('@')[0]);

        // Get all possible keys for this user to ensure we find their data
        const allKeys = new Set([key, userKey(targetJid)]);
        const profiles = getRawRegistrationProfiles();
        const aliases = profiles.aliases || {};
        for (const [aliasJid, canonicalJid] of Object.entries(aliases)) {
            if (canonicalJid === normalizedTarget) {
                allKeys.add(userKey(aliasJid));
            }
        }
        
        const keyList = Array.from(allKeys);
        const keyPlaceholder = keyList.map(() => '?').join(',');

        // Stats lookups using all keys
        let groupMessages = 0;
        let lastSeenAt = 0;
        let groupName = 'Private Chat';
        
        let groupPfp = null;
        if (chatId && chatId.endsWith('@g.us')) {
            try {
                const meta = await sock.groupMetadata(chatId);
                groupName = meta?.subject || groupName;
                
                const pfpUrl = await sock.profilePictureUrl(chatId, 'image');
                if (pfpUrl) {
                    const resp = await fetch(pfpUrl);
                    if (resp.ok) groupPfp = Buffer.from(await resp.arrayBuffer());
                }
            } catch {}
        }

        const groupRow = db.prepare(`
            SELECT SUM(total_count) as total, MAX(last_seen_at) as last_seen FROM member_stats 
            WHERE group_id = ? AND user_key IN (${keyPlaceholder})
        `).get(chatId, ...keyList);
        
        if (groupRow) {
            groupMessages = Number(groupRow.total || 0);
            lastSeenAt = Number(groupRow.last_seen || 0);
        }

        const allRows = db.prepare(`
            SELECT SUM(total_count) as total FROM member_stats 
            WHERE user_key IN (${keyPlaceholder})
        `).get(...keyList);
        const allMessages = Number(allRows?.total || 0);

        const activeGroups = db.prepare(`
            SELECT COUNT(DISTINCT group_id) as count FROM member_stats 
            WHERE user_key IN (${keyPlaceholder})
        `).get(...keyList)?.count || 0;

        const topGroupsRows = db.prepare(`
            SELECT group_id, total_count FROM member_stats 
            WHERE user_key IN (${keyPlaceholder})
            ORDER BY total_count DESC LIMIT 10
        `).all(...keyList);
        const topGroups = await buildTopGroups(sock, topGroupsRows, chatId, groupName);

        let groupRank = 0;
        if (groupMessages > 0) {
            groupRank = Number(db.prepare(`
                SELECT COUNT(*) + 1 AS rank FROM member_stats 
                WHERE group_id = ? AND total_count > ?
            `).get(chatId, groupMessages)?.rank || 0);
        }

        const now = Date.now();
        let msg24h = db.prepare(`
            SELECT COUNT(*) as count FROM message_logs 
            WHERE group_id = ? AND user_key IN (${keyPlaceholder}) AND timestamp > ?
        `).get(chatId, ...keyList, now - (24 * 60 * 60 * 1000))?.count || 0;
        
        let msg7d = db.prepare(`SELECT COUNT(*) as count FROM message_logs WHERE group_id = ? AND user_key IN (${keyPlaceholder}) AND timestamp > ?`).get(chatId, ...keyList, now - (7 * 24 * 60 * 60 * 1000))?.count || 0;
        let msg30d = db.prepare(`SELECT COUNT(*) as count FROM message_logs WHERE group_id = ? AND user_key IN (${keyPlaceholder}) AND timestamp > ?`).get(chatId, ...keyList, now - (30 * 24 * 60 * 60 * 1000))?.count || 0;

        const thisMonth = new Date().toISOString().slice(0, 7);
        const thisDay = new Date().toISOString().split('T')[0];
        
        const monthRow = db.prepare(`
            SELECT SUM(count) as count FROM periodic_stats 
            WHERE group_id = ? AND user_key IN (${keyPlaceholder}) AND period_type = 'monthly' AND period_key = ?
        `).get(chatId, ...keyList, thisMonth);
        const msgMonth = Number(monthRow?.count || 0);

        const dayRow = db.prepare(`
            SELECT SUM(count) as count FROM periodic_stats 
            WHERE group_id = ? AND user_key IN (${keyPlaceholder}) AND period_type = 'daily' AND period_key = ?
        `).get(chatId, ...keyList, thisDay);
        const msgToday = Number(dayRow?.count || 0);

        // Display JID resolution
        let displayJid = normalizedTarget;
        for (const [aliasJid, canonicalJid] of Object.entries(aliases)) {
            if (canonicalJid === normalizedTarget && aliasJid.endsWith('@s.whatsapp.net')) {
                displayJid = aliasJid;
                break;
            }
        }

        const chartSeries = topGroupsRows.slice(0, 14).map((row) => Number(row.total_count || 0));
        const inferredCreatedAt =
            Number(profile.createdAt || 0) ||
            Number(profile.created_at || 0) ||
            Number(profile.registeredAt || 0) ||
            Number(profile.renameChangedAt || 0) ||
            Number(profile.bioUpdatedAt || 0) ||
            Number(profile.ageUpdatedAt || 0);

        const earliestSeenRow = db.prepare(`
            SELECT MIN(last_seen_at) as earliest FROM member_stats 
            WHERE user_key IN (${keyPlaceholder}) AND last_seen_at > 0
        `).get(...keyList);
        const joinedDate = profile.joinedAt || profile.joined_on || earliestSeenRow?.earliest || 0;

        // Data mismatch resolution (graceful backfill for new tracking)
        // No estimation logic here anymore - strictly real logs.

        const image = await generateStatsCard({
            sock,
            jid: displayJid,
            username: displayName,
            userTag: mentionTag(displayJid),
            groupName,
            createdOn: formatDate(inferredCreatedAt),
            joinedOn: formatDate(joinedDate),
            rank: groupRank,
            level: Math.max(0, Number(profile.level || 0)),
            groupMessages,
            allMessages,
            activeGroups,
            topGroups,
            chartSeries,
            msg24h,
            msgToday,
            msg7d,
            msg30d,
            msgMonth,
            groupPfp
        });

        const captionText = `🏆 *Stats*\n` +
            `👤 \`${displayName}\`\n` +
            `🥇 \`#${groupRank || '?'}\` • _Lv.${Math.max(0, Number(profile.level || 0))}_\n` +
            `💬 \`${groupMessages.toLocaleString('en-US')}\` / \`${allMessages.toLocaleString('en-US')}\` / \`${activeGroups}\` groups\n` +
            `📅 \`${joinedDate ? new Date(joinedDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not tracked'}\``;

        await sock.sendMessage(chatId, {
            image,
            mimetype: 'image/png',
            caption: captionText,
            mentions: [normalizedTarget]
        }, { quoted: message });
    } catch (error) {
        console.error('Error in stats command:', error);
        const errorTarget = String(rawChatId || senderId || '').split(':')[0].split('@')[0] + (String(rawChatId || '').includes('@g.us') ? '@g.us' : '@s.whatsapp.net');
        if (sock && errorTarget) {
            await sock.sendMessage(errorTarget, { text: 'Failed to generate stats card.' }, message ? { quoted: message } : {});
        }
    }
}

async function statsCommand2(sock, rawChatId, message, senderId) {
    try {
        const chatId = rawChatId;
        const targetJid = await resolveTarget(message, senderId);
        const normalizedTarget = normalizeJid(targetJid);
        const key = userKey(normalizedTarget);
        if (!key) return;

        const profile = getRegisteredProfile(normalizedTarget) || {};
        const displayName = await getDisplayName(sock, normalizedTarget, profile.name || targetJid.split('@')[0]);

        const allKeys = new Set([key, userKey(targetJid)]);
        const profiles = getRawRegistrationProfiles();
        const aliases = profiles.aliases || {};
        for (const [aliasJid, canonicalJid] of Object.entries(aliases)) {
            if (canonicalJid === normalizedTarget) allKeys.add(userKey(aliasJid));
        }
        
        const keyList = Array.from(allKeys);
        const keyPlaceholder = keyList.map(() => '?').join(',');

        let groupMessages = 0;
        let groupName = 'Private Chat';
        if (chatId && chatId.endsWith('@g.us')) {
            try {
                const meta = await sock.groupMetadata(chatId);
                groupName = meta?.subject || groupName;
            } catch {}
        }

        const groupRow = db.prepare(`SELECT SUM(total_count) as total FROM member_stats WHERE group_id = ? AND user_key IN (${keyPlaceholder})`).get(chatId, ...keyList);
        groupMessages = Number(groupRow?.total || 0);

        const allRows = db.prepare(`SELECT SUM(total_count) as total FROM member_stats WHERE user_key IN (${keyPlaceholder})`).get(...keyList);
        const allMessages = Number(allRows?.total || 0);

        const topGroupsRows = db.prepare(`SELECT group_id, total_count FROM member_stats WHERE user_key IN (${keyPlaceholder}) ORDER BY total_count DESC LIMIT 10`).all(...keyList);
        const topGroups = await buildTopGroups(sock, topGroupsRows, chatId, groupName);

        let groupRank = 0;
        if (groupMessages > 0) {
            groupRank = Number(db.prepare(`SELECT COUNT(*) + 1 AS rank FROM member_stats WHERE group_id = ? AND total_count > ?`).get(chatId, groupMessages)?.rank || 0);
        }

        const now = Date.now();
        let msg24h = db.prepare(`SELECT COUNT(*) as count FROM message_logs WHERE group_id = ? AND user_key IN (${keyPlaceholder}) AND timestamp > ?`).get(chatId, ...keyList, now - (24 * 60 * 60 * 1000))?.count || 0;
        let msg7d = db.prepare(`SELECT COUNT(*) as count FROM message_logs WHERE group_id = ? AND user_key IN (${keyPlaceholder}) AND timestamp > ?`).get(chatId, ...keyList, now - (7 * 24 * 60 * 60 * 1000))?.count || 0;
        let msg30d = db.prepare(`SELECT COUNT(*) as count FROM message_logs WHERE group_id = ? AND user_key IN (${keyPlaceholder}) AND timestamp > ?`).get(chatId, ...keyList, now - (30 * 24 * 60 * 60 * 1000))?.count || 0;

        const chartSeries = topGroupsRows.slice(0, 14).map((row) => Number(row.total_count || 0));
        const inferredCreatedAt = Number(profile.createdAt || 0) || Number(profile.registeredAt || 0);
        const earliestSeenRow = db.prepare(`SELECT MIN(last_seen_at) as earliest FROM member_stats WHERE user_key IN (${keyPlaceholder}) AND last_seen_at > 0`).get(...keyList);
        const joinedDate = profile.joinedAt || earliestSeenRow?.earliest || 0;

        const image = await generateStatsCard2({
            sock, jid: normalizedTarget, username: displayName, userTag: mentionTag(normalizedTarget),
            groupName, createdOn: formatDate(inferredCreatedAt), joinedOn: formatDate(joinedDate),
            rank: groupRank, level: Math.max(0, Number(profile.level || 0)), groupMessages, allMessages,
            topGroups, chartSeries, msg24h, msg7d, msg30d
        });

        await sock.sendMessage(chatId, { image, mimetype: 'image/png' }, { quoted: message });
    } catch (error) {
        console.error('Error in stats2 command:', error);
    }
}

module.exports = [
    {
        name: 'stats',
        alias: ['stat'],
        async execute(ctx) {
            return statsCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null);
        }
    },
    {
        name: 'stats2',
        alias: ['st2'],
        async execute(ctx) {
            return statsCommand2(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.senderId || null);
        }
    }
];
