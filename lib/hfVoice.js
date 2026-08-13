require('../config');

const os = require('os');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { InferenceClient } = require('@huggingface/inference');
const { Client } = require('@gradio/client');

const HF_API_KEY = String(process.env.HF_API_KEY || '').trim();
const RYO_TTS_MODEL = String(process.env.RYO_TTS_MODEL || 'Aratako/Irodori-TTS-500M-v2').trim();
const RYO_TTS_PROVIDER = String(process.env.RYO_TTS_PROVIDER || 'hf-inference').trim();
const RYO_TTS_MAX_CHARS = Math.max(30, Number(process.env.RYO_TTS_MAX_CHARS || 260));
const RYO_TTS_SPACE = String(process.env.RYO_TTS_SPACE || 'Aratako/Irodori-TTS-500M-v2-Demo').trim();

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const hfClient = HF_API_KEY ? new InferenceClient(HF_API_KEY) : null;
let gradioClientPromise = null;

function voiceEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.AUTO_VOICE || '').trim());
}

function canUseHfVoice() {
  return Boolean(hfClient);
}

function normalizeVoiceText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, RYO_TTS_MAX_CHARS);
}

async function writeBuffer(filePath, buffer) {
  await fs.promises.writeFile(filePath, buffer);
}

async function synthesizeViaDirectInference(text) {
  const response = await fetch(`https://router.huggingface.co/hf-inference/models/${encodeURIComponent(RYO_TTS_MODEL)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HF_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text,
      options: {
        wait_for_model: true,
        use_cache: false
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`HF direct inference failed (${response.status}): ${errorText || response.statusText}`);
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    const payload = await response.text().catch(() => '');
    throw new Error(`HF direct inference returned JSON instead of audio: ${payload}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function getGradioClient() {
  if (!gradioClientPromise) {
    gradioClientPromise = Client.connect(RYO_TTS_SPACE, HF_API_KEY ? { token: HF_API_KEY } : {});
  }
  return gradioClientPromise;
}

async function synthesizeViaGradioSpace(text) {
  const app = await getGradioClient();
  const result = await app.predict('/gradio_inference', [
    text,
    null,
    20,
    1,
    '',
    'independent',
    3.0,
    5.0,
    '',
    0.5,
    1.0,
    true,
    '',
    '',
    '',
    '',
    '0.9',
    ''
  ]);

  const values = Array.isArray(result?.data) ? result.data : (Array.isArray(result) ? result : []);
  const firstAudio = values
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      if (item.url || item.path) return item;
      if (item.value && typeof item.value === 'object' && (item.value.url || item.value.path)) {
        return item.value;
      }
      return null;
    })
    .find(Boolean);
  if (!firstAudio) {
    throw new Error('Gradio Space returned no audio output');
  }

  if (firstAudio.url) {
    const response = await fetch(firstAudio.url);
    if (!response.ok) {
      throw new Error(`Failed to download Space audio (${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  throw new Error('Gradio Space returned audio without downloadable url');
}

function convertToVoiceNote(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('libopus')
      .audioBitrate('48k')
      .audioChannels(1)
      .audioFrequency(48000)
      .format('ogg')
      .outputOptions([
        '-application voip',
        '-vbr on',
        '-compression_level 10'
      ])
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

async function synthesizeRyoVoiceNote(text) {
  if (!hfClient) {
    throw new Error('HF_API_KEY missing');
  }

  const normalized = normalizeVoiceText(text);
  if (!normalized) {
    return null;
  }

  const tempBase = path.join(os.tmpdir(), `ryo-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const wavPath = `${tempBase}.wav`;
  const oggPath = `${tempBase}.ogg`;

  try {
    let audioBuffer;
    try {
      const audioBlob = await hfClient.textToSpeech({
        model: RYO_TTS_MODEL,
        provider: RYO_TTS_PROVIDER,
        inputs: normalized
      });
      audioBuffer = Buffer.from(await audioBlob.arrayBuffer());
    } catch (sdkError) {
      try {
        audioBuffer = await synthesizeViaDirectInference(normalized);
      } catch (directError) {
        try {
          audioBuffer = await synthesizeViaGradioSpace(normalized);
        } catch (spaceError) {
          throw new Error(spaceError?.message || directError?.message || sdkError?.message || 'Voice synthesis failed');
        }
      }
    }

    await writeBuffer(wavPath, audioBuffer);
    await convertToVoiceNote(wavPath, oggPath);

    return {
      buffer: await fs.promises.readFile(oggPath),
      mimetype: 'audio/ogg; codecs=opus',
      model: RYO_TTS_MODEL
    };
  } finally {
    await Promise.allSettled([
      fs.promises.unlink(wavPath),
      fs.promises.unlink(oggPath)
    ]);
  }
}

module.exports = {
  voiceEnabled,
  canUseHfVoice,
  synthesizeRyoVoiceNote
};
