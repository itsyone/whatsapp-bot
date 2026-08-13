const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const DATA_PATH = path.join(__dirname, '..', 'data', 'genshin_characters.json');
const QUERY_SCRIPT_PATH = fs.existsSync(path.join(process.cwd(), 'scripts', 'genshin-query.js'))
    ? path.join(process.cwd(), 'scripts', 'genshin-query.js')
    : path.join(process.cwd(), 'wa-bot-live', 'scripts', 'genshin-query.js');
const execFileAsync = promisify(execFile);

const START_THUMB = 'https://files.catbox.moe/wl2mh2.png';
const LOCKED_BUILD_THUMB = 'https://files.catbox.moe/oxye6j.png';

const FULL_NAME_OVERRIDES = {
    kazuha: 'Kaedehara Kazuha',
    ayaka: 'Kamisato Ayaka',
    ayato: 'Kamisato Ayato',
    hutao: 'Hu Tao',
    raiden: 'Raiden Shogun',
    sara: 'Kujou Sara',
    kokomi: 'Sangonomiya Kokomi',
    heizou: 'Shikanoin Heizou',
    shinobu: 'Kuki Shinobu',
    itto: 'Arataki Itto',
    yaemiko: 'Yae Miko',
    yunjin: 'Yun Jin'
};

const BOSS_BY_MATERIAL = {
    'Marionette Core': 'Maguu Kenki',
    'Basalt Pillar': 'Geo Hypostasis',
    'Hoarfrost Core': 'Cryo Regisvine',
    'Hurricane Seed': 'Anemo Hypostasis',
    'Lightning Prism': 'Electro Hypostasis',
    'Cleansing Heart': 'Oceanid',
    'Juvenile Jade': 'Primo Geovishap',
    'Crystalline Bloom': 'Cryo Hypostasis',
    'Dew of Repudiation': 'Hydro Hypostasis',
    'Perpetual Caliber': 'Aeonblight Drake',
    'Majestic Hooked Beak': 'Jadeplume Terrorshroom',
    'Light Guiding Tetrahedron': 'Algorithm of Semi-Intransient Matrix of Overseer Network',
    'Quelled Creeper': 'Dendro Hypostasis',
    'Pseudo-Stamens': 'Setekh Wenut',
    'Evergloom Ring': 'Iniquitous Baptist',
    "Emperor's Resolution": 'Emperor of Fire and Iron',
    'Fontemer Unihorn': 'Millennial Pearl Seahorse',
    'Tourbillon Device': 'Experimental Field Generator',
    'Water That Failed To Transcend': 'Hydro Tulpa',
    'Cloudseam Scale': 'Solitary Suanni',
    'Fragment of a Golden Melody': 'Legatus Golem',
    'Sparkless Statue Core': 'Secret Source Automaton: Configuration Device',
    'Talisman of the Enigmatic Land': 'Secret Source Automaton: Overseer Device',
    'Ensnaring Gaze': 'Tenebrous Papilla',
    'Mark of the Binding Blessing': 'Gluttonous Yumkasaur Mountain King',
    'Secret Source Airflow Accumulator': 'Secret Source Automaton: Hunter-Seeker',
    'Smoldering Pearl': 'Pyro Hypostasis',
    'Storm Beads': 'Thunder Manifestation',
    'Riftborn Regalia': 'Golden Wolflord',
    "Dragonheir's False Fin": 'Bathysmal Vishap Herd',
    'Runic Fang': 'Ruin Serpent',
    'Perpetual Heart': 'Perpetual Mechanical Array',
    'Thunderclap Fruitcore': 'Electro Regisvine',
    'Artificed Spare Clockwork Component - Coppelius': 'Icewind Suite',
    'Artificed Spare Clockwork Component - Coppelia': 'Icewind Suite',
    'Transoceanic Pearl': 'Fontemer Aberrants'
};

const GENERIC_WEAPONS = {
    Sword: ['Favonius Sword', 'Sacrificial Sword'],
    Bow: ['Favonius Warbow', 'Sacrificial Bow'],
    Claymore: ['Favonius Greatsword', 'Sacrificial Greatsword'],
    Polearm: ['Favonius Lance', 'The Catch'],
    Catalyst: ['Favonius Codex', 'Sacrificial Fragments']
};

