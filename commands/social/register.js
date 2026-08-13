const Groq = require('groq-sdk');
const { generateRegisterCard } = require('../../lib/registerCardCanvas');
const { addBalance } = require('../../lib/economy');
const {
    loadRegistrationState,
    saveRegistrationState,
    getRegisteredProfile,
    upsertRegisteredProfile,
    resolveRegisteredJid,
    linkProfileAliases
} = require('../../lib/registrationStore');

let groqClient = null;
const REGISTER_BONUS = 15000;
const REGISTRATION_STATE_TTL_MS = 30 * 60 * 1000;

function logRegisterSkip(reason, meta = {}) {
    if (process.env.DEBUG_REGISTER === '1') {
        console.log(`[Register:Skip] ${reason}`, JSON.stringify(meta));
    } // FIXED: quiet hot-path register skip logging
}

function getGroqClient() {
    const apiKey = String(process.env.GROQ_API_KEY || '').trim();
    if (!apiKey) return null;
    if (!groqClient) groqClient = new Groq({ apiKey, dangerouslyAllowBrowser: true });
    return groqClient;
}

function clearState(jid) {
    const state = loadRegistrationState();
    delete state.users[jid];
    saveRegistrationState(state);
}

function getRegisterCandidates(message, senderId) {
    return [...new Set([
        senderId,
        message?.key?.participant,
        message?.key?.participantAlt,
        message?.key?.remoteJid
    ]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .filter((value) => value !== 'status@broadcast' && !value.endsWith('@g.us'))
    )];
}

function resolveStateKey(state, candidates = []) {
    const users = state?.users || {};
    for (const candidate of candidates) {
        if (users[candidate]) return candidate;
    }

    const normalizedCandidates = candidates
        .map((value) => String(value || '').replace(/\D/g, ''))
        .filter(Boolean);

    for (const key of Object.keys(users)) {
        const normalizedKey = String(key || '').replace(/\D/g, '');
        if (normalizedCandidates.includes(normalizedKey)) {
            return key;
        }
    }

    return '';
}

function parseAge(input) {
    const text = String(input || '').trim().toLowerCase();
    const match = text.match(/\b(\d{1,3})\b/);
    if (!match) return null;

    const age = Math.floor(Number(match[1]));
    if (!Number.isFinite(age) || age < 5 || age > 100) return null;
    return age;
}

function getMessageContextInfo(message) {
    if (!message?.message) return null;
    const queue = [message.message];
    while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== 'object') continue;
        if (current.contextInfo) return current.contextInfo;
        for (const value of Object.values(current)) {
            if (value && typeof value === 'object') queue.push(value);
        }
    }
    return null;
}

