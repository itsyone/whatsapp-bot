const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(process.cwd(), 'data', 'reminders.json');
const reminders = new Map();
const botSocks = new Map();
let schedulerStarted = false;

function extractAllJids(text) {
    if (!text) return [];
    // 1. Find all things starting with @ followed by optional +, digits, spaces, or dashes (must end with digit)
    const atParts = [...text.matchAll(/@\+?([0-9]+(?:[\s\-]+[0-9]+)*)/g)];
    const fromAt = atParts.map(v => v[1].replace(/[^\d]/g, '') + '@s.whatsapp.net');
    
    // 2. Find all full JIDs (with optional multi-device suffix) or LIDs
    const fullJids = [...text.matchAll(/([0-9]{5,20})(?::\d+)?@(s\.whatsapp\.net|lid)/g)].map(v => v[1] + '@' + v[2]);
    
    return Array.from(new Set([...fromAt, ...fullJids].filter(jid => jid.split('@')[0].length >= 5)));
}

function formatMentionsInText(text) {
    if (!text) return '';
    // Convert full JIDs or LIDs to @number format
    return text.replace(/([0-9]{5,20})(?::\d+)?@(s\.whatsapp\.net|lid)/g, '@$1');
}

async function formatMentionsWithNames(sock, text) {
    if (!text) return '';
    const jids = extractAllJids(text);
    let out = formatMentionsInText(text);
    
    // Resolve all names in parallel to avoid delay
    const namePromises = jids.map(async (jid) => {
        try {
            const name = await sock.getName(jid);
            const number = normalizeUserKey(jid);
            // Only return if it's a real name (not just a formatted version of the number)
            if (name && name.replace(/[^\d]/g, '') !== number) {
                return { jid, name };
            }
        } catch (e) {}
        return null;
    });

    const results = await Promise.all(namePromises);
    for (const res of results) {
        if (res) {
            const number = normalizeUserKey(res.jid);
            // Bulletproof regex: finds @ followed by optional +, then digits that might have spaces/dashes between them
            const pattern = `@\\+?(` + number.split('').join('[\\s\\-]*') + `)`;
            const regex = new RegExp(pattern, 'g');
            out = out.replace(regex, `@${res.name}`);
        }
    }
    return out;
}

function getMentionedJids(message) {
    const contextInfo = message?.message?.extendedTextMessage?.contextInfo || 
                        message?.message?.imageMessage?.contextInfo ||
                        message?.message?.videoMessage?.contextInfo;
    const mentioned = Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid : [];
    return [...new Set(mentioned.filter(Boolean))];
}

function ensureStoreDir() {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
}

function loadStore() {
    try {
        ensureStoreDir();
        const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveStore() {
    ensureStoreDir();
    fs.writeFileSync(STORE_PATH, JSON.stringify(Array.from(reminders.values()), null, 2));
}

function parseDurationToken(token = '') {
    const match = String(token || '').trim().toLowerCase().match(/^(\d+)(s|m|h|d)$/);
    if (!match) return null;

    const value = Number(match[1]);
    const unit = match[2];
    const multiplier = unit === 's' ? 1000
        : unit === 'm' ? 60_000
        : unit === 'h' ? 3_600_000
        : 86_400_000;
    return {
        ms: value * multiplier,
        label: `${value} ${unit === 's' ? 'seconds' : unit === 'm' ? 'minutes' : unit === 'h' ? 'hours' : 'days'}`
    };
}

function parseReminderInput(text = '') {
    const parts = String(text || '').trim().split(/\s+/).slice(1);
    if (!parts.length) return null;

    const first = parseDurationToken(parts[0]);
    const last = parseDurationToken(parts[parts.length - 1]);

    if (first) {
        const reminderText = parts.slice(1).join(' ').trim();
        if (!reminderText) return null;
        return { duration: first, text: reminderText };
    }

    if (last) {
        const reminderText = parts.slice(0, -1).join(' ').trim();
        if (!reminderText) return null;
        return { duration: last, text: reminderText };
    }

    return null;
}

function startScheduler(sockProvider) {
    if (schedulerStarted) return;
    schedulerStarted = true;

    for (const reminder of loadStore()) {
        if (reminder?.id) reminders.set(reminder.id, reminder);
    }

    setInterval(async () => {
        const now = Date.now();
        const due = Array.from(reminders.values()).filter((item) => Number(item?.triggerAt || 0) <= now);
        if (!due.length) return;

        for (const item of due) {
            try {
                const sock = botSocks.get(item.botId || 'eclipse');
                if (!sock) {
                    console.log(`[reminder] no sock registered for bot ${item.botId || 'eclipse'}, skipping for now`);
                    continue; 
                }
                
                const senderName = await sock.getName(item.senderId);
                const resolvedText = await formatMentionsWithNames(sock, item.text);
                const text = `🔔 *Reminder* ${senderName}\n\n> ${resolvedText}`;
                
                const mentions = [item.senderId, ...extractAllJids(item.text)];
                if (Array.isArray(item.contextMentions)) {
                    mentions.push(...item.contextMentions);
                }
                
                await sock.sendMessage(item.chatId, {
                    text,
                    mentions: [...new Set(mentions)]
                });
            } catch (error) {
                console.error('[reminder] send failed:', error?.message || error);
            } finally {
                reminders.delete(item.id);
            }
        }

        saveStore();
    }, 1_000);
}

async function reminderCommand(sock, chatId, message, senderId) {
    const botId = sock.botId || 'eclipse';
    botSocks.set(botId, sock);
    startScheduler();

    const rawText = String(
        message?.message?.conversation ||
        message?.message?.extendedTextMessage?.text ||
        ''
    ).trim();

    const parsed = parseReminderInput(rawText);
    if (!parsed) {
        await sock.sendMessage(chatId, {
            text: 'Use `.reminder 10m Drink water` or `.reminder Drink water 10m`'
        }, { quoted: message });
        return;
    }

    const reminder = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        botId,
        chatId,
        senderId,
        text: parsed.text,
        contextMentions: getMentionedJids(message),
        triggerAt: Date.now() + parsed.duration.ms
    };

    reminders.set(reminder.id, reminder);
    saveStore();

    await sock.sendMessage(chatId, {
        text: `*⏰ Reminder set for ${parsed.duration.label}!*`
    }, { quoted: message });
}

module.exports = {
    name: 'reminder',
    alias: ['remind', 'remindme'],
    async execute(ctx) {
        return reminderCommand(ctx.sock, ctx.chatId, ctx.message, ctx.senderId);
    }
};
