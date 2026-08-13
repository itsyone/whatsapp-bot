const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const { getBaileys } = require('./baileys');

dotenv.config({ path: path.join(process.cwd(), 'env') });

const MONGODB_URI = String(process.env.MONGO_URI || '').trim();
const MONGO_CONNECT_OPTIONS = {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 30000,
  maxPoolSize: 10,
  minPoolSize: 1,
  family: 4
};

const WhatsAppAuthFileSchema = new mongoose.Schema({
  bot_id: { type: String, required: true, index: true },
  doc_key: { type: String, required: true },
  payload: { type: String, required: true },
  updated_at: { type: Number, required: true }
});

WhatsAppAuthFileSchema.index({ bot_id: 1, doc_key: 1 }, { unique: true });

const WhatsAppAuthFile =
  mongoose.models.WhatsAppAuthFile ||
  mongoose.model('WhatsAppAuthFile', WhatsAppAuthFileSchema);

let mongoConnectPromise = null;
let baileysAuthHelpersPromise = null;

async function ensureMongoConnection() {
  if (!MONGODB_URI) return false;
  if (mongoose.connection.readyState === 1) return true;
  if (mongoose.connection.readyState === 2 && mongoConnectPromise) {
    try {
      await mongoConnectPromise;
      return mongoose.connection.readyState === 1;
    } catch {
      return false;
    }
  }

  if (!mongoConnectPromise) {
    mongoConnectPromise = mongoose.connect(MONGODB_URI, MONGO_CONNECT_OPTIONS)
      .catch((error) => {
        mongoConnectPromise = null;
        throw error;
      });
  }

  try {
    await mongoConnectPromise;
    return mongoose.connection.readyState === 1;
  } catch (error) {
    console.error('[mongo-auth] connection failed:', error?.message || error);
    return false;
  }
}

async function getBaileysAuthHelpers() {
  if (!baileysAuthHelpersPromise) {
    baileysAuthHelpersPromise = getBaileys().then((mod) => ({
      useMultiFileAuthState: mod.useMultiFileAuthState,
      BufferJSON: mod.BufferJSON
    }));
  }
  return baileysAuthHelpersPromise;
}

function fixFileName(file) {
  return String(file || '').replace(/\//g, '__').replace(/:/g, '-');
}

async function ensureFolder(folder) {
  await fsp.mkdir(folder, { recursive: true });
}

async function listAuthJsonFiles(folder) {
  try {
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function writeMongoAuthDoc(botId, docKey, payload) {
  if (!(await ensureMongoConnection())) return false;
  try {
    await WhatsAppAuthFile.updateOne(
      { bot_id: botId, doc_key: docKey },
      { bot_id: botId, doc_key: docKey, payload, updated_at: Date.now() },
      { upsert: true }
    );
    return true;
  } catch (error) {
    console.error(`[mongo-auth] write failed for ${botId}/${docKey}:`, error?.message || error);
    return false;
  }
}

async function deleteMongoAuthDoc(botId, docKey) {
  if (!(await ensureMongoConnection())) return false;
  try {
    await WhatsAppAuthFile.deleteOne({ bot_id: botId, doc_key: docKey });
    return true;
  } catch (error) {
    console.error(`[mongo-auth] delete failed for ${botId}/${docKey}:`, error?.message || error);
    return false;
  }
}

async function mirrorFolderToMongo(botId, folder) {
  if (!(await ensureMongoConnection())) return false;
  const files = await listAuthJsonFiles(folder);
  if (!files.length) return false;

  try {
    await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(folder, file);
        const payload = await fsp.readFile(filePath, 'utf8');
        await WhatsAppAuthFile.updateOne(
          { bot_id: botId, doc_key: file },
          { bot_id: botId, doc_key: file, payload, updated_at: Date.now() },
          { upsert: true }
        );
      })
    );
    return true;
  } catch (error) {
    console.error(`[mongo-auth] folder mirror failed for ${botId}:`, error?.message || error);
    return false;
  }
}

async function hydrateFolderFromMongo(botId, folder) {
  if (!(await ensureMongoConnection())) return false;
  try {
    const docs = await WhatsAppAuthFile.find({ bot_id: botId }).lean();
    if (!docs.length) return false;
    await ensureFolder(folder);
    await Promise.all(
      docs.map((doc) => fsp.writeFile(path.join(folder, doc.doc_key), String(doc.payload || ''), 'utf8'))
    );
    return true;
  } catch (error) {
    console.error(`[mongo-auth] hydrate failed for ${botId}:`, error?.message || error);
    return false;
  }
}

async function useMongoBackedAuthState(folder, botId = 'eclipse') {
  const authFolder = path.resolve(folder);
  const { useMultiFileAuthState, BufferJSON } = await getBaileysAuthHelpers();

  await ensureFolder(authFolder);

  const credsFile = path.join(authFolder, fixFileName('creds.json'));
  const hasLocalCreds = fs.existsSync(credsFile);

  if (await ensureMongoConnection()) {
    if (hasLocalCreds) {
      await mirrorFolderToMongo(botId, authFolder);
    } else {
      await hydrateFolderFromMongo(botId, authFolder);
    }
  }

  const base = await useMultiFileAuthState(authFolder);
  const baseKeysSet = base.state.keys.set.bind(base.state.keys);
  const baseSaveCreds = base.saveCreds.bind(base);

  base.state.keys.set = async (data) => {
    await baseKeysSet(data);
    if (!(await ensureMongoConnection())) return;

    const tasks = [];
    for (const category in data) {
      for (const id in data[category]) {
        const value = data[category][id];
        const file = fixFileName(`${category}-${id}.json`);
        if (value) {
          tasks.push(writeMongoAuthDoc(botId, file, JSON.stringify(value, BufferJSON.replacer)));
        } else {
          tasks.push(deleteMongoAuthDoc(botId, file));
        }
      }
    }
    await Promise.all(tasks);
  };

  const saveCreds = async () => {
    await baseSaveCreds();
    await writeMongoAuthDoc(
      botId,
      fixFileName('creds.json'),
      JSON.stringify(base.state.creds, BufferJSON.replacer)
    );
  };

  return {
    state: base.state,
    saveCreds
  };
}

module.exports = {
  useMongoBackedAuthState,
  ensureMongoConnection,
  WhatsAppAuthFile
};
