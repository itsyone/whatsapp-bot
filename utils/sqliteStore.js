const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { clone, readJsonSafe, writeJsonSafe } = require('./jsonStore');

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'bot.sqlite');
const PROFILE_PATH = path.join(DATA_DIR, 'registrationProfiles.json');
const STATE_PATH = path.join(DATA_DIR, 'registrationStates.json');
const MEMORY_PATH = path.join(DATA_DIR, 'memory.json');

let dbInstance = null;

function ensureDataDir() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getDb() {
    if (dbInstance) return dbInstance;

    ensureDataDir();
    dbInstance = new Database(DB_PATH);
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('synchronous = NORMAL');
    dbInstance.pragma('foreign_keys = ON');
    initializeSchema(dbInstance);
    migrateLegacyJson(dbInstance);
    return dbInstance;
}

function initializeSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS storage_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS registration_profiles (
            canonical_jid TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS registration_aliases (
            alias_jid TEXT PRIMARY KEY,
            canonical_jid TEXT NOT NULL,
            FOREIGN KEY (canonical_jid) REFERENCES registration_profiles(canonical_jid) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS registration_states (
            jid TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chatbot_memory (
            user_id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);
}

function getMeta(db, key) {
    const row = db.prepare('SELECT value FROM storage_meta WHERE key = ?').get(key);
    return row ? String(row.value || '') : '';
}

function setMeta(db, key, value) {
    db.prepare(`
        INSERT INTO storage_meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value || ''));
}

function countRows(db, tableName) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get();
    return Number(row?.count || 0);
}

function migrateLegacyJson(db) {
    migrateRegistrationProfiles(db);
    migrateRegistrationStates(db);
    migrateChatbotMemory(db);
}

function migrateRegistrationProfiles(db) {
    const alreadyImported = getMeta(db, 'registration_profiles_imported') === '1';
    if (alreadyImported || countRows(db, 'registration_profiles') > 0) {
        if (!alreadyImported) setMeta(db, 'registration_profiles_imported', '1');
        return;
    }

    const raw = readJsonSafe(PROFILE_PATH, { users: {}, aliases: {} });
    const users = raw && raw.users && typeof raw.users === 'object' ? raw.users : {};
    const aliases = raw && raw.aliases && typeof raw.aliases === 'object' ? raw.aliases : {};
    const now = Date.now();

    const insertProfile = db.prepare(`
        INSERT OR REPLACE INTO registration_profiles (canonical_jid, payload, updated_at)
        VALUES (?, ?, ?)
    `);
    const insertAlias = db.prepare(`
        INSERT OR REPLACE INTO registration_aliases (alias_jid, canonical_jid)
        VALUES (?, ?)
    `);

    const transaction = db.transaction(() => {
        for (const [jid, profile] of Object.entries(users)) {
            insertProfile.run(jid, JSON.stringify(profile || {}), now);
        }
        for (const [aliasJid, canonicalJid] of Object.entries(aliases)) {
            if (!aliasJid || !canonicalJid || !users[canonicalJid]) continue;
            insertAlias.run(aliasJid, canonicalJid);
        }
    });

    transaction();
    setMeta(db, 'registration_profiles_imported', '1');
}

function migrateRegistrationStates(db) {
    const alreadyImported = getMeta(db, 'registration_states_imported') === '1';
    if (alreadyImported || countRows(db, 'registration_states') > 0) {
        if (!alreadyImported) setMeta(db, 'registration_states_imported', '1');
        return;
    }

    const raw = readJsonSafe(STATE_PATH, { users: {} });
    const users = raw && raw.users && typeof raw.users === 'object' ? raw.users : {};
    const now = Date.now();
    const insertState = db.prepare(`
        INSERT OR REPLACE INTO registration_states (jid, payload, updated_at)
        VALUES (?, ?, ?)
    `);

    const transaction = db.transaction(() => {
        for (const [jid, state] of Object.entries(users)) {
            insertState.run(jid, JSON.stringify(state || {}), now);
        }
    });

    transaction();
    setMeta(db, 'registration_states_imported', '1');
}

function migrateChatbotMemory(db) {
    const alreadyImported = getMeta(db, 'chatbot_memory_imported') === '1';
    if (alreadyImported || countRows(db, 'chatbot_memory') > 0) {
        if (!alreadyImported) setMeta(db, 'chatbot_memory_imported', '1');
        return;
    }

    const raw = readJsonSafe(MEMORY_PATH, {});
    const now = Date.now();
    const insertMemory = db.prepare(`
        INSERT OR REPLACE INTO chatbot_memory (user_id, payload, updated_at)
        VALUES (?, ?, ?)
    `);

    const transaction = db.transaction(() => {
        for (const [userId, payload] of Object.entries(raw || {})) {
            insertMemory.run(userId, JSON.stringify(payload || {}), Number(payload?.updatedAt || now));
        }
    });

    transaction();
    setMeta(db, 'chatbot_memory_imported', '1');
}

function readRegistrationProfiles() {
    const db = getDb();
    const profiles = { users: {}, aliases: {} };
    const rows = db.prepare('SELECT canonical_jid, payload FROM registration_profiles').all();
    const aliases = db.prepare('SELECT alias_jid, canonical_jid FROM registration_aliases').all();

    for (const row of rows) {
        try {
            profiles.users[row.canonical_jid] = JSON.parse(String(row.payload || '{}'));
        } catch {
            profiles.users[row.canonical_jid] = {};
        }
    }

    for (const row of aliases) {
        profiles.aliases[row.alias_jid] = row.canonical_jid;
    }

    return profiles;
}

function writeRegistrationProfiles(profiles, options = {}) {
    const db = getDb();
    const next = profiles && typeof profiles === 'object' ? profiles : { users: {}, aliases: {} };
    const users = next.users && typeof next.users === 'object' ? next.users : {};
    const aliases = next.aliases && typeof next.aliases === 'object' ? next.aliases : {};
    const now = Date.now();

    const clearProfiles = db.prepare('DELETE FROM registration_profiles');
    const clearAliases = db.prepare('DELETE FROM registration_aliases');
    const insertProfile = db.prepare(`
        INSERT INTO registration_profiles (canonical_jid, payload, updated_at)
        VALUES (?, ?, ?)
    `);
    const insertAlias = db.prepare(`
        INSERT INTO registration_aliases (alias_jid, canonical_jid)
        VALUES (?, ?)
    `);

    const transaction = db.transaction(() => {
        clearAliases.run();
        clearProfiles.run();
        for (const [jid, profile] of Object.entries(users)) {
            insertProfile.run(jid, JSON.stringify(profile || {}), now);
        }
        for (const [aliasJid, canonicalJid] of Object.entries(aliases)) {
            if (!aliasJid || !canonicalJid || !users[canonicalJid]) continue;
            insertAlias.run(aliasJid, canonicalJid);
        }
    });

    transaction();
    if (options.mirrorJson !== false) {
        writeJsonSafe(PROFILE_PATH, { users, aliases });
    }
}

function readRegistrationState() {
    const db = getDb();
    const state = { users: {} };
    const rows = db.prepare('SELECT jid, payload FROM registration_states').all();

    for (const row of rows) {
        try {
            state.users[row.jid] = JSON.parse(String(row.payload || '{}'));
        } catch {
            state.users[row.jid] = {};
        }
    }

    return state;
}

function writeRegistrationState(state, options = {}) {
    const db = getDb();
    const next = state && typeof state === 'object' ? state : { users: {} };
    const users = next.users && typeof next.users === 'object' ? next.users : {};
    const now = Date.now();
    const clearStates = db.prepare('DELETE FROM registration_states');
    const insertState = db.prepare(`
        INSERT INTO registration_states (jid, payload, updated_at)
        VALUES (?, ?, ?)
    `);

    const transaction = db.transaction(() => {
        clearStates.run();
        for (const [jid, payload] of Object.entries(users)) {
            insertState.run(jid, JSON.stringify(payload || {}), now);
        }
    });

    transaction();
    if (options.mirrorJson !== false) {
        writeJsonSafe(STATE_PATH, { users });
    }
}

function readChatbotMemory() {
    const db = getDb();
    const memory = {};
    const rows = db.prepare('SELECT user_id, payload FROM chatbot_memory').all();

    for (const row of rows) {
        try {
            memory[row.user_id] = JSON.parse(String(row.payload || '{}'));
        } catch {
            memory[row.user_id] = {};
        }
    }

    return memory;
}

function writeChatbotMemory(memoryDb, userId, options = {}) {
    const db = getDb();
    const next = memoryDb && typeof memoryDb === 'object' ? memoryDb : {};
    const now = Date.now();

    if (userId) {
        const payload = next[userId];
        if (!payload) {
            db.prepare('DELETE FROM chatbot_memory WHERE user_id = ?').run(userId);
        } else {
            db.prepare(`
                INSERT INTO chatbot_memory (user_id, payload, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
            `).run(userId, JSON.stringify(payload), Number(payload.updatedAt || now));
        }
    } else {
        const clearMemory = db.prepare('DELETE FROM chatbot_memory');
        const insertMemory = db.prepare(`
            INSERT INTO chatbot_memory (user_id, payload, updated_at)
            VALUES (?, ?, ?)
        `);

        const transaction = db.transaction(() => {
            clearMemory.run();
            for (const [key, payload] of Object.entries(next)) {
                insertMemory.run(key, JSON.stringify(payload || {}), Number(payload?.updatedAt || now));
            }
        });

        transaction();
    }

    if (options.mirrorJson !== false) {
        writeJsonSafe(MEMORY_PATH, next);
    }
}

function getDatabasePath() {
    return DB_PATH;
}

module.exports = {
    clone,
    getDatabasePath,
    readRegistrationProfiles,
    writeRegistrationProfiles,
    readRegistrationState,
    writeRegistrationState,
    readChatbotMemory,
    writeChatbotMemory
};
