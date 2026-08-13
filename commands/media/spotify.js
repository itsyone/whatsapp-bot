const axios = require('axios')
const sharp = require('sharp')

async function getJsonWithRetry(url, options = {}, delayMs = 1200) {
  try {
    return await axios.get(url, options)
  } catch (error) {
    const status = Number(error?.response?.status || 0)
    if (status !== 429) throw error
    await new Promise((resolve) => setTimeout(resolve, delayMs)) // FIXED: single spotify retry on rate limit
    return axios.get(url, options)
  }
}

async function spotifyCommand(sock, chatId, message) {
  const rawText = message.message?.conversation?.trim() ||
    message.message?.extendedTextMessage?.text?.trim() || ''
  const query = rawText.slice(rawText.split(/\s+/)[0].length).trim()

  if (!query) return sock.sendMessage(chatId, {
    text: '🎵 Usage: .spotify <song>\nExample: .spotify alan walker faded'
  }, { quoted: message })

  try {
    await sock.sendMessage(chatId, { react: { text: '⏳', key: message.key } })

    const res = await getJsonWithRetry(
      `https://api.azbry.com/api/download/spoplay?q=${encodeURIComponent(query)}`
    ) // FIXED: restore nested single-call Spotify provider
    const song = res?.data?.result
    if (!song || !res?.data?.status) throw new Error('No results')

    const audioUrl = song.rawLink || song.downloadLink
    if (!audioUrl) throw new Error('No download link')

    const [imgBuffer, audioBuffer] = await Promise.all([
      axios.get(song.cover, { responseType: 'arraybuffer' }).then(r => Buffer.from(r.data)),
      axios.get(audioUrl, { responseType: 'arraybuffer' }).then(r => Buffer.from(r.data))
    ])

    const cover = await sharp(imgBuffer)
      .resize(1280, 1280, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .jpeg({ quality: 90 })
      .toBuffer()

    await sock.sendMessage(chatId, {
      image: cover,
      caption: `✧ *${song.title}* ✧\n🎤 ${song.artist}\n💿 ${song.album}`
    }, { quoted: message })

    await sock.sendMessage(chatId, {
      audio: audioBuffer,
      mimetype: 'audio/mpeg',
      fileName: `${song.title}.mp3`
    }, { quoted: message })

    await sock.sendMessage(chatId, { react: { text: '', key: message.key } })
  } catch (e) {
    const status = Number(e?.response?.status || 0)
    const replyText = status === 404
      ? '❌ No playable Spotify result was found for that search.'
      : status === 429
        ? '❌ Spotify provider is rate-limited right now. Try again in a moment.'
        : '❌ Failed, try again later.'
    console.error('[SPOTIFY]', e.message)
    sock.sendMessage(chatId, { text: replyText }, { quoted: message }) // FIXED: clearer spotify provider failure reply
  }
}

module.exports = {
  name: 'spotify',
  async execute(ctx) {
    return spotifyCommand(ctx.sock || null, ctx.chatId || null, ctx.message || null)
  }
}
