// welcome.js
const { isWelcomeOn, getWelcome } = require('../../lib/index');
const { RANDOM_WELCOME_TOKEN, handleWelcome } = require('../../lib/welcome');

// 50+ human-style welcome messages
const RANDOM_WELCOME_MESSAGES = [
  'Hey {mention}! Welcome to {group}',
  'Hello {mention}, glad you joined {group}',
  '{mention} just joined {group}, say hello!',
  'Welcome, {mention}, make yourself at home in {group}',
  '{mention} has arrived! Enjoy your stay in {group}',
  'Good to see you, {mention}, welcome to {group}',
  'Hey {mention}, welcome aboard {group}',
  '{mention} joined {group}. Let’s get started',
  '{mention}, welcome to {group}. Feel free to chat',
  'Welcome, {mention}, make yourself at home in {group}',
  'Hey {mention}, glad you joined {group}',
  'Hello {mention}, welcome to the {group} community'
];

function getParticipantJid(participant) {
  return typeof participant === 'string' ? participant : (participant?.id || participant || '');
}

function toMentionText(participant) {
  const jid = getParticipantJid(participant);
  const digits = String(jid).split('@')[0].split(':')[0];
  return digits ? `@${digits}` : '@user';
}

function formatTemplate(template, data) {
  return String(template)
    .replace(/\{user\}/gi, data.userName)
    .replace(/\{mention\}/gi, data.mention)
    .replace(/\{group\}/gi, data.groupName)
    .replace(/\{description\}/gi, data.groupDesc)
    .replace(/\{count\}/gi, String(data.memberCount))
    .replace(/\{pfp\}/gi, '')
    .replace(/\{groupp\}/gi, '');
}

function extractRawWelcomeMatch(message) {
  const rawText =
    message?.message?.conversation ||
    message?.message?.extendedTextMessage?.text ||
    message?.message?.imageMessage?.caption ||
    message?.message?.videoMessage?.caption ||
    '';

  const trimmed = String(rawText || '').trim();
  if (!trimmed) return '';

  return trimmed.replace(/^\.welcome\b/i, '').replace(/^\.w\b/i, '').trim(); // FIXED: use original multiline welcome text directly
}

async function getProfilePicture(sock, jid) {
  try {
    const url = await sock.profilePictureUrl(jid, 'image');
    return url || null;
  } catch {
    return null;
  }
}

function extractRawWelcomeMatch(message) {
  const rawText =
    message?.message?.conversation ||
    message?.message?.extendedTextMessage?.text ||
    message?.message?.imageMessage?.caption ||
    message?.message?.videoMessage?.caption ||
    '';

  const trimmed = String(rawText || '').trim();
  if (!trimmed) return '';

  return trimmed.replace(/^\.welcome\b/i, '').replace(/^\.w\b/i, '').trim(); // FIXED: use original multiline welcome text directly
}

async function handleJoinEvent(sock, id, participants) {
  const isWelcomeEnabled = await isWelcomeOn(id);
  console.log(`[WELCOME] handleJoinEvent triggered for ${id}. Enabled: ${isWelcomeEnabled}`);
  if (!isWelcomeEnabled) return;

  const groupMetadata = await sock.groupMetadata(id);
  const groupName = groupMetadata.subject || 'this group';
  const groupDesc = groupMetadata.desc || 'No description';

  const customMessage = await getWelcome(id);

  for (const participant of participants) {
    const userName = toMentionText(participant);
    const mention = toMentionText(participant);
    const isRandomToken = customMessage === RANDOM_WELCOME_TOKEN;
    const template = (customMessage && !isRandomToken) ? customMessage : RANDOM_WELCOME_MESSAGES[Math.floor(Math.random() * RANDOM_WELCOME_MESSAGES.length)];
    const wantsPfp = /\{pfp\}/i.test(template);
    const wantsGroupPfp = /\{groupp\}/i.test(template);
    const finalMessage = formatTemplate(template, {
      userName,
      mention,
      groupName,
      groupDesc,
      memberCount: groupMetadata.participants.length
    });

    try {
      const participantJid = getParticipantJid(participant);
      const imageUrl = wantsPfp
        ? await getProfilePicture(sock, participantJid)
        : wantsGroupPfp ? await getProfilePicture(sock, id) : null;
      const payload = imageUrl
        ? { image: { url: imageUrl }, caption: finalMessage, mentions: [participantJid] }
        : { text: finalMessage, mentions: [participantJid] };
      await sock.sendMessage(id, payload);
    } catch (error) {
      console.error('Error sending welcome message:', error);
    }
  }
}

async function welcomePreview(sock, chatId, message) {
  if (!chatId.endsWith('@g.us')) {
    await sock.sendMessage(chatId, { text: 'This command can only be used in groups.' });
    return;
  }
  const senderId = message?.key?.participant || message?.key?.remoteJid;
  if (!senderId) {
    await sock.sendMessage(chatId, { text: 'Could not detect the sender for the welcome preview.' }, { quoted: message });
    return;
  }
  await handleJoinEvent(sock, chatId, [senderId]);
}

module.exports = {
  name: 'welcome',
  alias: ['w'],
  async execute(ctx) {
    const { sock, chatId, message, args } = ctx;
    const match = extractRawWelcomeMatch(message);
    if (args.length > 0 || match) {
      return await handleWelcome(sock, chatId, message, match); // FIXED: preserve raw multiline welcome text
    } else {
      return await welcomePreview(sock, chatId, message);
    }
  },
  handleJoinEvent
};
