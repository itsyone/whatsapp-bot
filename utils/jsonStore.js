const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');

const SNAPSHOT_BASENAMES = new Set([
    'registrationProfiles.json',
    'economy.json',
    'userGroupData.json'
]);
const SNAPSHOT_RETENTION = 15;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function getPaths(filePath) {
    const resolved = path.resolve(filePath);
    return {
        main: resolved,
        backup: `${resolved}.bak`,
        temp: `${resolved}.tmp`
    };
}

function ensureParent(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function shouldSnapshot(filePath) {
    return SNAPSHOT_BASENAMES.has(path.basename(filePath));
}

function getSnapshotDir(filePath) {
    const resolved = path.resolve(filePath);
    return path.join(path.dirname(resolved), '_snapshots', path.basename(resolved, '.json'));
}

function buildSnapshotName(filePath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${stamp}-${path.basename(filePath)}`;
}

function getLatestSnapshot(filePath) {
    try {
        if (!shouldSnapshot(filePath)) return '';
        const snapshotDir = getSnapshotDir(filePath);
        if (!fs.existsSync(snapshotDir)) return '';

        const latest = fs.readdirSync(snapshotDir)
            .map((name) => ({
                fullPath: path.join(snapshotDir, name),
                mtime: fs.statSync(path.join(snapshotDir, name)).mtimeMs
            }))
            .sort((a, b) => b.mtime - a.mtime)[0];

        return latest?.fullPath || '';
    } catch {
        return '';
    }
}

function pruneSnapshots(snapshotDir) {
    try {
        const entries = fs.readdirSync(snapshotDir)
            .map((name) => ({
                name,
                fullPath: path.join(snapshotDir, name),
                mtime: fs.statSync(path.join(snapshotDir, name)).mtimeMs
            }))
            .sort((a, b) => b.mtime - a.mtime);

        for (const entry of entries.slice(SNAPSHOT_RETENTION)) {
            try {
                fs.unlinkSync(entry.fullPath);
            } catch {}
        }
    } catch {}
}

function createSnapshot(filePath) {
    if (!shouldSnapshot(filePath)) return;
    try {
        const resolved = path.resolve(filePath);
        if (!fs.existsSync(resolved)) return;

        const snapshotDir = getSnapshotDir(resolved);
        ensureParent(path.join(snapshotDir, 'x'));
        const snapshotPath = path.join(snapshotDir, buildSnapshotName(resolved));
        fs.copyFileSync(resolved, snapshotPath);
        pruneSnapshots(snapshotDir);
    } catch {}
}

function parseFile(filePath) {
    const stats = fs.statSync(filePath);
    const sizeMb = stats.size / (1024 * 1024);
    
    if (sizeMb > 5) {
        logger.parseFile(path.basename(filePath), sizeMb);
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) throw new Error('empty json file');
    
    try {
        return JSON.parse(raw);
    } catch (err) {
        console.error(`[JSON] Failed to parse ${path.basename(filePath)}:`, err.message);
        throw err;
    }
}

function writeJsonSafe(filePath, value) {
    const paths = getPaths(filePath);
    ensureParent(paths.main);
    fs.writeFileSync(paths.temp, JSON.stringify(value, null, 2), 'utf8');
    if (fs.existsSync(paths.main)) {
        try {
            fs.copyFileSync(paths.main, paths.backup);
        } catch {}
    }
    fs.renameSync(paths.temp, paths.main);
    createSnapshot(paths.main);
    return true;
}

function readJsonSafe(filePath, fallback) {
    const paths = getPaths(filePath);
    ensureParent(paths.main);

    if (!fs.existsSync(paths.main) && !fs.existsSync(paths.backup)) {
        writeJsonSafe(paths.main, fallback);
        return clone(fallback);
    }

    try {
        if (fs.existsSync(paths.main)) return parseFile(paths.main);
    } catch {}

    try {
        if (fs.existsSync(paths.backup)) {
            const recovered = parseFile(paths.backup);
            writeJsonSafe(paths.main, recovered);
            return recovered;
        }
    } catch {}

    try {
        const latestSnapshot = getLatestSnapshot(paths.main);
        if (latestSnapshot) {
            const recovered = parseFile(latestSnapshot);
            writeJsonSafe(paths.main, recovered);
            return recovered;
        }
    } catch {}

    writeJsonSafe(paths.main, fallback);
    return clone(fallback);
}

module.exports = {
    clone,
    readJsonSafe,
    writeJsonSafe
};
