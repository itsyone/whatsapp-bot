function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

const COOLDOWN_MS = 60 * 1000;
const cooldowns = new Map();

const FEMALE_HINTS = [
    'ayesha', 'fatima', 'zara', 'noor', 'alina', 'sana', 'hira', 'iqra', 'komi', 'miku',
    'hina', 'maya', 'sakura', 'ria', 'riya', 'anya', 'nina', 'luna', 'yuki', 'aiko',
    'misaki', 'yamada', 'teto', 'elaina', 'ruka', 'nami', 'hinata', 'mikasa', 'rem', 'emilia'
];

const MALE_HINTS = [
    'ayan', 'ali', 'ahmed', 'mohammad', 'hassan', 'husnain', 'soul', 'drax', 'ryo', 'gojo',
    'itachi', 'naruto', 'sasuke', 'ken', 'leo', 'ray', 'zain', 'hamza', 'saad', 'umer',
    'bilal', 'arslan', 'sameer', 'shoaib', 'eren', 'levi', 'kakashi', 'luffy', 'zoro', 'ace'
];

function getSenderJid(message) {
    return message?.key?.participant || message?.key?.remoteJid || '';
}

function normalizeName(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getGenderScore(name) {
    const normalized = normalizeName(name);
    if (!normalized) return 0;

    let score = 0;
    for (const hint of FEMALE_HINTS) {
        if (normalized.includes(hint)) score += 2;
    }
    for (const hint of MALE_HINTS) {
        if (normalized.includes(hint)) score -= 2;
    }

    if (/\b(girl|queen|princess|begum|baji|api)\b/.test(normalized)) score += 2;
    if (/\b(boy|king|sir|bhai|bro|mister)\b/.test(normalized)) score -= 2;
    if (/[aei]$/.test(normalized)) score += 0.5;
    if (/[krnmtd]$/.test(normalized)) score -= 0.5;

    return score;
}

async function getCandidateName(sock, jid) {
    try {
        const name = await sock.getName(jid);
        return String(name || '').trim();
    } catch {
        return '';
    }
}

async function pickPartner(sock, participants, wantsHusband) {
    const decorated = [];
    for (const jid of participants) {
        const name = await getCandidateName(sock, jid);
        decorated.push({ jid, name, score: getGenderScore(name) });
    }

    const preferred = decorated.filter((entry) => wantsHusband ? entry.score < 0 : entry.score > 0);
    const fallback = decorated.filter((entry) => wantsHusband ? entry.score >= 0 : entry.score <= 0);

    if (preferred.length && Math.random() < 0.75) {
        return pick(preferred);
    }

    return pick(fallback.length ? fallback : decorated);
}

function getCooldownLeft(sender) {
    const endsAt = cooldowns.get(sender) || 0;
    return Math.max(0, endsAt - Date.now());
}

function formatCooldown(ms) {
    const seconds = Math.max(1, Math.ceil(ms / 1000));
    return `${seconds}s`;
}

function buildPairingText(senderTag, targetTag, percent, wantsHusband) {
    const title = wantsHusband ? 'HUSBAND PICKER' : 'WIFE PICKER';
    const pairIcon = wantsHusband ? '💙' : '💞';
    const statuses = [
        'forced marriage incoming',
        'love at first sight',
        'arranged by admin',
        'no escape now',
        'shaadi fixed',
        'approved by fate'
    ];
    const vibes = [
        'chaotic',
        'unstable',
        'power couple',
        'toxic energy',
        'low key cute'
    ];

    return [
        `╭── ${title} ──╮`,
        `│ 👤 ${senderTag}`,
        `│ ${pairIcon} ${targetTag}`,
        '│',
        `│ ❤️ compatibility: ${percent}%`,
        `│ 💬 ${pick(statuses)}`,
        `│ 💭 vibe: ${pick(vibes)}`,
        '╰────────────────╯'
    ].join('\n');
}

function buildExtraLine(wantsHusband, pickedName, pickedScore) {
    if (!wantsHusband && pickedScore < 0) {
        return `│ 🌈 plot twist: ${pickedName || 'bro'} got picked, thats kinda gay ngl`;
    }
    if (wantsHusband && pickedScore > 0) {
        return `│ 😭 plot twist: ${pickedName || 'queen'} slipped into the husband queue`;
    }
    return '';
}

async function wifeCommand(sock, chatId, message, rawText = '') {
    const cmd = String(rawText || '').trim().toLowerCase().split(/\s+/)[0].replace(/^\./, '');
    if (!['wife', 'biwi', 'husband', 'shohar', 'femboy', 'stepmom', 'stepbro', 'stepsis'].includes(cmd)) return;

    if (!String(chatId || '').endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: 'This command works only in groups.' }, { quoted: message });
        return;
    }

    const sender = getSenderJid(message);
    const cooldownLeft = getCooldownLeft(`${cmd}:${sender}`);
    if (cooldownLeft > 0) {
        await sock.sendMessage(chatId, {
            text: `Wait ${formatCooldown(cooldownLeft)} before using .${cmd} again.`
        }, { quoted: message });
        return;
    }

    const groupMetadata = await sock.groupMetadata(chatId);

    let participants = (groupMetadata?.participants || [])
        .map((participant) => participant.id)
        .filter(Boolean)
        .filter((jid) => jid !== sender);

    if (!participants.length) {
        await sock.sendMessage(chatId, { text: 'No valid member found.' }, { quoted: message });
        return;
    }

    const wantsHusband = ['husband', 'shohar', 'stepbro', 'femboy'].includes(cmd);
    const pickedEntry = await pickPartner(sock, participants, wantsHusband);
    const picked = pickedEntry?.jid || pick(participants);
    const senderTag = `@${sender.split('@')[0]}`;
    const targetTag = `@${picked.split('@')[0]}`;
    const percent = Math.floor(Math.random() * 101);
    const rawBaseText = buildPairingText(senderTag, targetTag, percent, wantsHusband);
    const titleMap = {
        femboy: 'FEMBOY FINDER',
        stepmom: 'STEPMOM FINDER',
        stepbro: 'STEPBRO FINDER',
        stepsis: 'STEPSIS FINDER'
    };
    const baseText = titleMap[cmd]
        ? rawBaseText.replace(/^╭.*(?:WIFE PICKER|HUSBAND PICKER).*╮/m, `╭── ${titleMap[cmd]} ──╮`)
        : rawBaseText;
    const extraLine = buildExtraLine(wantsHusband, pickedEntry?.name, Number(pickedEntry?.score || 0));
    const text = extraLine ? `${baseText}\n${extraLine}` : baseText;

    cooldowns.set(`${cmd}:${sender}`, Date.now() + COOLDOWN_MS);

    await sock.sendMessage(chatId, {
        text,
        mentions: [sender, picked]
    }, { quoted: message });
}





module.exports = {
  name: 'wife',
  alias: ['biwi', 'husband', 'shohar', 'femboy', 'stepmom', 'stepbro', 'stepsis'],
  async execute(ctx) {
    return wifeCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.rawText || null);
  }
};
