// Mini AFK Utils - Simple name resolution like reminder.js

function normalizeNumber(jid) {
    return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

async function resolveAfkName(sock, jid) {
    const num = normalizeNumber(jid);
    if (!num) return num;
    
    // Try multiple JID formats - tagged number may be LID or phone
    const candidates = [
        String(jid).includes('@') ? jid : `${num}@s.whatsapp.net`,
        `${num}@s.whatsapp.net`,
        `${num}@lid`
    ];
    
    for (const candidate of [...new Set(candidates)]) {
        try {
            const name = await sock.getName(candidate);
            if (name && name.replace(/[^\d]/g, '') !== num && name.length > 0) {
                return name;
            }
        } catch (e) {}
    }
    
    return num;
}

function cleanMentionText(text) {
    if (!text) return '';
    // Remove + and spaces from @+123 456 789 patterns -> @123456789
    return text.replace(/@\+?([0-9]+(?:[\s\-]+[0-9]+)*)/g, (match, p1) => {
        const digits = p1.replace(/[^\d]/g, '');
        return digits.length >= 5 ? `@${digits}` : match;
    });
}

// Format like reminder.js - resolve all mentions to names
async function formatMentionsWithNames(sock, text) {
    if (!text) return '';
    
    // Extract JIDs from text
    const jids = [];
    const atParts = [...text.matchAll(/@\+?([0-9]+(?:[\s\-]+[0-9]+)*)/g)];
    for (const match of atParts) {
        const digits = match[1].replace(/[^\d]/g, '');
        if (digits.length >= 5) {
            jids.push(digits + '@s.whatsapp.net');
        }
    }
    
    // Also find full JIDs
    const fullJids = [...text.matchAll(/([0-9]{5,20})(?::\d+)?@(s\.whatsapp\.net|lid)/g)];
    for (const match of fullJids) {
        jids.push(match[1] + '@' + match[2]);
    }
    
    // Clean up the text first
    let out = cleanMentionText(text);
    
    // Resolve names and replace
    for (const jid of [...new Set(jids)]) {
        const name = await resolveAfkName(sock, jid);
        const num = normalizeNumber(jid);
        if (name && name !== num) {
            const pattern = `@\\+?${num.split('').join('[\\s\\-]*')}`;
            const regex = new RegExp(pattern, 'g');
            out = out.replace(regex, `@${name}`);
        }
    }
    
    return out;
}

module.exports = {
    resolveAfkName,
    cleanMentionText,
    normalizeNumber,
    formatMentionsWithNames
};
