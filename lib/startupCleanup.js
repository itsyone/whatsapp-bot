const fs = require('fs');
const path = require('path');

const ROOT_DIR = process.cwd();
const PLAYER_SCRIPT_RE = /^\d{10,}-player-script\.js$/i;
const KEEP_NEWEST = 1;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function cleanupPlayerScripts() {
  let removed = 0;

  try {
    const entries = fs.readdirSync(ROOT_DIR, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && PLAYER_SCRIPT_RE.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(ROOT_DIR, entry.name);
        const stat = safeStat(fullPath);
        return stat ? { fullPath, mtimeMs: stat.mtimeMs } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const now = Date.now();

    files.forEach((file, index) => {
      const tooOld = now - file.mtimeMs > MAX_AGE_MS;
      const overLimit = index >= KEEP_NEWEST;
      if (!tooOld && !overLimit) return;

      try {
        fs.unlinkSync(file.fullPath);
        removed += 1;
      } catch {}
    });
  } catch {}

  return removed;
}

function clearTempDirectories() {
  const tempDirs = ['tmp', 'temp'];
  let cleared = 0;
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;

  tempDirs.forEach(dir => {
    const fullPath = path.join(ROOT_DIR, dir);
    if (!fs.existsSync(fullPath)) {
      try { fs.mkdirSync(fullPath, { recursive: true }); } catch {}
      return;
    }

    try {
      const files = fs.readdirSync(fullPath);
      files.forEach(file => {
        const filePath = path.join(fullPath, file);
        const stat = safeStat(filePath);
        if (stat && now - stat.mtimeMs > ONE_HOUR) {
          try {
            if (stat.isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
            else fs.unlinkSync(filePath);
            cleared++;
          } catch {}
        }
      });
    } catch {}
  });

  return cleared;
}

module.exports = {
  cleanupPlayerScripts,
  clearTempDirectories
};
