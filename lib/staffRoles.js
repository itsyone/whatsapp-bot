const fs = require('fs');
const path = require('path');
const { readStaffRoles, writeStaffRoles } = require('./mongoStore');

let staffCache = null;
let lastSaveAt = 0;
const SAVE_INTERVAL = 60_000;

function ensureStore() {
    if (staffCache) return staffCache;
    staffCache = readStaffRoles();
    return staffCache;
}


function normalizeJid(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const digits = raw.split('@')[0].split(':')[0].replace(/\D/g, '');
    return digits ? `${digits}@s.whatsapp.net` : '';
}

function dedupe(list) {
    const seen = new Set();
    const output = [];

    for (const value of list) {
        const jid = normalizeJid(value);
        if (!jid || seen.has(jid)) continue;
        seen.add(jid);
        output.push(jid);
    }

    return output;
}

function getStaffRoles() {
    const store = ensureStore();
    return {
        coOwners: dedupe(store.coOwners),
        mods: dedupe(store.mods),
        staff: dedupe(store.staff)
    };
}

function saveStaffRoles(nextStore) {
    const sanitized = {
        coOwners: dedupe(nextStore?.coOwners || []),
        mods: dedupe(nextStore?.mods || []),
        staff: dedupe(nextStore?.staff || [])
    };
    staffCache = sanitized;
    writeStaffRoles(sanitized);
    return sanitized;
}


function addStaffRole(role, jid) {
    const normalized = normalizeJid(jid);
    if (!normalized) return false;

    const store = ensureStore();
    if (!Array.isArray(store[role])) return false;

    if (!store[role].includes(normalized)) {
        store[role].push(normalized);
    }

    saveStaffRoles(store);
    return true;
}

function removeStaffRole(role, jid) {
    const normalized = normalizeJid(jid);
    if (!normalized) return false;

    const store = ensureStore();
    if (!Array.isArray(store[role])) return false;

    const before = store[role].length;
    store[role] = store[role].filter((item) => normalizeJid(item) !== normalized);
    saveStaffRoles(store);
    return store[role].length !== before;
}

function hasStaffRole(jid, roles = ['coOwners', 'mods', 'staff']) {
    const normalized = normalizeJid(jid);
    if (!normalized) return false;

    const store = getStaffRoles();
    // Map role aliases to actual store keys
    const roleMap = {
        'sudo': 'coOwners',
        'owner': 'coOwners',
        'coOwners': 'coOwners',
        'mods': 'mods',
        'staff': 'staff'
    };

    return roles.some((role) => {
        const actualRole = roleMap[role] || role;
        return Array.isArray(store[actualRole]) && store[actualRole].includes(normalized);
    });
}

module.exports = {
    addStaffRole,
    getStaffRoles,
    hasStaffRole,
    normalizeJid,
    removeStaffRole
};
