const { APP_DEFAULTS } = require('./lib/botProfiles');
const { getCurrentProfile } = require('./lib/botContext');

const baseSettings = {
  ...APP_DEFAULTS,
  packname: 'Bot Sticker',
  author: 'Bot',
  botName: 'Bot',
  botOwner: 'AYAN',
  ownerNumber: '584164385530',
  chatbotStickerDir: 'assets/new stickers',
  PREFIX: '/',
  animationDir: 'animation'
};

function resolveSettings() {
  const profile = getCurrentProfile();
  if (!profile) return baseSettings;

  return {
    ...baseSettings,
    ...(profile.settings || {}),
    botId: profile.botId,
    botName: profile.botName || baseSettings.botName,
    packname: profile.packname || baseSettings.packname,
    author: profile.author || baseSettings.author,
    botOwner: profile.botOwner || baseSettings.botOwner,
    ownerNumber: profile.ownerNumber || baseSettings.ownerNumber,
    PREFIX: profile.prefix || baseSettings.PREFIX,
    chatbotStickerDir: profile.chatbotStickerDir || baseSettings.chatbotStickerDir,
    animationDir: profile.animationDir || baseSettings.animationDir,
    enabledCommands: profile.enabledCommands || [],
    disabledCommands: profile.disabledCommands || [],
    aliases: profile.aliases || {}
  };
}

module.exports = new Proxy(baseSettings, {
  get(target, prop) {
    const resolved = resolveSettings();
    return prop in resolved ? resolved[prop] : target[prop];
  },
  set(target, prop, value) {
    target[prop] = value;
    return true;
  },
  ownKeys(target) {
    return Reflect.ownKeys(resolveSettings() || target);
  },
  getOwnPropertyDescriptor(target, prop) {
    return {
      enumerable: true,
      configurable: true,
      value: this.get(target, prop)
    };
  }
});
