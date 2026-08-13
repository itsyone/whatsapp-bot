const { canUseHfVoice, synthesizeRyoVoiceNote } = require('../../lib/hfVoice');

function extractVoiceText(message, rawText = '') {
  const direct = String(rawText || '').replace(/^\.ryov\b/i, '').trim();
  if (direct) {
    return direct;
  }

  const quotedText =
    message?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
    message?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text ||
    '';

  return String(quotedText || '').trim();
}

async function ryovCommand(sock, chatId, message, rawText = '') {
  const text = extractVoiceText(message, rawText);

  if (!text) {
    await sock.sendMessage(chatId, {
      text: 'Use `.ryov <text>` or reply to a text with `.ryov`.'
    }, { quoted: message });
    return;
  }

  if (!canUseHfVoice()) {
    await sock.sendMessage(chatId, {
      text: 'HF voice is not configured yet.'
    }, { quoted: message });
    return;
  }

  try {
    await sock.sendPresenceUpdate('recording', chatId).catch(() => {});

    const voiceReply = await synthesizeRyoVoiceNote(text);
    if (!voiceReply?.buffer?.length) {
      throw new Error('Empty voice output');
    }

    await sock.sendMessage(chatId, {
      audio: voiceReply.buffer,
      mimetype: voiceReply.mimetype,
      ptt: true
    }, { quoted: message });
  } catch (error) {
    console.error('[ryov] error:', error?.message || error);
    await sock.sendMessage(chatId, {
      text: 'Failed to generate Ryo voice note.'
    }, { quoted: message });
  } finally {
    await sock.sendPresenceUpdate('paused', chatId).catch(() => {});
  }
}





module.exports = {
  name: 'ryov',
  async execute(ctx) {
    return ryovCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null, ctx.rawText || null);
  }
};
