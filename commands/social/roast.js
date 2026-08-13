const Groq = require('groq-sdk');
const {
    loadMemory,
    saveMemory,
    getUserMemory
} = require('../../services/chatbot/memoryStore');
const { pickRelevantMemory } = require('../../services/chatbot/memoryRetrieval');
const { normalizeJid } = require('../../utils/jid');

let groqClient = null;

function getGroqClient() {
    const apiKey = String(process.env.GROQ_API_KEY || '').trim();
    if (!apiKey) return null;
    if (!groqClient) {
        groqClient = new Groq({
            apiKey,
            dangerouslyAllowBrowser: true
        });
    }
    return groqClient;
}

function extractTarget(message) {
    const context = message?.message?.extendedTextMessage?.contextInfo || {};
    const mentioned = Array.isArray(context.mentionedJid) ? context.mentionedJid : [];

    if (mentioned.length > 0) return mentioned[0];
    if (context.participant) return context.participant;
    return '';
}

function compactWords(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function wordCount(value) {
    return compactWords(value).split(' ').filter(Boolean).length;
}

function clampRoastWords(value, minWords = 20, maxWords = 60) {
    const cleaned = compactWords(value)
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/\s+([,.!?])/g, '$1');

    const words = cleaned.split(' ').filter(Boolean);
    if (!words.length) return '';

    if (words.length > maxWords) {
        return `${words.slice(0, maxWords).join(' ').replace(/[,.!?;:]+$/g, '')}.`;
    }

    if (words.length < minWords) {
        return '';
    }

    return cleaned;
}

function ensureMentionPrefix(targetHandle, text) {
    const cleaned = compactWords(text);
    if (!cleaned) return '';
    if (cleaned.toLowerCase().startsWith(`@${String(targetHandle || '').toLowerCase()}`)) {
        return cleaned;
    }
    return `@${targetHandle} ${cleaned}`;
}

function formatBehaviorTraits(behavior) {
    if (!behavior || typeof behavior !== 'object') return '';
    const traits = [];
    if (behavior.toxic > 0.6) traits.push('very toxic');
    else if (behavior.toxic > 0.3) traits.push('toxic');
    
    if (behavior.funny > 0.6) traits.push('comedian');
    else if (behavior.funny > 0.3) traits.push('funny');
    
    if (behavior.dry > 0.6) traits.push('extremely dry');
    else if (behavior.dry > 0.3) traits.push('boring/dry');
    
    if (behavior.horny > 0.6) traits.push('down bad/horny');
    
    return traits.join(', ');
}

function strongestMemoryBits(memory) {
    const relevant = pickRelevantMemory(memory || {}, 'roast this person using stored memory and old jokes', 'roast');
    const facts = Array.isArray(relevant?.facts)
        ? relevant.facts.map((item) => item?.text).filter(Boolean).slice(0, 4)
        : [];
    const jokes = Array.isArray(relevant?.jokes)
        ? relevant.jokes.map((item) => item?.text).filter(Boolean).slice(0, 3)
        : [];

    return { facts, jokes };
}

function buildMemorySummary(memory) {
    const strongest = strongestMemoryBits(memory);
    const nicknames = Array.isArray(memory?.nicknames) ? memory.nicknames.filter(Boolean).slice(-3) : [];
    const topics = memory?.topics && typeof memory.topics === 'object'
        ? Object.entries(memory.topics)
            .filter(([, value]) => Number(value || 0) > 0.5)
            .sort((a, b) => Number(b[1]) - Number(a[1]))
            .slice(0, 4)
            .map(([key]) => key)
        : [];
    return {
        name: memory?.name || '',
        mood: memory?.mood?.current || 'neutral',
        facts: strongest.facts,
        jokes: strongest.jokes,
        nicknames,
        topics,
        behavior: memory?.behavior || {},
        relationship: memory?.relationship || {},
        likesRoasts: Boolean(memory?.preferences?.likes_roasts)
    };
}

function fallbackRoast(targetHandle, memory) {
    const strongest = strongestMemoryBits(memory);
    if (!strongest.jokes.length && !strongest.facts.length) {
        return `@${targetHandle} you genuinely have nothing going on and somehow still act like the smartest person in the chat, its actually impressive how consistent you are at being wrong.`;
    }
    // If we have facts but the AI failed, we just return empty to trigger the unhinged hard fallback
    return '';
}