const GENERIC_ARTIFACTS = {
    Anemo: ['Noblesse Oblige'],
    Geo: ['Noblesse Oblige'],
    Electro: ['Emblem of Severed Fate'],
    Hydro: ['Noblesse Oblige'],
    Pyro: ['Emblem of Severed Fate'],
    Cryo: ['Noblesse Oblige'],
    Dendro: ['Deepwood Memories']
};

function loadLocalData() {
    if (!fs.existsSync(DATA_PATH)) return {};

    try {
        return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function normalize(text = '') {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function toKey(text = '') {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function findLocalCharacter(data, query) {
    const all = Object.values(data || {});
    const needle = normalize(query);
    if (!needle) return null;

    return all.find((entry) => {
        const fullName = FULL_NAME_OVERRIDES[entry.key] || entry.name;
        return [
            entry.key,
            entry.slug,
            entry.name,
            fullName
        ].some((value) => normalize(value) === needle || normalize(value).includes(needle));
    }) || null;
}

function findCharacters(data, query) {
    const needle = normalize(query);
    return Object.values(data || {})
        .filter((entry) => {
            const fullName = FULL_NAME_OVERRIDES[entry.key] || entry.name;
            return [entry.key, entry.slug, entry.name, fullName].some((value) => normalize(value).includes(needle));
        })
        .slice(0, 10);
}

function stripTalentBookPrefix(name = '') {
    return String(name || '').replace(/^(Teachings|Guide|Philosophies) of /i, '').trim();
}

function cleanDesc(text = '') {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function shortDesc(text = '', limit = 110) {
    const value = cleanDesc(text);
    if (!value) return 'No data.';
    if (value.length <= limit) return value;
    return `${value.slice(0, limit - 1).trim()}…`;
}

function formatRarity(rarity) {
    const count = Number(rarity || 0);
    return count > 0 ? '★'.repeat(count) : 'Unknown';
}

function formatDays(days = []) {
    const short = {
        Monday: 'Mon',
        Tuesday: 'Tue',
        Wednesday: 'Wed',
        Thursday: 'Thu',
        Friday: 'Fri',
        Saturday: 'Sat',
        Sunday: 'Sun'
    };

    const filtered = days.filter((day) => day !== 'Sunday');
    const finalDays = filtered.length ? filtered : days;
    return finalDays.map((day) => short[day] || day.slice(0, 3)).join('/');
}

function pickAscensionMaterials(characterData) {
    const ascend2 = characterData?.costs?.ascend2 || [];
    return {
        gems: ascend2[1]?.name || null,
        boss: ascend2[2]?.name || null,
        specialty: ascend2[3]?.name || null,
        common: ascend2[4]?.name || null
    };
}

function pickTalentMaterials(talentData) {
    const lvl2 = talentData?.costs?.lvl2 || [];
    const lvl7 = talentData?.costs?.lvl7 || [];
    const lvl10 = talentData?.costs?.lvl10 || [];

    return {
        books: stripTalentBookPrefix(lvl2[1]?.name || ''),
        common: lvl2[2]?.name || null,
        weeklyBoss: lvl7[3]?.name || lvl10[3]?.name || null
    };
}

function mergeCharacterData(characterData, talentData, localCharacter) {
    const ascension = pickAscensionMaterials(characterData);
    const talents = pickTalentMaterials(talentData);
    const derivedKey = localCharacter?.key || toKey(characterData.name);
    const displayName = FULL_NAME_OVERRIDES[derivedKey] || localCharacter?.name || characterData.name;
    const mediaUrl = characterData.images?.hoyowiki_icon
        || characterData.images?.mihoyo_icon
        || localCharacter?.icon
        || localCharacter?.image
        || localCharacter?.portrait
        || null;

    return {
        key: derivedKey,
        name: characterData.name,
        displayName,
        title: characterData.title || null,
        element: characterData.elementText || localCharacter?.element || null,
        weapon: characterData.weaponText || localCharacter?.weapon || null,
        rarity: Number(characterData.rarity || localCharacter?.rarity || 0) || null,
        region: characterData.region || null,
        mediaUrl,
        tier: localCharacter?.tier || null,
        role: localCharacter?.role || null,
        build: localCharacter?.build || {},
        bestTeammates: localCharacter?.best_teammates || [],
        farming: {
            books: localCharacter?.farming?.books || talents.books || null,
            days: localCharacter?.farming?.days || [],
            weekly_boss: talents.weeklyBoss || localCharacter?.farming?.weekly_boss || null,
            boss: ascension.boss || localCharacter?.farming?.boss || null,
            specialty: ascension.specialty || localCharacter?.farming?.specialty || null,
            common: talents.common || ascension.common || localCharacter?.farming?.common || null,
            gems: ascension.gems || null
        },
        talents: {
            na: talentData?.combat1?.name || 'Normal Attack',
            naDesc: talentData?.combat1?.description || '',
            skill: talentData?.combat2?.name || 'Elemental Skill',
            skillDesc: talentData?.combat2?.description || '',
            burst: talentData?.combat3?.name || 'Elemental Burst',
            burstDesc: talentData?.combat3?.description || ''
        }
    };
}

async function queryDb(mode, query) {
    const { stdout } = await execFileAsync(process.execPath, [
        '--max-old-space-size=1024',
        QUERY_SCRIPT_PATH,
        mode,
        query
    ], {
        cwd: path.join(__dirname, '..'),
        timeout: 30000,
        maxBuffer: 1024 * 1024
    });

    return JSON.parse(String(stdout || '{}'));
}

async function fetchMergedCharacter(localData, query) {
    const payload = await queryDb('character', query);
    if (!payload?.characterData) return null;

    const localCharacter = findLocalCharacter(localData, payload.filename || payload.match || payload.characterData.name);
    return mergeCharacterData(payload.characterData, payload.talentData, localCharacter);
}

function buildCharText(character) {
    const bossMaterial = character.farming?.boss || '';
    const bossName = BOSS_BY_MATERIAL[bossMaterial] || bossMaterial || 'Unknown';
    const specialty = character.farming?.specialty || 'Unknown';
    const books = character.farming?.books || 'Unknown';
    const days = formatDays(character.farming?.days || []);

    return [
        '*❖ GENSHIN SYSTEM ❖*',
        '',
        `👤 *Name:* _${character.displayName || character.name}_`,
        `💠 *Element:* ${character.element || 'Unknown'}`,
        `⚔️ *Weapon:* ${character.weapon || 'Unknown'}`,
        `⭐ *Rarity:* ${formatRarity(character.rarity)}`,
        '',
        '*✦ STATS ✦*',
        `• Tier: *${character.tier || '?'}*`,
        `• Role: _${character.role || 'Unknown'}_`,
        '',
        '*✦ FARMING ✦*',
        `• Books: ${books}${days ? ` *(${days})*` : ''}`,
        `• Boss: ${bossName}`,
        `• Specialty: ${specialty}`
    ].join('\n');
}

function buildBuildText(character) {
    const build = character.build || {};
    const main = build.main_stats || {};
    const weaponList = [build.weapon, ...(GENERIC_WEAPONS[character.weapon] || [])]
        .filter(Boolean)
        .slice(0, 3);
    const artifactList = [build.artifact_name || build.artifacts, ...(GENERIC_ARTIFACTS[character.element] || [])]
        .filter(Boolean)
        .slice(0, 2);
    const note = character.role
        ? `${character.role} setup focused on consistent uptime.`
        : 'Prioritize comfort stats before min-maxing.';

    return [
        '*《🔷 BUILD 🔷》*',
        '',
        `👤 _${character.displayName}_`,
        '',
        '*⚔️ Weapons:*',
        `▸ ${weaponList[0] || 'Unknown'}`,
        `▸ ${weaponList[1] || 'Unknown'}`,
        `▸ ${weaponList[2] || 'Unknown'}`,
        '',
        '*🧿 Artifacts:*',
        `▸ ${artifactList[0] || 'Unknown'}`,
        `▸ ${artifactList[1] || 'Unknown'}`,
        '',
        '*📊 Main Stats:*',
        `▸ Sands: ${main.sands || 'Unknown'}`,
        `▸ Goblet: ${main.goblet || 'Unknown'}`,
        `▸ Circlet: ${main.circlet || 'Unknown'}`,
        '',
        `> ✨ Sub: ${build.substat_priority || 'CRIT > ATK% > ER'}`,
        `> 💡 Note: ${note}`
    ].join('\n');
}

function buildTeamText(character) {
    const team = character.bestTeammates || [];
    return [
        '*《🔷 TEAM 🔷》*',
        '',
        `👤 _${character.displayName}_`,
        '',
        `▸ DPS: ${team[0] || 'Unknown'}`,
        `▸ Sub: ${team[1] || 'Unknown'}`,
        `▸ Support: ${team[2] || 'Unknown'}`,
        `▸ Heal: ${team[3] || 'Unknown'}`,
        '',
        `> ⚡ Synergy: ${character.element || 'Element'} reaction / buff core`,
        `> 💡 Tip: Swap supports first, then bring ${character.displayName.split(' ')[0]} in for field time.`
    ].join('\n');
}

function buildAscensionText(character) {
    const bossMaterial = character.farming?.boss || '';
    const bossName = BOSS_BY_MATERIAL[bossMaterial] || bossMaterial || 'Unknown';
    return [
        '*《🔷 ASCENSION 🔷》*',
        '',
        `👤 _${character.displayName}_`,
        '',
        `▸ Boss: ${bossName}`,
        `▸ Specialty: ${character.farming?.specialty || 'Unknown'}`,
        `▸ Common: ${character.farming?.common || 'Unknown'}`,
        `▸ Gems: ${character.farming?.gems || 'Unknown'}`,
        '',
        `> 💡 Tip: Farm the boss and local specialty together to save resin and route time.`
    ].join('\n');
}

function buildTalentsText(character) {
    return [
        '*《🔷 TALENTS 🔷》*',
        '',
        `👤 *${character.displayName}*`,
        '',
        `▸ NA: ${shortDesc(character.talents?.naDesc || character.talents?.na)}`,
        `▸ Skill: ${shortDesc(character.talents?.skillDesc || character.talents?.skill)}`,
        `▸ Burst: ${shortDesc(character.talents?.burstDesc || character.talents?.burst)}`,
        '',
        `> 💡 Priority: Skill > Burst`
    ].join('\n');
}

function buildWeaponText(weapon, bestChars = []) {
    return [
        '*《🔷 WEAPON 🔷》*',
        '',
        `⚔️ _${weapon.name || 'Unknown'}_ ${formatRarity(weapon.rarity)}`,
        `${weapon.baseStatText || Math.round(Number(weapon.baseAtkValue || 0)) || 'Unknown'} ATK | Sub: ${weapon.mainStatText || 'None'}`,
        '',
        `▸ Passive: ${shortDesc(weapon.r1?.description || weapon.effectName || weapon.description || 'No data.', 120)}`,
        '',
        `> 💡 Best: ${bestChars.length ? bestChars.join(', ') : 'Flexible sword/bow/catalyst users'}`
    ].join('\n');
}

function buildArtifactText(artifact, bestChars = []) {
    return [
        '*《🔷 ARTIFACT 🔷》*',
        '',
        `🧿 _${artifact.name || 'Unknown'}_`,
        '',
        `▸ 2pc: ${artifact.effect2Pc || 'No data'}`,
        `▸ 4pc: ${artifact.effect4Pc || 'No data'}`,
        '',
        `> 💡 Best: ${bestChars.length ? bestChars.join(', ') : 'Element-focused carries and supports'}`
    ].join('\n');
}

function buildHelpText() {
    return [
        '*《🔷 GENSHIN HELP 🔷》*',
        '',
        '*Basics:*',
        '▸ .gi build [name]',
        '▸ .gi team [name]',
        '',
        '*Gear:*',
        '▸ .gi weapon [name]',
        '▸ .gi artifact [name]',
        '',
        '*Progress:*',
        '▸ .gi ascension [name]',
        '▸ .gi talents [name]',
        '',
        '*Advanced:*',
        '▸ .gi tier',
        '▸ .gi search [name]'
    ].join('\n');
}

function buildStartText() {
    return [
        '*《🔷 GENSHIN GUIDE 🔷》*',
        '',
        '🌿 Welcome, Traveler!',
        '',
        'Start here:',
        '',
        '▸ .gi build [name]',
        '▸ .gi team [name]',
        '▸ .gi help'
    ].join('\n');
}

function buildTierText(localData) {
    const top = Object.values(localData || {})
        .filter((entry) => String(entry.tier || '').toUpperCase() === 'S')
        .slice(0, 12)
        .map((entry) => `▸ ${FULL_NAME_OVERRIDES[entry.key] || entry.name}`);

    return [
        '*《🔷 GENSHIN TIER 🔷》*',
        '',
        ...(top.length ? top : ['▸ No tier data found']),
        '',
        '> 💡 Note: Based on the local build dataset in this bot.'
    ].join('\n');
}

function buildSearchText(matches) {
    return [
        '*《🔷 SEARCH 🔷》*',
        '',
        ...matches.map((entry) => `▸ ${FULL_NAME_OVERRIDES[entry.key] || entry.name}`),
        '',
        '> 💡 Tip: Use one of these names with `.gi char` or `.gi build`.'
    ].join('\n');
}

function bestCharsForWeapon(localData, weaponName) {
    return Object.values(localData || {})
        .filter((entry) => normalize(entry?.build?.weapon) === normalize(weaponName))
        .slice(0, 4)
        .map((entry) => FULL_NAME_OVERRIDES[entry.key] || entry.name);
}

function bestCharsForArtifact(localData, artifactName) {
    return Object.values(localData || {})
        .filter((entry) => normalize(entry?.build?.artifact_name || entry?.build?.artifacts) === normalize(artifactName))
        .slice(0, 4)
        .map((entry) => FULL_NAME_OVERRIDES[entry.key] || entry.name);
}

function buildReply(text, thumbnailUrl, title, body) {
    return {
        text,
        contextInfo: {
            externalAdReply: {
                title: title || 'GENSHIN',
                body: body || 'guides and builds',
                mediaType: 1,
                mediaUrl: thumbnailUrl || '',
                renderLargerThumbnail: false,
                showAdAttribution: false,
                sourceUrl: '',
                thumbnailUrl: thumbnailUrl || ''
            }
        }
    };
}

async function handleCharacterStyle(sock, chatId, message, localData, query, mode) {
    const character = await fetchMergedCharacter(localData, query);
    if (!character) {
        await sock.sendMessage(chatId, {
            text: `No Genshin character found for \`${query}\`.`
        }, { quoted: message });
        return;
    }

    if (mode === 'build' && String(character.tier || '').toUpperCase() === 'S') {
        await sock.sendMessage(
            chatId,
            buildReply(
                '🔒 *Locked*\n\n> S Tier builds unlock later.',
                LOCKED_BUILD_THUMB,
                'LOCKED',
                'S Tier builds unlock later'
            ),
            { quoted: message }
        );
        return;
    }

    let text = '';
    if (mode === 'char') text = buildCharText(character);
    if (mode === 'build') text = buildBuildText(character);
    if (mode === 'team') text = buildTeamText(character);
    if (mode === 'ascension') text = buildAscensionText(character);
    if (mode === 'talents') text = buildTalentsText(character);

    await sock.sendMessage(
        chatId,
        buildReply(
            text,
            character.mediaUrl,
            character.displayName,
            `${character.element || 'Unknown'} • ${character.weapon || 'Unknown'}`
        ),
        { quoted: message }
    );
}

async function handleWeapon(sock, chatId, message, localData, query) {
    const character = findLocalCharacter(localData, query);
    const weaponQuery = character?.build?.weapon || query;
    const weaponPayload = await queryDb('weapon', weaponQuery);
    const weapon = weaponPayload?.weaponData;

    if (!weapon) {
        await sock.sendMessage(chatId, { text: `No weapon found for \`${query}\`.` }, { quoted: message });
        return;
    }

    const bestChars = bestCharsForWeapon(localData, weapon.name);
    const thumb = weapon.images?.mihoyo_icon || weapon.images?.icon || character?.build?.weapon_image || '';
    await sock.sendMessage(
        chatId,
        buildReply(
            buildWeaponText(weapon, bestChars),
            thumb,
            weapon.name,
            'weapon details'
        ),
        { quoted: message }
    );
}

async function handleArtifact(sock, chatId, message, localData, query) {
    const character = findLocalCharacter(localData, query);
    const artifactQuery = character?.build?.artifact_name || query;
    const artifactPayload = await queryDb('artifact', artifactQuery);
    const artifact = artifactPayload?.artifactData;

    if (!artifact) {
        await sock.sendMessage(chatId, { text: `No artifact found for \`${query}\`.` }, { quoted: message });
        return;
    }

    const bestChars = bestCharsForArtifact(localData, artifact.name);
    const thumb = artifact.images?.flower || character?.build?.artifact_image || '';
    await sock.sendMessage(
        chatId,
        buildReply(
            buildArtifactText(artifact, bestChars),
            thumb,
            artifact.name,
            'artifact details'
        ),
        { quoted: message }
    );
}

async function giCommand(sock, chatId, message, rawText = '') {
    try {
        const localData = loadLocalData();
        const parts = String(rawText || '').trim().split(/\s+/).filter(Boolean);
        const subcommand = String(parts[1] || '').toLowerCase();
        const query = parts.slice(2).join(' ').trim();

        if (!subcommand) {
            await sock.sendMessage(
                chatId,
                buildReply(
                    '*《🔷 GENSHIN 🔷》*\n\nWelcome Traveler ✨\n\nStart here:\n▸ .gi start',
                    START_THUMB,
                    'GENSHIN',
                    'starter guide'
                ),
                { quoted: message }
            );
            return;
        }

        if (subcommand === 'start') {
            await sock.sendMessage(chatId, buildReply(buildStartText(), START_THUMB, 'GENSHIN GUIDE', 'welcome traveler'), { quoted: message });
            return;
        }

        if (subcommand === 'help') {
            await sock.sendMessage(chatId, buildReply(buildHelpText(), START_THUMB, 'GENSHIN HELP', 'commands'), { quoted: message });
            return;
        }

        if (subcommand === 'tier') {
            await sock.sendMessage(chatId, buildReply(buildTierText(localData), START_THUMB, 'GENSHIN TIER', 'meta snapshot'), { quoted: message });
            return;
        }

        if (subcommand === 'search' && query) {
            const matches = findCharacters(localData, query);
            await sock.sendMessage(
                chatId,
                buildReply(
                    matches.length ? buildSearchText(matches) : `No Genshin results found for \`${query}\`.`,
                    START_THUMB,
                    'GENSHIN SEARCH',
                    'search results'
                ),
                { quoted: message }
            );
            return;
        }

        if (['char', 'build', 'team', 'ascension', 'talent', 'talents'].includes(subcommand)) {
            if (!query) {
                await sock.sendMessage(chatId, { text: `Use \`.gi ${subcommand} <name>\`.` }, { quoted: message });
                return;
            }
            await handleCharacterStyle(sock, chatId, message, localData, query, subcommand === 'talent' ? 'talents' : subcommand);
            return;
        }

        if (subcommand === 'weapon') {
            if (!query) {
                await sock.sendMessage(chatId, { text: 'Use `.gi weapon <name>`.' }, { quoted: message });
                return;
            }
            await handleWeapon(sock, chatId, message, localData, query);
            return;
        }

        if (subcommand === 'artifact') {
            if (!query) {
                await sock.sendMessage(chatId, { text: 'Use `.gi artifact <name>`.' }, { quoted: message });
                return;
            }
            await handleArtifact(sock, chatId, message, localData, query);
            return;
        }

        await sock.sendMessage(chatId, {
            text: 'Use `.gi start` or `.gi help`.'
        }, { quoted: message });
    } catch (error) {
        console.error('[gi] error:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: 'Failed to load Genshin data.'
        }, { quoted: message });
    }
}





module.exports = {
  name: 'gi',
  async execute(ctx) {
    return giCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.rawText || null);
  }
};