function normalizeSpacing(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function parseGender(input) {
    const normalized = normalizeSpacing(input).toLowerCase();
    if (['male', 'm', 'boy', 'man', 'guy'].includes(normalized)) return 'male';
    if (['female', 'f', 'girl', 'woman', 'lady'].includes(normalized)) return 'female';
    return null;
}

function cleanNameCandidate(input) {
    const text = normalizeSpacing(input)
        .replace(/^(my name is|i am|i'm|im|name is|this is)\s+/i, '')
        .replace(/[.,!?]+$/g, '')
        .trim();

    const lower = text.toLowerCase();
    if (!text || /\d{6,}/.test(text)) return null;
    if (text.length < 2 || text.length > 50) return null;

    const UnicodeValidRegex = /^[\p{L}\p{N}\s'.-]+$/u;
    if (!UnicodeValidRegex.test(text)) return null;

    if (text.split(/\s+/).length > 5) return null;
    if (
        /\b(what|hell|bio|skip|yes|no|old|age|years?|register|bro|wtf)\b/.test(lower) ||
        lower === 'what the hell'
    ) {
        return null;
    }
    return text;
}

function parseBioChoice(input) {
    const normalized = normalizeSpacing(input).toLowerCase();
    if (['yes', 'y', 'haan', 'han', 'ha', 'sure', 'ok', 'okay'].includes(normalized)) {
        return 'yes';
    }
    if (['no', 'n', 'skip', 'nope', 'nah'].includes(normalized)) {
        return 'no';
    }
    return null;
}

async function askGroq(step, input) {
    const client = getGroqClient();
    if (!client) return null;

    try {
        const completion = await client.chat.completions.create({
            model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
            temperature: 0.1,
            max_tokens: 120,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: [
                        'You extract registration intent from messy WhatsApp replies.',
                        'Return strict JSON only.',
                        'For step=name return {"type":"name","value":"..."} or {"type":"unknown"}.',
                        'For step=age return {"type":"age","value":17} or {"type":"unknown"}.',
                        'For step=gender return {"type":"gender","value":"male"} or {"type":"gender","value":"female"} or {"type":"unknown"}.', // FIXED: registration gender ai extraction
                        'For step=bio_choice return {"type":"bio_choice","value":"yes"} or {"type":"bio_choice","value":"no"} or {"type":"unknown"}.',
                        'For step=bio_text return {"type":"bio","value":"..."} or {"type":"unknown"}.',
                        'Never invent details.'
                    ].join(' ')
                },
                {
                    role: 'user',
                    content: JSON.stringify({ step, input })
                }
            ]
        });

        const content = completion.choices?.[0]?.message?.content;
        if (!content) return null;
        return JSON.parse(content);
    } catch {
        return null;
    }
}

async function resolveName(input) {
    const heuristic = cleanNameCandidate(input);
    if (heuristic) return heuristic.slice(0, 30);

    const ai = await askGroq('name', input);
    if (ai?.type === 'name' && ai.value) {
        const cleaned = cleanNameCandidate(ai.value);
        if (cleaned) return cleaned.slice(0, 30);
    }
    return null;
}

async function resolveAge(input) {
    const heuristic = parseAge(input);
    if (heuristic) return heuristic;

    const ai = await askGroq('age', input);
    const value = ai?.type === 'age' ? ai.value : null;
    return parseAge(value);
}

async function resolveGender(input) {
    const heuristic = parseGender(input);
    if (heuristic) return heuristic;

    const ai = await askGroq('gender', input);
    if (ai?.type === 'gender' && ['male', 'female'].includes(ai.value)) {
        return ai.value;
    }
    return null;
}

async function resolveBioChoice(input) {
    const heuristic = parseBioChoice(input);
    if (heuristic) return heuristic;

    const ai = await askGroq('bio_choice', input);
    if (ai?.type === 'bio_choice' && ['yes', 'no'].includes(ai.value)) {
        return ai.value;
    }
    return null;
}

async function resolveBio(input) {
    const text = normalizeSpacing(input).slice(0, 80);
    if (text) return text;

    const ai = await askGroq('bio_text', input);
    if (ai?.type === 'bio' && ai.value) {
        return normalizeSpacing(ai.value).slice(0, 80);
    }
    return '';
}

function formatProfileOutput(profile, bonus = 0) {
    const lines = [
        '> *WISTORIA PROFILE CREATED*',
        '',
        `*${profile.name}* [${profile.userId}]`, // FIXED: register output unicode cleanup
        '',
        profile.bio ? `"${profile.bio}"` : '"..."',
        '',
        `age: ${profile.age}`,
        `gender: ${String(profile.gender || 'male')}`, // FIXED: registration gender summary
        '',
        'network: Wistoria',
        'card: starter',
        '',
        'status: active'
    ];

    if (bonus > 0) {
        lines.push('');
        lines.push(`bonus: ¥${bonus.toLocaleString()} added`);
    }

    return lines.join('\n');
}

async function startRegisterCommand(sock, chatId, message, senderId) {
    const candidates = getRegisterCandidates(message, senderId);
    const registeredJid = resolveRegisteredJid(candidates);
    const existing = getRegisteredProfile(registeredJid || senderId);
    if (existing) {
        for (const candidate of candidates) {
            clearState(candidate);
        }
        await sock.sendMessage(chatId, {
            text: [
                'you are already registered.',
                '',
                `name: ${existing.name}`,
                `age: ${existing.age}`,
                `gender: ${String(existing.gender || 'male')}`,
                existing.bio ? `bio: ${existing.bio}` : 'bio: ...'
            ].join('\n'),
            mentions: [senderId]
        }, { quoted: message });
        return;
    }

    const state = loadRegistrationState();
    const stateKey = candidates.find((value) => value.endsWith('@lid')) || senderId;
    state.users[stateKey] = {
        step: 'name',
        data: {},
        invalidAgeCount: 0,
        chatId,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    saveRegistrationState(state);

    await sock.sendMessage(chatId, {
        text: [
            '> *WISTORIA INIT*',
            '',
            'let\'s set up your profile.',
            '',
            'what\'s your name?'
        ].join('\n')
    }, { quoted: message });
}

async function handleRegisterReply(sock, chatId, message, senderId, rawText) {
    const input = String(rawText || '').trim();
    if (!input) {
        logRegisterSkip('empty-input', { chatId, senderId });
        return false;
    }
    if (input.startsWith('.') || /^(cancel|stop|exit|abort)$/i.test(input)) {
        if (/^(cancel|stop|exit|abort)$/i.test(input)) {
            const candidates = getRegisterCandidates(message, senderId);
            const state = loadRegistrationState();
            const stateKey = resolveStateKey(state, candidates) || senderId;
            if (state.users[stateKey]) {
                delete state.users[stateKey];
                saveRegistrationState(state);
                await sock.sendMessage(chatId, { text: 'Registration cancelled.' }, { quoted: message });
                return true;
            }
        }
        logRegisterSkip('command-input', { chatId, senderId, input });
        return false;
    }

    const state = loadRegistrationState();
    const candidates = getRegisterCandidates(message, senderId);
    const stateKey = resolveStateKey(state, candidates) || senderId;
    const current = state.users[stateKey];
    if (!current) {
        logRegisterSkip('no-active-state', { chatId, senderId, candidates });
        return false;
    }

    // Strict check: if the user is replying to someone else, don't capture it as registration data
    // But if they're replying to the BOT's message (e.g. "what's your name?"), that's fine
    const contextInfo = getMessageContextInfo(message) || message?.message?.extendedTextMessage?.contextInfo || {};
    const quotedParticipant = String(contextInfo.participant || contextInfo.remoteJid || '');
    const quotedNumber = quotedParticipant.split('@')[0].split(':')[0].replace(/\D/g, '');

    const botIdentifiers = new Set();
    const addBotId = (value) => {
        const digits = String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
        if (digits) botIdentifiers.add(digits);
    };
    addBotId(sock.user?.id);
    addBotId(sock.user?.lid);
    addBotId(sock.user?.jid);

    const quotedFromMe = Boolean(contextInfo?.fromMe || contextInfo?.quotedMessage?.key?.fromMe);
    const quotedIsBot = quotedFromMe || (quotedNumber && botIdentifiers.has(quotedNumber));

    if (quotedParticipant && quotedNumber && !quotedIsBot) {
        logRegisterSkip('quoted-other', { senderId, quotedParticipant, botIds: [...botIdentifiers], quotedNumber });
        return false;
    }

    const now = Date.now();

    if (
        Number(current.createdAt || 0) > 0 &&
        now - Number(current.updatedAt || current.createdAt || 0) > REGISTRATION_STATE_TTL_MS
    ) {
        delete state.users[stateKey];
        saveRegistrationState(state);
        logRegisterSkip('state-expired', { chatId, senderId, stateKey });
        return false;
    }

    if (current.chatId && current.chatId !== chatId) {
        logRegisterSkip('chat-mismatch', { chatId, senderId, stateChatId: current.chatId, stateKey });
        return false;
    }

    current.updatedAt = now;

    if (current.step === 'name') {
        const name = await resolveName(input);

        if (/\?|how old|who are|what is/i.test(input) || !name) {
            logRegisterSkip('invalid-name-likely-query', { chatId, senderId, input });
            return false;
        }

        current.data.name = name;
        current.step = 'age';
        current.invalidAgeCount = 0;
        current.updatedAt = Date.now();
        saveRegistrationState(state);

        await sock.sendMessage(chatId, {
            text: [
                'how old are you?',
                '',
                '(5-100)'
            ].join('\n')
        }, { quoted: message });
        return true;
    }

    if (current.step === 'age') {
        const age = await resolveAge(input);
        if (!age) {
            current.invalidAgeCount = Number(current.invalidAgeCount || 0) + 1;
            saveRegistrationState(state);

            await sock.sendMessage(chatId, {
                text: current.invalidAgeCount > 1
                    ? 'send your age like `17`'
                    : [
                        'how old are you?',
                        '',
                        '(5-100)'
                    ].join('\n')
            }, { quoted: message });
            return true;
        }

        current.data.dob = '';
        current.data.age = age;
        current.step = 'gender'; // FIXED: registration gender step
        current.invalidAgeCount = 0;
        current.updatedAt = Date.now();
        saveRegistrationState(state);

        await sock.sendMessage(chatId, {
            text: [
                'what is your gender?',
                '',
                'reply with `male` or `female`'
            ].join('\n')
        }, { quoted: message });
        return true;
    }

    if (current.step === 'gender') {
        const gender = await resolveGender(input);
        if (!gender) {
            await sock.sendMessage(chatId, {
                text: 'reply with `male` or `female`.'
            }, { quoted: message });
            return true;
        }

        current.data.gender = gender; // FIXED: registration gender capture
        current.step = 'bio_choice';
        current.updatedAt = Date.now();
        saveRegistrationState(state);

        await sock.sendMessage(chatId, {
            text: [
                'do you want to add a bio?',
                '',
                'you can skip if you want.'
            ].join('\n')
        }, { quoted: message });
        return true;
    }

    if (current.step === 'bio_choice') {
        const choice = await resolveBioChoice(input);
        if (choice === 'yes') {
            current.step = 'bio_text';
            current.updatedAt = Date.now();
            saveRegistrationState(state);
            await sock.sendMessage(chatId, {
                text: [
                    'write something about yourself.',
                    '',
                    '(keep it short)'
                ].join('\n')
            }, { quoted: message });
            return true;
        }

        if (choice === 'no') {
            const result = finalizeProfile(stateKey, current.data, candidates);
            delete state.users[stateKey];
            saveRegistrationState(state);
            await sendRegisterComplete(sock, chatId, message, senderId, result);
            return true;
        }

        await sock.sendMessage(chatId, {
            text: 'reply with `yes` to add a bio or `skip` / `no` to finish registration.'
        }, { quoted: message });
        return true;
    }

    if (current.step === 'bio_text') {
        current.data.bio = await resolveBio(input);
        current.updatedAt = Date.now();
        const result = finalizeProfile(stateKey, current.data, candidates);
        delete state.users[stateKey];
        saveRegistrationState(state);
        await sendRegisterComplete(sock, chatId, message, senderId, result);
        return true;
    }

    return false;
}

function finalizeProfile(jid, data, candidates = []) {
    console.log(`[register finalizeProfile] jid: ${jid}, candidates: ${candidates.join(', ')}`);
    const identity = resolveRegisteredJid([jid, ...candidates]) || jid;
    console.log(`[register finalizeProfile] resolved identity: ${identity}`);
    const existing = getRegisteredProfile(identity);
    const profile = upsertRegisteredProfile(identity, data);
    console.log(`[register finalizeProfile] linking aliases for ${profile.jid} with candidates: ${candidates.join(', ')}`);
    linkProfileAliases(identity, profile.jid, ...candidates);

    let bonus = 0;
    if (!existing) {
        addBalance(profile.jid, REGISTER_BONUS, { awardXp: false, force: true });
        bonus = REGISTER_BONUS;
    }

    return { profile, bonus };
}

async function sendRegisterComplete(sock, chatId, message, senderId, result) {
    const profile = result?.profile || result;
    const bonus = Number(result?.bonus || 0);
    let avatarUrl = null;
    try {
        avatarUrl = await sock.profilePictureUrl(senderId, 'image');
    } catch {}

    try {
        const image = await generateRegisterCard({
            name: profile.name,
            userId: profile.userId,
            dob: profile.dob,
            age: profile.age,
            gender: profile.gender, // FIXED: register card gender theme
            bio: profile.bio || 'new recruit',
            avatarUrl,
            network: profile.network,
            cardType: profile.card,
            status: profile.status
        });

        await sock.sendMessage(chatId, {
            image,
            mimetype: 'image/png',
            caption: formatProfileOutput(profile, bonus),
            mentions: [senderId]
        }, { quoted: message });
        return;
    } catch (error) {
        console.error('[register] image generation failed:', error.message);
    }

    await sock.sendMessage(chatId, { text: formatProfileOutput(profile, bonus) }, { quoted: message });
}

module.exports = {
    startRegisterCommand,
    handleRegisterReply,
    getRegisteredProfile,
    clearState,
    formatProfileOutput
};
