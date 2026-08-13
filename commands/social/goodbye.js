// goodbye.js
const { isGoodByeOn, getGoodbye } = require('../../lib/index');
const { RANDOM_GOODBYE_TOKEN, handleGoodbye } = require('../../lib/welcome');

// 50+ human-style goodbye messages
const RANDOM_GOODBYE_MESSAGES = [
  '{mention} has left {group}. We will miss you',
  'Goodbye {mention}, thanks for being in {group}',
  '{mention} left the group. Take care',
  '{mention} has gone. Hope to see you back',
  'Farewell {mention}, enjoy your journey',
  'Bye {mention}, hope you come back soon',
  'Goodbye {mention}, take care out there',
  '{mention} left {group}. See you again'
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
    .replace(/\{count\}/gi, String(data.memberCount));
}

async function handleLeaveEvent(sock, id, participants) {
  const isGoodbyeEnabled = await isGoodByeOn(id);
  console.log(`[GOODBYE] handleLeaveEvent triggered for ${id}. Enabled: ${isGoodbyeEnabled}`);
  if (!isGoodbyeEnabled) return;

  const groupMetadata = await sock.groupMetadata(id);
  const groupName = groupMetadata.subject || 'this group';
  const groupDesc = groupMetadata.desc || 'No description';

  const customMessage = await getGoodbye(id);

  for (const participant of participants) {
    const userName = toMentionText(participant);
    const mention = toMentionText(participant);
    const isRandomToken = customMessage === RANDOM_GOODBYE_TOKEN;
    const template = (customMessage && !isRandomToken) ? customMessage : RANDOM_GOODBYE_MESSAGES[Math.floor(Math.random() * RANDOM_GOODBYE_MESSAGES.length)];
    const finalMessage = formatTemplate(template, {
      userName,
      mention,
      groupName,
      groupDesc,
      memberCount: groupMetadata.participants.length
    });

    try {
      const participantJid = getParticipantJid(participant);
      await sock.sendMessage(id, { 
        text: finalMessage,
        mentions: [participantJid]
      });
    } catch (error) {
      console.error('Error sending goodbye message:', error);
    }
  }
}

async function goodbyePreview(sock, chatId, message) {
  if (!chatId.endsWith('@g.us')) {
    await sock.sendMessage(chatId, { text: 'This command can only be used in groups.' });
    return;
  }
  const senderId = message?.key?.participant || message?.key?.remoteJid;
  if (!senderId) {
    await sock.sendMessage(chatId, { text: 'Could not detect the sender for the goodbye preview.' }, { quoted: message });
    return;
  }
  await handleLeaveEvent(sock, chatId, [senderId]);
}

module.exports = {
  name: 'goodbye',
  alias: ['gb'],
  async execute(ctx) {
    const { sock, chatId, message, args } = ctx;
    if (args.length > 0) {
      return await handleGoodbye(sock, chatId, message, args.join(' '));
    } else {
      return await goodbyePreview(sock, chatId, message);
    }
  },
  handleLeaveEvent
};