async function generateRoast(targetHandle, summary, quotedText) {
    const client = getGroqClient();
    if (!client) {
        throw new Error('GROQ_API_KEY missing');
    }

    const memoryBits = [
        summary.name ? `name=${summary.name}` : '',
        summary.mood ? `mood=${summary.mood}` : '',
        summary.facts.length ? `facts=${summary.facts.join('; ')}` : '',
        summary.jokes.length ? `running_jokes=${summary.jokes.join('; ')}` : '',
        summary.nicknames.length ? `nicknames=${summary.nicknames.join('; ')}` : '',
        summary.topics.length ? `topics=${summary.topics.join('; ')}` : '',
        formatBehaviorTraits(summary.behavior) ? `personality_traits=${formatBehaviorTraits(summary.behavior)}` : '',
        summary.relationship ? `rel_level=${summary.relationship.level}` : '',
        `likes_roasts=${summary.likesRoasts ? 'true' : 'false'}`
    ].filter(Boolean).join(' | ');
    
    if (memoryBits) {
        console.log(`[roast] Memory for @${targetHandle}: ${memoryBits}`);
    } else {
        console.log(`[roast] No memory found for @${targetHandle}`);
    }

    const completion = await client.chat.completions.create({
        model: String(process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim(),
        temperature: 1,
        max_tokens: 300,
        messages: [
            {
                role: 'system',
                content: [
                    'You are a real person in a WhatsApp group chat roasting your friend.',
                    'Write exactly like someone texting — lowercase is fine, natural flow, no perfect grammar.',
                    'Sound mean but like a FRIEND being mean, not a robot listing insults.',
                    'Never use words like "attempt", "endeavor", "furthermore", "moreover".',
                    'Never stack adjectives like "dry and mid and embarrassing" — pick ONE angle and go deep on it.',
                    'Use memory facts to make it specific. Specific = funny. Generic = cringe.',
                    'Do NOT rhyme. Do NOT use a punchline structure. Just talk.',
                    'Start with @handle then just go in naturally.',
                    'Strictly 30 to 60 words. One paragraph. No lists.',
                    'Minimum 30 words, maximum 60 words. Never write less than 30 words.',
                    'If your first sentence is short, add a second sentence continuing the same angle.'
                ].join(' ')
            },
            {
                role: 'user',
                content: [
                    `Target handle: @${targetHandle}`,
                    memoryBits ? `Database memory: ${memoryBits}` : 'Database memory: none',
                    quotedText ? `Recent target text: ${quotedText}` : 'Recent target text: none',
                    'Pick ONE thing from memory or their recent text. Exaggerate it. Sound like a fed up friend not a robot.',
                    'Return only the roast. No explanation.'
                ].join('\n')
            }
        ]
    });

    const raw = completion?.choices?.[0]?.message?.content || '';
    console.log(`[roast] raw output: "${raw}"`);
    console.log(`[roast] word count: ${wordCount(raw)}`);
    return raw;
}

async function roastCommand(sock, chatId, message) {
    try {
        const targetJid = extractTarget(message);
        if (!targetJid) {
            await sock.sendMessage(chatId, {
                text: 'Mention someone or reply to their message with `.roast`.'
            }, { quoted: message });
            return;
        }

        const normalizedTarget = normalizeJid(targetJid);
        const targetHandle = normalizedTarget.split('@')[0];
        const quotedText = compactWords(
            message?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
            message?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text ||
            message?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage?.caption ||
            message?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage?.caption ||
            ''
        ).slice(0, 220);

        const db = loadMemory();
        const memory = getUserMemory(db, targetHandle);
        memory.preferences = memory.preferences || {};
        memory.preferences.likes_roasts = true;
        memory.updatedAt = Date.now();
        db[targetHandle] = memory;
        saveMemory(db, targetHandle);

        const summary = buildMemorySummary(memory);
        if (!summary.name) {
            summary.name = message.pushName || '';
        }
        let roast = ensureMentionPrefix(
            targetHandle,
            clampRoastWords(await generateRoast(targetHandle, summary, quotedText), 20, 60)
        );

        if (!roast) {
            roast = fallbackRoast(targetHandle, memory);
        }

        if (!roast || wordCount(roast) < 15) {
            roast = `@${targetHandle} you move like a loading screen with attitude, loud for no reason, wrong on instinct, and somehow still acting like the room owes you applause for surviving basic conversation. Just stop typing honestly.`;
        }

        await sock.sendMessage(chatId, {
            text: roast,
            mentions: [normalizedTarget]
        }, { quoted: message });
    } catch (error) {
        console.error('[roast] error:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: 'Roast failed right now. Try again in a bit.'
        }, { quoted: message });
    }
}





module.exports = {
    name: 'roast',
    async execute(ctx) {
        return roastCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null);
    }
};
