const { InferenceClient } = require("@huggingface/inference");
const OpenAI = require("openai");
const { withTimeout, retry } = require("../utils/async");
const { normalizeJid } = require("../utils/jid");
const { detectIntent } = require("./chatbot/intentRouter");
const { createInitialThread, updateThreadState, registerRunningJoke } = require("./chatbot/stateEngine");
const {
  loadMemory,
  saveMemory,
  hydrateMemoryFromSupabase,
  getUserMemory,
  setUserName,
  upsertFact,
  upsertJoke,
  setUserMood,
  updateUserDynamics,
  inferFactType
} = require("./chatbot/memoryStore");
const { pickRelevantMemory } = require("./chatbot/memoryRetrieval");
const { buildMessages } = require("./chatbot/promptBuilder");
const {
  detectMood,
  applyMoodSwitch,
  moodInstruction,
  chooseStyle,
  styleInstruction
} = require("./chatbot/moodEngine");
const {
  sanitizeReply,
  finalizeReply,
  scoreReply,
  needsRegen,
  buildRegenHint,
  applyDeterministicCallback,
  applyTopicFlavor
} = require("./chatbot/outputGuard");

function createChatbotService(options = {}) {
  const logger = options.logger;
  const socialState = options.socialState || null;
  const profile = options.profile || null;
  const characterProfile = options.characterProfile || {
    name: "Ryo Yamada",
    series: "Bocchi the Rock",
    identityLine: "Ryo Yamada from Bocchi the Rock"
  };
  const memory = new Map();
  let memoryDb = loadMemory();
  const memoryReady = hydrateMemoryFromSupabase(memoryDb)
    .then((nextDb) => {
      memoryDb = nextDb || memoryDb;
      return memoryDb;
    })
    .catch(() => memoryDb);
  let hf = null;
  let openai = null;
  let groq = null;
  const botEnvPrefix = String(profile?.botId || characterProfile?.name || "eclipse")
    .trim()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

  const maxThreads = Number(process.env.CHATBOT_MAX_THREADS || 2000);
  const maxTurns = Number(process.env.CHATBOT_MAX_TURNS || 6);

  function isRezeCharacter(targetCharacter = characterProfile) {
    const name = String(targetCharacter?.name || "").trim();
    const identityLine = String(targetCharacter?.identityLine || "").trim();
    return /^reze$/i.test(name) || /\breze\b/i.test(identityLine); // FIXED: character-based Reze detection
  }

  function isHaimiyaProfile() {
    const botName = String(profile?.botName || characterProfile?.name || "").toLowerCase();
    const identityLine = String(characterProfile?.identityLine || "").toLowerCase();
    return botName.includes("haimiya") || botName.includes("hamiya") || identityLine.includes("haimiya"); // FIXED: Haimiya profile detection
  }

  function isTargetedHaimiyaAbuse(input = "") {
    if (!isHaimiyaProfile()) return false;
    const low = String(input || "").toLowerCase();
    if (!low) return false;

    const targetsHaimiya =
      /\b(haimiya|hamiya)(?:\s+senpai)?\b/.test(low) ||
      /\b(you|u|your)\b/.test(low);
    if (!targetsHaimiya) return false;

    const strongAbuse =
      /\bfuck you\b/.test(low) ||
      /\bfuck off\b/.test(low) ||
      /\bbitch\b/.test(low) ||
      /\bnigga\b|\bnigger\b/.test(low) ||
      /\bslut\b/.test(low) ||
      /\bwhore\b/.test(low) ||
      /\bstupid (?:bitch|hoe)\b/.test(low);

    return strongAbuse; // FIXED: only targeted abuse flips Haimiya into roast mode
  }

  function buildHaimiyaRoastReply(input = "") {
    const low = String(input || "").toLowerCase();
    if (/\bnigga\b|\bnigger\b/.test(low)) {
      return randomOf([
        "thats the best you could come up with? ugly mouth, empty head.",
        "using slurs already? hm. loud people are usually the easiest to ignore.",
        "you sound desperate when you talk like that. try having an actual personality."
      ]); // FIXED: Haimiya targeted slur roast
    }
    if (/\bfuck you\b|\bfuck off\b/.test(low)) {
      return randomOf([
        "what's with that attitude? if youre going to bark, at least say something clever.",
        "aww, that all? you came at me heated and still sounded boring.",
        "so hostile for no reason. calm down before you embarrass yourself more."
      ]); // FIXED: Haimiya targeted profanity roast
    }
    return randomOf([
      "if youre trying to be insulting, do better. that was kind of sad.",
      "hm. sharp tone, weak line. you can do better than that, can't you?",
      "you really came all the way over here just to sound childish?"
    ]); // FIXED: Haimiya abuse-only roast fallback
  }

  function envWithBotFallback(key, fallback = "") {
    const profileKeyMap = {
      HF_API_KEY: "hfApiKey",
      OPENAI_API_KEY: "openaiApiKey",
      GROQ_API_KEY: "groqApiKey",
      GEMINI_API_KEY: "geminiApiKey",
      OLLAMA_API_KEY: "ollamaApiKey"
    };
    const profileValue = profileKeyMap[key] ? profile?.[profileKeyMap[key]] : "";
    return String(profileValue || process.env[`${botEnvPrefix}_${key}`] || process.env[key] || fallback).trim();
  }

  const hfApiKey = envWithBotFallback(
    "HF_API_KEY",
    String(
      process.env.HUGGINGFACE_API_KEY ||
      process.env.HF_TOKEN ||
      ""
    ).trim()
  ) || envWithBotFallback("HUGGINGFACE_API_KEY") || envWithBotFallback("HF_TOKEN");
  const aiProxyUrl = String(
    profile?.aiProxyUrl ||
    process.env[`${botEnvPrefix}_AI_PROXY_URL`] ||
    process.env.AI_PROXY_URL ||
    'http://127.0.0.1:3000/v1/chat'
  ).trim();
  const aiProxyKey = String(
    profile?.aiProxyKey ||
    process.env[`${botEnvPrefix}_AI_PROXY_KEY`] ||
    process.env.AI_PROXY_KEY ||
    ''
  ).trim();
  const aiProxyModel = String(
    profile?.aiProxyModel ||
    process.env[`${botEnvPrefix}_AI_PROXY_MODEL`] ||
    process.env.AI_PROXY_MODEL ||
    'qwen2:latest'
  ).trim();
  const ollamaCloudUrl = String(
    profile?.ollamaCloudUrl ||
    process.env[`${botEnvPrefix}_OLLAMA_CLOUD_URL`] ||
    process.env.OLLAMA_CLOUD_URL ||
    'https://ollama.com/api/chat'
  ).trim();
  const ollamaCloudModel = String(
    profile?.ollamaCloudModel ||
    process.env[`${botEnvPrefix}_OLLAMA_CLOUD_MODEL`] ||
    process.env.OLLAMA_CLOUD_MODEL ||
    'gpt-oss:120b'
  ).trim();

  async function reply(message) {
    await memoryReady;
    const input = String(message && message.text ? message.text : "").trim();
    if (!input) return "";
    if (isTargetedHaimiyaAbuse(input)) {
      return { texts: [buildHaimiyaRoastReply(input)], delayMs: 0, style: "dry", mood: "dry" }; // FIXED: abuse-only Haimiya roast response
    }

    const key = threadKey(message.chatId, message.senderId);
    const userId = userMemoryKey(message.senderId);
    const thread = getThread(key);
    const socialProfile =
      socialState && typeof socialState.getUserProfile === "function"
        ? socialState.getUserProfile(message.senderId, message.pushName)
        : null;
    thread.updatedAt = Date.now();

    const userMemory = getUserMemory(memoryDb, userId);
    updateDynamicsFromInput(userMemory, input);
    const nextMood = detectMood(input, userMemory);
    const switchedMood = applyMoodSwitch(userMemory.mood, nextMood, input);
    setUserMood(memoryDb, userId, switchedMood);
    thread.state.mood = switchedMood.current;

    const intent = detectIntent(input, thread);
    updateThreadState(thread, input, intent);

    updateProfileFromInput(thread, input);
    updatePersistentMemoryFromInput(memoryDb, userId, input, thread.profile, message.pushName);
    updateTopicContext(thread, input);

    if (isRepetitiveSpam(input, thread.history)) {
      console.log(`[chatbot] ignoring repetitive spam from ${message.senderId}: "${input}"`);
      return "";
    }

    thread.history.push({ role: "user", content: input });
    thread.history = thread.history.slice(-maxTurns * 2);

    const refreshedMemory = getUserMemory(memoryDb, userId);
    const retrieved = pickRelevantMemory(refreshedMemory, input, intent);
    const mood = {
      current: refreshedMemory.mood.current,
      intensity: refreshedMemory.mood.intensity,
      instruction: moodInstruction(refreshedMemory.mood.current, refreshedMemory.mood.intensity)
    };
    const styleName = chooseStyle({
      mood: refreshedMemory.mood.current,
      intent,
      input,
      state: thread.state
    });
    const relationStyle = relationToStyle(socialProfile && socialProfile.relation);
    const effectiveStyleName = relationStyle || styleName;
    const style = {
      name: effectiveStyleName,
      instruction: styleInstruction(effectiveStyleName)
    };

    const baseMessages = buildMessages({
      history: thread.history,
      input,
      state: thread.state,
      profile: thread.profile,
      intent,
      retrieved,
      mood,
      style,
      character: characterProfile
    });

    const isReze = isRezeCharacter();
    let providerFailed = false;
    const responseText = await callProvider(baseMessages, intent).catch((error) => {
      providerFailed = true;
      const errorMessage = (error && error.message ? error.message : String(error)).toLowerCase();
      const statusCode = extractStatusCode(error);
      if (!(
                  (errorMessage.includes('bad mac') && (errorMessage.includes('session') || errorMessage.includes('decrypt'))) ||
            // "MessageCounterError: Key used already or never filled"
            errorMessage.includes('messagecountererror')
          )) {
        logger.warn(
          {
            error: errorMessage,
            statusCode,
            intent
          },
          "Chatbot provider failed after retries"
        );
      }
      if (isReze) return "";
      return fallbackReply(input, statusCode, intent, characterProfile);
    });

    let out = sanitizeReply(responseText);
    if (!out) return "";

    // Removed regen logic for maximum speed
    /*
    let score = scoreReply(out, input, thread);
    if (needsRegen(score)) {
      ...
    }
    */

    if (providerFailed && !isReze) {
      out = applyDeterministicCallback(out, input, thread);
      out = applyTopicFlavor(out, input, style.name);
      out = applyRunningJoke(out, input, refreshedMemory);
      out = forceDirectAnswer(input, out, intent, characterProfile);
      out = applyRelationshipTone(out, input, refreshedMemory, intent);
    }
    out = enforceRezeIdentity(out, input, characterProfile);
    out = finalizeReply(out);
    out = completeIncompleteReply(out, input, intent, style.name, characterProfile);
    out = avoidRepetition(out, thread, intent, style.name, characterProfile);
    out = limitRomanticRyoReply(out, characterProfile);

    if (!out) return "";

    thread.history.push({ role: "assistant", content: out });
    thread.history = thread.history.slice(-maxTurns * 2);

    updateJokeStrength(thread, out, userId);
    updateDynamicsAfterReply(refreshedMemory, input, out);
    updateUserDynamics(memoryDb, userId, {
      relationship: refreshedMemory.relationship,
      behavior: refreshedMemory.behavior,
      topics: refreshedMemory.topics,
      nicknames: refreshedMemory.nicknames
    });
    saveMemory(memoryDb, userId);
    enforceThreadLimit();

    return { texts: [out], delayMs: 0 };
  }

  async function callProvider(messages, intent) {
    return retry(
      () =>
        withTimeout(
          () => requestModelWithFallbacks(messages, intent),
          Number(process.env.CHATBOT_TIMEOUT_MS || 12000),
          "Chatbot timeout"
        ),
      {
        retries: Number(process.env.CHATBOT_RETRIES || 2),
        delayMs: Number(process.env.CHATBOT_RETRY_DELAY_MS || 450)
      }
    );
  }

  async function requestModelWithFallbacks(messages, intent) {
    const order = buildProviderOrder();
    const errors = [];

    for (const provider of order) {
      try {
        if (provider === "ollama-cloud") return await requestOllamaCloud(messages, intent);
        if (provider === "ai-proxy") return await requestAiProxy(messages, intent);
        if (provider === "openai") return await requestOpenAI(messages, intent);
        if (provider === "groq") return await requestGroq(messages, intent);
        if (provider === "huggingface") return await requestHuggingFace(messages, intent);
        if (provider === "gemini") return await requestGemini(messages, intent);
      } catch (error) {
        const errorMsg = (error && error.message ? error.message : String(error)).toLowerCase();
        if (
            errorMsg.includes('failed to decrypt') || 
            errorMsg.includes('session error') ||
            errorMsg.includes('messagecountererror')) {
            throw error;
        }
        errors.push({
          provider,
          error: errorMsg,
          statusCode: extractStatusCode(error)
        });
      }
    }

    const last = errors[errors.length - 1];
    const err = new Error(last ? `${last.provider} failed: ${last.error}` : "All providers failed");
    err.fallbackErrors = errors;
    throw err;
  }

  function buildProviderOrder() {
    const profileProviders = []
      .concat(Array.isArray(profile?.chatbotProviders) ? profile.chatbotProviders : [])
      .concat(Array.isArray(profile?.providers) ? profile.providers : []);

    if (profileProviders.length) {
      const filteredProfileProviders = profileProviders.filter((p) => providerAvailable(p));
      if (filteredProfileProviders.length) return filteredProfileProviders;
    }

    const configuredPrimary = envWithBotFallback("CHATBOT_PROVIDER").toLowerCase();
    const configuredSecondary = envWithBotFallback("CHATBOT_FALLBACK_PROVIDER", "groq")
      .trim()
      .toLowerCase();
    const configuredTertiary = envWithBotFallback("CHATBOT_FALLBACK_PROVIDER_2")
      .trim()
      .toLowerCase();
    const primary = configuredPrimary || "groq";
    const ordered = Array.from(new Set([primary, configuredSecondary, configuredTertiary])).filter(Boolean);
    const filtered = ordered.filter((p) => providerAvailable(p));
    if (filtered.length) return filtered;
    return ["huggingface", "groq"];
  }

  function providerAvailable(provider) {
    if (provider === "ollama-cloud") return Boolean(envWithBotFallback("OLLAMA_API_KEY"));
    if (provider === "ai-proxy") return Boolean(aiProxyUrl && aiProxyKey);
    if (provider === "openai") return Boolean(envWithBotFallback("OPENAI_API_KEY"));
    if (provider === "groq") return Boolean(envWithBotFallback("GROQ_API_KEY"));
    if (provider === "huggingface") {
      return Boolean(hfApiKey);
    }
    if (provider === "gemini") return Boolean(envWithBotFallback("GEMINI_API_KEY"));
    return true;
  }

  async function requestAiProxy(messages, intent) {
    if (!aiProxyUrl) throw new Error("AI proxy URL missing");
    if (!aiProxyKey) throw new Error("AI proxy key missing");

    const isReze = isRezeCharacter();
    const recentMessages = messages
      .filter((message) => message && message.role !== "system")
      .slice(isReze ? -4 : -8);

    const system = messages
      .filter((message) => message?.role === 'system')
      .map((message) => String(message.content || '').trim())
      .filter(Boolean)
      .join('\n\n')
      .slice(0, isReze ? 900 : 4000);

    const prompt = recentMessages
      .map((message) => `${message.role}: ${String(message.content || '').trim()}`)
      .join('\n')
      .slice(0, isReze ? 1200 : 6000);

    const response = await fetch(aiProxyUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aiProxyKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt,
        system,
        model: aiProxyModel,
        options: {
          temperature: selectTemperature(intent),
          top_p: Number(process.env.CHATBOT_TOP_P || 0.9),
          max_tokens: Number(process.env.CHATBOT_MAX_TOKENS || 256)
        }
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const error = new Error(`ai-proxy http ${response.status} ${text}`.slice(0, 500));
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
    const text = String(data?.response || '').trim();
    if (!text) throw new Error('ai-proxy empty response');
    return text.replace(/^"(.*)"$/s, '$1').trim();
  }

  async function requestOllamaCloud(messages, intent) {
    const apiKey = envWithBotFallback("OLLAMA_API_KEY");
    if (!apiKey) throw new Error("OLLAMA_API_KEY missing");

    const isReze = isRezeCharacter();
    const payloadMessages = messages.slice(isReze ? -6 : -12).map((message) => ({
      role: message.role,
      content: String(message.content || "").slice(0, isReze ? 1200 : 4000)
    }));

    const response = await fetch(ollamaCloudUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: ollamaCloudModel,
        messages: payloadMessages,
        stream: false,
        options: {
          temperature: selectTemperature(intent),
          top_p: Number(process.env.CHATBOT_TOP_P || 0.9),
          num_predict: Number(process.env.CHATBOT_MAX_TOKENS || 256)
        }
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new Error(`ollama-cloud http ${response.status} ${text}`.slice(0, 500));
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
    const text = String(data?.message?.content || data?.response || "").trim();
    return text;
  }

  async function requestOpenAI(messages, intent) {
    const apiKey = envWithBotFallback("OPENAI_API_KEY");
    if (!apiKey) throw new Error("OPENAI_API_KEY missing");
    if (!openai) openai = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });

    const completion = await openai.chat.completions.create({
      model: envWithBotFallback("CHATBOT_MODEL", "gpt-4o-mini"),
      messages,
      temperature: selectTemperature(intent),
      max_tokens: Number(process.env.CHATBOT_MAX_TOKENS || 256),
      top_p: Number(process.env.CHATBOT_TOP_P || 0.9)
    });

    return (
      completion &&
      completion.choices &&
      completion.choices[0] &&
      completion.choices[0].message &&
      completion.choices[0].message.content
    ) || "";
  }

  async function requestGroq(messages, intent) {
    const apiKey = envWithBotFallback("GROQ_API_KEY");
    if (!apiKey) throw new Error("GROQ_API_KEY missing");
    if (!groq) {
      groq = new OpenAI({
        apiKey,
        baseURL: "https://api.groq.com/openai/v1",
        dangerouslyAllowBrowser: true
      });
    }

    const completion = await groq.chat.completions.create({
      model: envWithBotFallback("GROQ_MODEL", "llama-3.3-70b-versatile"),
      messages,
      temperature: selectTemperature(intent),
      max_tokens: Number(process.env.CHATBOT_MAX_TOKENS || 256),
      top_p: Number(process.env.CHATBOT_TOP_P || 0.9)
    });

    return (
      completion &&
      completion.choices &&
      completion.choices[0] &&
      completion.choices[0].message &&
      completion.choices[0].message.content
    ) || "";
  }

  async function requestHuggingFace(messages, intent) {
    const apiKey = hfApiKey;
    if (!apiKey) throw new Error("HF_API_KEY missing");

    const models = modelCandidates(profile);
    let lastError = null;

    for (const model of models) {
      try {
        const response = await fetch("https://router.huggingface.co/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: Number(process.env.CHATBOT_MAX_TOKENS || 256),
            temperature: selectTemperature(intent),
            top_p: Number(process.env.CHATBOT_TOP_P || 0.9)
          })
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          const err = new Error(`HF chat HTTP ${response.status} ${detail}`.slice(0, 500));
          err.status = response.status;
          throw err;
        }

        const out = await response.json();
        const text =
          out && out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content
            ? String(out.choices[0].message.content)
            : "";

        if (text) return text;
      } catch (error) {
        lastError = error;
        const statusCode = extractStatusCode(error);
        if (statusCode === 401 || statusCode === 403) throw error;
      }
    }

    if (!hf) hf = new InferenceClient(apiKey);
    const provider = envWithBotFallback("HF_PROVIDER", "hf-inference");

    for (const model of models) {
      try {
        const out = await hf.chatCompletion(
          {
            provider,
            model,
            messages,
            max_tokens: Number(process.env.CHATBOT_MAX_TOKENS || 256),
            temperature: selectTemperature(intent),
            top_p: Number(process.env.CHATBOT_TOP_P || 0.9)
          },
          { retry_on_error: false }
        );

        const text =
          out && out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content
            ? String(out.choices[0].message.content)
            : "";

        if (text) return text;
      } catch (error) {
        lastError = error;
        const statusCode = extractStatusCode(error);
        if (statusCode === 401 || statusCode === 403) throw error;
      }
    }

    throw lastError || new Error("HF inference failed");
  }

  async function requestGemini(messages, intent) {
    const apiKey = envWithBotFallback("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY missing");

    const model = envWithBotFallback("GEMINI_MODEL", "gemini-2.5-flash-lite");
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const convo = messages
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const prompt = `${system}\n\nConversation:\n${convo}\n\nassistant:`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: selectTemperature(intent),
          topP: Number(process.env.CHATBOT_TOP_P || 0.9),
          maxOutputTokens: Number(process.env.CHATBOT_MAX_TOKENS || 256)
        }
      })
    });

    if (!response.ok) {
      const txt = await response.text().catch(() => "");
      const err = new Error(`gemini http ${response.status} ${txt}`.slice(0, 500));
      err.status = response.status;
      throw err;
    }

    const data = await response.json();
    const text =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text
        ? String(data.candidates[0].content.parts[0].text)
        : "";

    if (!text) throw new Error("Gemini empty response");
    return text;
  }

  function getThread(key) {
    let thread = memory.get(key);
    if (!thread) {
      thread = createInitialThread();
      memory.set(key, thread);
    }
    return thread;
  }

  function enforceThreadLimit() {
    if (memory.size <= maxThreads) return;
    const entries = Array.from(memory.entries()).sort(
      (a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0)
    );
    const overflow = memory.size - maxThreads;
    for (let i = 0; i < overflow; i += 1) {
      memory.delete(entries[i][0]);
    }
  }

  async function query(prompt) {
    await memoryReady;
    const text = String(prompt || "").trim();
    if (!text) return "";
    const messages = [
      { role: "system", content: "You are a concise helpful assistant. Keep answers short and clear." },
      { role: "user", content: text }
    ];

    try {
      const response = await callProvider(messages, "question");
      return sanitizeReply(response);
    } catch (error) {
      logger.warn({ error: error && error.message ? error.message : String(error) }, "query failed");
      return "";
    }
  }

  return { reply, query };

  async function buildAiOnlyTwoLinePayload(primaryText, baseMessages, intent) {
    const first = firstLine(primaryText) || "hmm";
    return { texts: [first], delayMs: 0 };
  }
}

function updateProfileFromInput(thread, input) {
  if (!thread || !thread.profile) return;
  const text = String(input || "").toLowerCase();
  const p = thread.profile;

  if (/\bgoon\w*\b|\bjerk\w*\b/.test(text)) p.goons += 1;
  if (/\banime\b|\bmanga\b|\bwaifu\b/.test(text)) p.anime += 1;
  if (/\b99\b|\b9+9\b/.test(text)) p.lies += 1;

  const ageMatch = text.match(/\b(\d{1,3})\s*(yo|yr|year|years)\b/);
  if (ageMatch) p.ageClaim = ageMatch[1];
}

function updatePersistentMemoryFromInput(db, userId, input, profile, pushName) {
  const text = String(input || "").toLowerCase();
  if (pushName) setUserName(db, userId, pushName);

  if (/\banime\b|\bmanga\b|\bwaifu\b/.test(text)) {
    upsertFact(db, userId, { text: "likes anime", type: "interest", weight: 0.75 });
    registerUserJoke(db, userId, "anime kid", 0.65);
  }

  if (/\bgoon\w*\b|\bjerk\w*\b/.test(text)) {
    upsertFact(db, userId, { text: "gooner behavior", type: "running_joke", weight: 0.82 });
    registerUserJoke(db, userId, "gooner", 0.82);
  }

  if (/\b99\b|\b9+9\b/.test(text)) {
    upsertFact(db, userId, { text: "claims to be 99yo", type: "identity", weight: 0.9 });
    registerUserJoke(db, userId, "fake 99yo", 0.92);
  }

  if (/\bhaha\b|\blol\b|\blmao\b|\bfunny\b/.test(text)) {
    upsertFact(db, userId, { text: "uses humor", type: "conversation_preference", weight: 0.6 });
  }

  if (isSelfLocationMessage(text)) {
    upsertFact(db, userId, {
      text: extractShortLocationLine(text),
      type: inferFactType("city"),
      weight: 0.55
    });
  }

  if (profile && profile.ageClaim) {
    upsertFact(db, userId, {
      text: `claims to be ${profile.ageClaim}yo`,
      type: "identity",
      weight: 0.72
    });
  }

  saveMemory(db, userId);
}

function registerUserJoke(db, userId, joke, strength) {
  upsertJoke(db, userId, joke, strength);
}

function updateJokeStrength(thread, reply, userId) {
  if (!thread || !thread.state) return;
  const out = String(reply || "").toLowerCase();
  if (out.includes("gooner")) registerRunningJoke(thread, "gooner");
  if (out.includes("99")) registerRunningJoke(thread, "fake 99yo");
  if (out.includes("anime")) registerRunningJoke(thread, "anime kid");
  thread.state.lastUserId = userId;
}

function selectTemperature(intent) {
  if (intent === "question") return 0.6;
  if (intent === "comfort") return 0.68;
  if (intent === "dry") return 0.55;
  if (intent === "roast") return 0.72;
  return Number(process.env.CHATBOT_TEMPERATURE || 0.75);
}

function isRezeCharacterProfile(characterProfile = {}) {
  const name = String(characterProfile?.name || "").trim();
  const identityLine = String(characterProfile?.identityLine || "").trim();
  return /^reze$/i.test(name) || /\breze\b/i.test(identityLine); // FIXED: shared character identity helper
}

function isHaimiyaProfile(profile = {}, characterProfile = {}) {
  const botName = String(profile?.botName || characterProfile?.name || "").toLowerCase();
  const identityLine = String(characterProfile?.identityLine || "").toLowerCase();
  return botName.includes("haimiya") || botName.includes("hamiya") || identityLine.includes("haimiya"); // FIXED: shared Haimiya detection
}

function avoidRepetition(reply, thread, intent, styleName, characterProfile = {}) {
  const out = String(reply || "").trim();
  const low = out.toLowerCase();
  const recent = (thread && thread.history ? thread.history : [])
    .filter((x) => x && x.role === "assistant" && x.content)
    .slice(-5)
    .map((x) => String(x.content).toLowerCase());
  if (!recent.some((line) => looksLikeDuplicate(line, low))) return out;

  const fallbackByIntent = {
    question: "answer me straight then",
    comfort: "that sounds rough actually",
    roast: "you keep making this easy",
    flirty: "you say things like that on purpose huh",
    callback: "i still remember enough",
    dry: "say what you mean",
    casual: "alright keep going"
  };
  const isReze = isRezeCharacterProfile(characterProfile);
  if (isReze) {
    return out;
  }

  const styleFallback = {
    dry: "be direct",
    tease: "youre trying a little too hard huh",
    roast: "that barely made sense",
    chaotic: "this chat is doing too much"
  };
  if (styleName && styleFallback[styleName]) return styleFallback[styleName];
  return fallbackByIntent[intent] || "keep talking";
}

function threadKey(chatId, userId) {
  return `${normalizeJid(chatId || "")}:${normalizeJid(userId || "")}`;
}

function fallbackReply(input, statusCode, intent, characterProfile = {}) {
  if (statusCode === 402) return "credits issue owner refill then i talk";
  if (statusCode === 401 || statusCode === 403) return "token bad tell owner fix key";

  const low = String(input || "").toLowerCase();

  if (isRezeCharacterProfile(characterProfile)) {
    return "";
  }

  const name = String(characterProfile.name || "Ryo Yamada").trim();
  const identityLine = String(characterProfile.identityLine || name || "Ryo Yamada").trim();
  if (/ryo/i.test(name) || /bocchi/i.test(identityLine)) {
    if (intent === "comfort") return "come closer. breathe slowly, love";
    if (intent === "question") return "hmm ask me softer";
    return "im here, quietly yours";
  }
  if (intent === "question") return "hmm ask again clear";
  if (intent === "comfort") return Math.random() < 0.45
    ? "yeah that actually sucks"
    : "hmm i see. youll be alright";
  if (low.includes("anime")) return "anime again tell title";
  if (low.includes("music")) return "music okay what track";
  if (name && low.includes(name.toLowerCase().split(" ")[0])) return `im here. ${identityLine.toLowerCase()}`;
  return "api sleepy but im here";
}

function limitRomanticRyoReply(reply, characterProfile = {}) {
  const name = String(characterProfile.name || "");
  const identityLine = String(characterProfile.identityLine || "");
  if (!/ryo/i.test(name) && !/bocchi/i.test(identityLine)) return String(reply || "").trim();

  const cleaned = String(reply || "")
    .replace(/\b(rude|savage|roast(?:ed|ing)?|idiot|stupid|dumb)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length <= 30) return cleaned;
  return words.slice(0, Math.random() < 0.2 ? 30 : 20).join(" ");
}

function enforceRezeIdentity(reply, input, characterProfile = {}) {
  const isReze = isRezeCharacterProfile(characterProfile);
  if (!isReze) return String(reply || "").trim();

  const out = String(reply || "").trim();
  const low = out.toLowerCase();
  const inputLow = String(input || "").toLowerCase();

  if (!out) return out;

  if (
    /\bchatgpt\b|\bopenai\b|\blanguage model\b|\bai assistant\b|\bi[' ]?m an ai\b|\bi am an ai\b/.test(low)
  ) {
    if (/\bhow old are you\b|\bwhat('?s| is) your age\b|\byour age\b/.test(inputLow)) {
      return "old enough to tease you a little~";
    }
    if (/\bwhere are you from\b|\bwhere you from\b|\bfrom where\b|\bwhere from\b|\bwhich country are you from\b/.test(inputLow)) {
      return "tokyo, japan. nothing fancy~";
    }
    return "im reze, obviously~";
  }

  if (
    (/\breze\b/.test(inputLow) || /\bwho are you\b|\bare you ai\b|\bare you reze\b/.test(inputLow)) &&
    /if you.?re talking about|you.?re probably thinking of|character from|from chainsaw man|fictional character/.test(low)
  ) {
    return "im reze, obviously~";
  }

  if (/\bhow old are you\b|\byour age\b|\bage\??$/.test(inputLow) && /\bageless\b|\bcode\b/.test(low)) {
    return "old enough to tease you a little~";
  }

  if (
    /\bwhere are you from\b|\bwhere you from\b|\bfrom where\b|\bwhere from\b|\bwhich country are you from\b/.test(inputLow) &&
    (/shadow|neon nights|wander|dark|fictional|chainsaw man|born in/.test(low) || out.length > 60)
  ) {
    return "tokyo, japan. nothing fancy~";
  }

  if (
    /^reze[!.?~ ]*$/.test(inputLow) &&
    (/if you.?re talking about|you.?re probably thinking of|character from|chainsaw man/.test(low) || out.length > 50)
  ) {
    return "yeah? what is it?~";
  }

  return out;
}

function modelCandidates(profile) {
  if (isHaimiyaProfile(profile, profile?.characterProfile || {} ) || profile?.botId === 'reze') {
    return ["Qwen/Qwen2.5-7B-Instruct", "Qwen/Qwen2.5-Coder-7B-Instruct", "mistralai/Mistral-7B-Instruct-v0.2", "meta-llama/Llama-3.1-8B-Instruct"];
  }
  const primary = String(process.env.HF_MODEL || "Qwen/Qwen2.5-7B-Instruct").trim();
  const fallback = String(process.env.HF_FALLBACK_MODEL || "mistralai/Mistral-7B-Instruct-v0.2").trim();
  const extra = String(process.env.HF_FALLBACK_MODEL_2 || "google/gemma-2-2b-it").trim();
  return Array.from(new Set([primary, fallback, extra].filter(Boolean)));
}

function isIncompleteReply(text) {
  const out = String(text || "").trim();
  if (!out) return true;
  if (out.length < 4) return true;
  if (/[,:;/-]$/.test(out)) return true;

  const low = out.toLowerCase();
  if (/\b(i wanna|i want to|i need to|you need to|you want to|im gonna|i will|i can|i could|maybe i|maybe you)\s*$/.test(low)) {
    return true;
  }
  if (/\b(and|or|but|because|if|when|while|though|so|to|for|with|about|like)\s*$/.test(low)) {
    return true;
  }
  if (/\b(be|go|do|say|tell|make|try|see|know|think|talk)\s*$/.test(low) && out.split(/\s+/).length <= 4) {
    return true;
  }

  return false;
}

function completeIncompleteReply(reply, input, intent, styleName, characterProfile = {}) {
  if (!isIncompleteReply(reply)) return String(reply || "").trim();

  const isReze = isRezeCharacterProfile(characterProfile);
  const low = String(input || "").toLowerCase();

  if (isReze) {
    return "";
  }

  if (intent === "question") return "ask it clearly";
  if (intent === "comfort") return "say it slowly, im listening";
  if (intent === "roast") return "that barely made sense";
  return "go on properly";
}

function extractStatusCode(error) {
  if (!error || typeof error !== "object") return undefined;
  const errorMsg = String(error.message || error).toLowerCase();
  if (error.status) return Number(error.status);
  if (error.response && error.response.status) return Number(error.response.status);
  if (
        (errorMsg.includes('bad mac') && (errorMsg.includes('session') || errorMsg.includes('decrypt'))) ||
        errorMsg.includes('messagecountererror')
    ) return 400;
  if (error.cause && error.cause.status) return Number(error.cause.status);
  return undefined;
}

function userMemoryKey(jid) {
  return String(normalizeJid(jid || "").split("@")[0] || "").replace(/\D/g, "") || String(jid || "");
}

function updateDynamicsFromInput(userMemory, input) {
  const text = String(input || "").toLowerCase();
  const rel = userMemory.relationship || {};
  const behavior = userMemory.behavior || {};
  const topics = userMemory.topics || {};
  const now = Date.now();

  rel.lastSeenAt = now;
  rel.trust = clampNum(rel.trust, 0, 200) + 1;
  if (/\bthanks|thank you|good bot|nice\b/.test(text)) rel.level = clampNum(rel.level + 1, -5, 5);
  if (/\bstupid|idiot|wtf|shut up\b/.test(text)) rel.level = clampNum(rel.level - 1, -5, 5);
  if (/\blove you|miss you\b/.test(text)) rel.closeness = clampNum(rel.closeness + 1, 0, 100);
  if (/\bgo away|leave\b/.test(text)) rel.closeness = clampNum(rel.closeness - 1, 0, 100);

  behavior.toxic = clampNum((behavior.toxic || 0) + (/\bstupid|idiot|wtf|shut up\b/.test(text) ? 1 : -0.1), 0, 100);
  behavior.funny = clampNum((behavior.funny || 0) + (/\blol|haha|lmao|meme\b/.test(text) ? 1 : -0.05), 0, 100);
  behavior.dry = clampNum((behavior.dry || 0) + (/^(ok|k|hmm|fine)$/i.test(text.trim()) ? 1 : -0.05), 0, 100);
  behavior.horny = clampNum((behavior.horny || 0) + (/\bhorny|sex|boob|nude|kiss me\b/.test(text) ? 1 : -0.03), 0, 100);

  bumpTopic(topics, "anime", /\banime|manga|waifu|gojo|raiden|genshin\b/.test(text));
  bumpTopic(topics, "girls", /\bgf|bf|love|crush|kiss\b/.test(text));
  bumpTopic(topics, "jokes", /\blol|haha|meme|funny\b/.test(text));
  bumpTopic(topics, "rage", /\bwtf|idiot|stupid|fight\b/.test(text));

  if (/\b99\b/.test(text)) pushNickname(userMemory, "old man");
  if (/\bkazuki|planet|space\b/.test(text)) pushNickname(userMemory, "space kid");
  if (/\banime|edit\b/.test(text)) pushNickname(userMemory, "anime kid");

  userMemory.relationship = rel;
  userMemory.behavior = behavior;
  userMemory.topics = topics;
}

function updateTopicContext(thread, input) {
  if (!thread || !thread.state) return;
  if (!thread.state.convo || typeof thread.state.convo !== "object") {
    thread.state.convo = {
      topic: "",
      stage: "idle",
      lastQuestion: "",
      lastAnimeName: "",
      lastReplies: []
    };
  }

  const low = String(input || "").toLowerCase().trim();
  const isAnime = isAnimeTopic(low);
  const shortFollow = isShortFollowup(low);
  const convo = thread.state.convo;

  if (isAnime) {
    thread.state.lastTopic = "anime";
    thread.state.topicCarry = 3;
    convo.topic = "anime";
    if (convo.stage === "idle") convo.stage = "anime_open";
    return;
  }

  if (thread.state.lastTopic === "anime" && shortFollow && Number(thread.state.topicCarry || 0) > 0) {
    thread.state.topicCarry = Math.max(0, Number(thread.state.topicCarry || 0) - 1);
    convo.topic = "anime";
    convo.stage = "anime_follow";
    return;
  }

  thread.state.lastTopic = "";
  thread.state.topicCarry = 0;
  if (!shortFollow) {
    convo.topic = "";
    convo.stage = "idle";
    convo.lastQuestion = "";
    convo.lastAnimeName = "";
  }
}

function updateDynamicsAfterReply(userMemory, input, output) {
  const rel = userMemory.relationship || {};
  rel.lastBotReplyAt = Date.now();
  if (/\?/.test(String(input || "")) && !/\?/.test(String(output || ""))) {
    rel.trust = clampNum((rel.trust || 0) + 0.3, 0, 200);
  }
  userMemory.relationship = rel;
}

function applyRelationshipTone(reply, input, userMemory, intent) {
  const text = String(input || "").toLowerCase();
  const rel = userMemory.relationship || {};
  const level = Number(rel.level || 0);
  const closeness = Number(rel.closeness || 0);

  if (/\bi love you\b|\bgf\b|\bbf\b/.test(text)) {
    if (level <= -2) return "you switched up fast";
    if (level <= 1) return "hmm that was smooth";
    if (closeness < 15) return "you trying to flirt with me now?";
    return "keep talking like that and i might believe you";
  }

  if (intent === "roast" && level >= 2 && closeness >= 10 && Math.random() < 0.35) {
    return `${reply} ${pickNickname(userMemory)}`.trim();
  }
  if (intent === "flirty") {
    if (closeness >= 12 || level >= 1) return `${reply} ${randomOf(["youre cute", "not bad", "keep going"])}`.trim();
    return `${reply} ${randomOf(["you trying to charm me?", "smooth line", "thats kinda cute"])}`.trim();
  }
  if (intent === "casual" && level <= -3) {
    return "go on";
  }
  return reply;
}

function applyRunningJoke(reply, input, userMemory) {
  const low = String(input || "").toLowerCase();
  const jokes = Array.isArray(userMemory.jokes) ? userMemory.jokes : [];
  if (!jokes.length) return reply;

  const ranked = jokes
    .map((j) => ({ text: String(j.text || ""), strength: Number(j.strength || 0.5), score: scoreJoke(j, low) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 0.75) return reply;

  const extra = escalateJoke(best.text, best.strength);
  if (!extra) return reply;
  return `${reply} ${extra}`.trim();
}

function forceDirectAnswer(input, output, intent, characterProfile = {}) {
  const text = String(input || "").toLowerCase();
  if (!text.includes("?") && intent !== "question") return output;

  const name = String(characterProfile.name || "Ryo Yamada").trim();
  const identityLine = String(characterProfile.identityLine || name || "Ryo Yamada").trim();

  if (/\bwhat phone|phone model|which phone\b/.test(text)) return "iphone";
  if (/\bhow are you\b/.test(text)) return "alive still";
  if (/\bwho are you\b/.test(text)) return identityLine.toLowerCase();
  if (/\bwhere are you\b/.test(text)) return "home mostly";
  if (/\bhow old\b/.test(text)) return "20";

  if (/\bmaybe|perhaps|idk|cant answer|no idea\b/i.test(output)) {
    return "say it clear";
  }
  return output;
}

function maybeStackReplies(base, intent, style, userMemory) {
  const lines = [String(base || "").trim()].filter(Boolean);
  if (!lines.length) return "";

  const chance = intent === "comfort" ? 0.18 : (intent === "roast" || style === "chaotic" ? 0.14 : 0.06);
  if (Math.random() < chance) {
    lines.push(randomStackLine(intent, style, userMemory));
    if (Math.random() < 0.12) lines.push(randomStackTail(style));
  }

  const delayMs = Math.random() < 0.15 ? randomInt(2000, 8000) : 0;
  return dedupePayload({ texts: lines.slice(0, 3), delayMs });
}

function buildAnimeTopicPayload(input, thread, userMemory) {
  const low = String(input || "").toLowerCase().trim();
  const convo = ensureConvoState(thread);
  const active =
    isAnimeTopic(low) ||
    (thread &&
      thread.state &&
      thread.state.lastTopic === "anime" &&
      Number(thread.state.topicCarry || 0) > 0 &&
      isShortFollowup(low));

  if (!active) return null;

  const pair = animeModeReplyPair(low, userMemory, convo);
  if (!pair || !pair.length) return null;

  convo.lastReplies = pair.slice(-2);
  return {
    texts: pair.slice(0, 2),
    delayMs: randomInt(800, 1800)
  };
}

function animeModeReplyPair(inputLow, userMemory, convo) {
  const name = detectAnimeName(inputLow);
  const likesAnime = Number((userMemory && userMemory.topics && userMemory.topics.anime) || 0) >= 2;

  if (/^yes$|^yeah$|^yup$|^haan$|^han$|^hmm$|^hm$/.test(inputLow)) {
    if (convo.lastQuestion === "anime_seen_bocchi") {
      convo.stage = "anime_reacted_seen";
      convo.lastQuestion = "";
      return pickNonRepeat(
        [
          ["aye.. same", "bocchi is peak for me"],
          ["good", "music carried hard"],
          ["finally", "someone with taste"]
        ],
        convo
      );
    }
    if (convo.lastQuestion === "anime_title") {
      convo.stage = "anime_waiting_title";
      return pickNonRepeat(
        [
          ["title?", "dont dodge now"],
          ["name it", "no basic answer"],
          ["which anime", "say one"]
        ],
        convo
      );
    }
    return pickNonRepeat([
      ["hmm", "go on"],
      ["okay", "and?"],
      ["yeah", "continue"]
    ], convo);
  }

  if (name === "bocchi" || name === "bochi" || name === "bochhi") {
    convo.lastAnimeName = "bocchi";
    if (convo.lastQuestion === "anime_seen_bocchi") {
      return pickNonRepeat(
        [
          ["you said bocchi already", "you noticed ryo?"],
          ["still bocchi?", "valid anyway"],
          ["yeah bocchi", "music carried"]
        ],
        convo
      );
    }

    convo.stage = "anime_title_known";
    convo.lastQuestion = "anime_seen_bocchi";
    return pickNonRepeat(
      [
        ["you actually watched it?", "rare"],
        ["bocchi mention?", "you watched full?"],
        ["you watched bocchi?", "dont fake it"]
      ],
      convo
    );
  }

  if (name) {
    convo.lastAnimeName = name;
    if (convo.lastQuestion === "anime_seen_other") {
      return pickNonRepeat(
        [
          ["same anime again?", "okay fair"],
          ["you said that", "still not bad"],
          ["hmm again", "continue"]
        ],
        convo
      );
    }

    convo.stage = "anime_title_known";
    convo.lastQuestion = "anime_seen_other";
    return pickNonRepeat(
      [
        [`${name}?`, "you watched full?"],
        [`you watched ${name}?`, "not just edits right"],
        [`${name} fan?`, "hmm interesting"]
      ],
      convo
    );
  }

  if (likesAnime) {
    if (convo.lastQuestion === "anime_title") {
      return pickNonRepeat(
        [
          ["still waiting title", "dont run now"],
          ["name one anime", "ill judge fast"],
          ["title first", "then we talk"]
        ],
        convo
      );
    }

    convo.lastQuestion = "anime_title";
    convo.stage = "anime_waiting_title";
    return pickNonRepeat(
      [
        ["which one", "dont say something basic"],
        ["drop title", "dont say mid stuff"],
        ["name one", "no fake anime fan"]
      ],
      convo
    );
  }

  if (convo.lastQuestion === "anime_title") {
    return pickNonRepeat(
      [
        ["you said anime", "name one then"],
        ["still no title?", "hmm"],
        ["title first", "then continue"]
      ],
      convo
    );
  }

  convo.lastQuestion = "anime_title";
  convo.stage = "anime_waiting_title";
  return pickNonRepeat(
    [
      ["you watch anime?", "which one"],
      ["anime talk?", "name one good show"],
      ["hmm anime", "say title"]
    ],
    convo
  );
}

function ensureConvoState(thread) {
  if (!thread || !thread.state) {
    return {
      topic: "",
      stage: "idle",
      lastQuestion: "",
      lastAnimeName: "",
      lastReplies: [],
      sinceQuestion: 0,
      nextQuestionAt: randomInt(5, 8)
    };
  }
  if (!thread.state.convo || typeof thread.state.convo !== "object") {
    thread.state.convo = {
      topic: "",
      stage: "idle",
      lastQuestion: "",
      lastAnimeName: "",
      lastReplies: [],
      sinceQuestion: 0,
      nextQuestionAt: randomInt(2, 4)
    };
  }
  if (!Array.isArray(thread.state.convo.lastReplies)) thread.state.convo.lastReplies = [];
  if (!Number.isFinite(Number(thread.state.convo.sinceQuestion))) thread.state.convo.sinceQuestion = 0;
  if (!Number.isFinite(Number(thread.state.convo.nextQuestionAt)) || Number(thread.state.convo.nextQuestionAt) < 5) {
    thread.state.convo.nextQuestionAt = randomInt(5, 8);
  }
  return thread.state.convo;
}

function ensureQuestionCadence(payload, input, thread, intent, style) {
  const out = normalizePayload(payload);
  const convo = ensureConvoState(thread);
  const inputLow = String(input || "").toLowerCase().trim();
  const hindiLike = isHindiLikeText(inputLow);
  const inputIsQuestion = inputLow.includes("?");

  if (inputIsQuestion) {
    convo.sinceQuestion = 0;
    return out;
  }

  const hasQuestion = out.texts.some((t) => String(t).includes("?"));
  if (hasQuestion) {
    convo.sinceQuestion = 0;
    return out;
  }

  convo.sinceQuestion = Number(convo.sinceQuestion || 0) + 1;
  const needsCadenceQuestion = convo.sinceQuestion >= Number(convo.nextQuestionAt || 3);
  const needsContextQuestion =
    (convo.topic === "anime" && convo.lastQuestion === "anime_title") ||
    (intent === "question" && out.texts.length > 0 && !out.texts[0].includes("?"));

  if (!needsCadenceQuestion && !needsContextQuestion) return out;

  // Reduce auto-questions for Hindi/roman-Hindi chats.
  if (hindiLike) {
    const shouldAskInHindiMode =
      (intent === "question" && Math.random() < 0.3) ||
      (convo.topic === "anime" && convo.lastQuestion === "anime_title" && Math.random() < 0.2);
    if (!shouldAskInHindiMode) {
      convo.nextQuestionAt = randomInt(6, 10);
      return out;
    }
  }

  const q = pickFollowupQuestion(inputLow, thread, intent, style);
  if (!q) return out;

  if (out.texts.length < 3) out.texts.push(q);
  else out.texts[out.texts.length - 1] = q;

  convo.sinceQuestion = 0;
  convo.nextQuestionAt = hindiLike ? randomInt(6, 10) : randomInt(5, 8);
  return out;
}

function pickFollowupQuestion(inputLow, thread, intent, style) {
  const convo = ensureConvoState(thread);
  if (isHindiLikeText(inputLow) && Math.random() > 0.25) {
    return "";
  }
  if (intent === "casual" || intent === "flirty" || style === "tease" || style === "soft") {
    return "";
  }
  if (convo.topic === "anime") {
    return randomOf(["which one?", "you watched full?", "you noticed ryo?"]);
  }
  if (intent === "roast" || style === "roast") {
    return randomOf(["you serious?", "thats your plan?", "you sure about that?"]);
  }
  if (style === "chaotic") {
    return randomOf(["what is this chat?", "why are you like this?", "you okay?"]);
  }
  return randomOf(["what now?", "you good?", "why though?"]);
}

function applyOccasionalDottedTone(payload) {
  const out = normalizePayload(payload);
  if (Math.random() > 0.28) return out;
  if (!out.texts.length) return out;

  const idx = Math.floor(Math.random() * out.texts.length);
  out.texts[idx] = dotify(out.texts[idx]);
  return out;
}

function dotify(text) {
  const t = String(text || "").trim();
  if (!t || t.includes("..") || t.includes("?")) return t;
  if (t.split(/\s+/).length < 2) return t;

  if (/^ohh\b/i.test(t)) return t.replace(/^ohh\b/i, "ohh..");
  if (/^yeah\b/i.test(t)) return t.replace(/^yeah\b/i, "yeah..");
  if (/^hmm\b/i.test(t)) return t.replace(/^hmm\b/i, "hmm..");
  if (/^okay\b/i.test(t)) return t.replace(/^okay\b/i, "okay..");
  if (/^aye\b/i.test(t)) return t.replace(/^aye\b/i, "aye..");

  const words = t.split(/\s+/);
  if (words[0].length < 3) return t;
  words[0] = `${words[0]}..`;
  return words.join(" ");
}

function normalizePayload(payload) {
  if (!payload) return { texts: [], delayMs: 0 };
  if (typeof payload === "string") return { texts: [payload], delayMs: 0 };
  return {
    texts: Array.isArray(payload.texts) ? payload.texts.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 3) : [],
    delayMs: Math.max(0, Number(payload.delayMs || 0))
  };
}

function canonicalLine(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeDuplicate(a, b) {
  const left = canonicalLine(a);
  const right = canonicalLine(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;

  const leftWords = new Set(left.split(" ").filter(Boolean));
  const rightWords = new Set(right.split(" ").filter(Boolean));
  if (!leftWords.size || !rightWords.size) return false;

  let overlap = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) overlap += 1;
  }
  const ratio = overlap / Math.max(leftWords.size, rightWords.size);
  return ratio >= 0.72;
}

function isWeakFollowup(text) {
  const line = canonicalLine(text);
  if (!line) return true;
  return new Set([
    "say more",
    "talk later",
    "oh really",
    "youre funny",
    "you re funny",
    "youre weird",
    "you re weird",
    "go on",
    "hmm",
    "okay",
    "interesting",
    "im listening"
  ]).has(line);
}

function dedupePayload(payload, thread = null, primary = "") {
  const out = normalizePayload(payload);
  const recent = (thread && Array.isArray(thread.history) ? thread.history : [])
    .filter((x) => x && x.role === "assistant" && x.content)
    .slice(-5)
    .map((x) => String(x.content));

  const filtered = [];
  for (const line of out.texts) {
    if (!line) continue;
    if (isWeakFollowup(line) && filtered.length) continue;
    if (filtered.some((existing) => looksLikeDuplicate(existing, line))) continue;
    if (recent.some((existing) => looksLikeDuplicate(existing, line))) continue;
    filtered.push(line);
  }

  if (!filtered.length && primary) filtered.push(primary);
  return { texts: filtered.slice(0, 2), delayMs: out.delayMs };
}

function applyHighSignalReactions(payload, input, intent, style, userMemory, thread) {
  const out = normalizePayload(payload);
  const low = String(input || "").toLowerCase();

  // Strong bait triggers
  if (/\bnaruto died\b/.test(low)) {
    out.texts = [randomOf(["youre trolling", "you sound confident too", "you didnt even watch it properly"])];
    if (Math.random() < 0.45) out.texts.push(randomOf(["try harder", "thats weak bait", "you think thats funny?"]));
    return out;
  }

  if (/\bspoiler alert\b/.test(low)) {
    out.texts = [randomOf(["try me", "say it then", "go on"])];
    return out;
  }

  // Confidence check: obvious wrong + confident tone
  const confidentWrong =
    (/\b100%|sure|obviously|definitely|trust me\b/.test(low) && /\bwrong|fake|lie|died|impossible\b/.test(low)) ||
    /\bnaruto died bro\b/.test(low);
  if (confidentWrong) {
    out.texts = [randomOf(["you sound confident for no reason", "thats not how it works", "youre making stuff up"])];
    return out;
  }

  // Dumb statement roast opportunity
  const dumbSignal = /\bflat earth|2\+2=5|naruto died|anime is cartoon only\b/.test(low);
  if (dumbSignal && (intent === "roast" || style === "roast" || style === "tease")) {
    out.texts = [randomOf(["you really thought that made sense?", "nah thats dumb", "youre reaching hard"])];
    if (Math.random() < 0.3) out.texts.push("focus");
    return out;
  }

  // Troll escalation if same bait repeated
  const convo = ensureConvoState(thread);
  const baitKey = detectBaitKey(low);
  if (baitKey) {
    convo.baitHits = convo.baitHits || {};
    convo.baitHits[baitKey] = Number(convo.baitHits[baitKey] || 0) + 1;
    if (convo.baitHits[baitKey] >= 2) {
      out.texts = [randomOf(["same bait again?", "you only got one line?", "youre repeating yourself"])];
      return out;
    }
  }

  return out;
}

function detectBaitKey(low) {
  if (/\bnaruto died\b/.test(low)) return "naruto_died";
  if (/\bspoiler\b/.test(low)) return "spoiler";
  return "";
}

function enforceNoFiller(payload, input, intent, style) {
  const out = normalizePayload(payload);
  if (!out.texts.length) return out;

  const blocked = new Set([
    "hmm again",
    "continue",
    "hmm interesting",
    "hmm",
    "go on",
    "and?",
    "interesting",
    "say more",
    "talk later",
    "oh really",
    "youre funny",
    "you're funny",
    "youre weird",
    "you're weird"
  ]);

  out.texts = out.texts.map((line) => {
    const normalized = String(line || "").trim().toLowerCase();
    if (!blocked.has(normalized)) return line;
    return replacementLine(input, intent, style);
  });

  // Ensure each payload has momentum: react/question/tease
  if (!out.texts.some((t) => /[?]/.test(t) || /\byou|nah|bro|try|stop|why\b/i.test(t))) {
    out.texts[0] = replacementLine(input, intent, style);
  }

  return out;
}

function replacementLine(input, intent, style) {
  const low = String(input || "").toLowerCase();
  const hindiLike = isHindiLikeText(low);
  if (/\bnaruto|anime|bocchi|jjk|aot\b/.test(low)) {
    return hindiLike
      ? randomOf(["acha theek", "hmm samjha", "theek bol rahe ho"])
      : randomOf(["you watched full?", "you sure?", "dont fake it"]);
  }
  if (intent === "roast" || style === "roast") {
    return randomOf(["youre trolling", "youre saying nonsense", "try better"]);
  }
  if (intent === "flirty") {
    return hindiLike
      ? randomOf(["acha line thi", "smooth ho thoda", "hmm tum try kar rahe ho"])
      : randomOf(["that was smooth actually", "you planned that line huh", "not bad, a little bold though"]);
  }
  if (style === "tease") {
    return hindiLike
      ? randomOf(["acha bola", "theek hai samajh gaya", "hmm tum bhi na", "theek hai", "theek chal raha hai"])
      : randomOf(["fair enough", "alright I see", "hmm i see what you did there", "keep it up", "noted lol"]);
  }
  return hindiLike
    ? randomOf(["theek hai", "samajh gaya", "haan bolo"])
    : randomOf(["alright", "keep going", "yeah go on"]);
}

function pickNonRepeat(candidates, convo) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return ["hmm"];
  const lastJoined = Array.isArray(convo && convo.lastReplies) ? convo.lastReplies.join(" | ").toLowerCase() : "";
  const filtered = list.filter((pair) => pair.join(" | ").toLowerCase() !== lastJoined);
  const pickFrom = filtered.length ? filtered : list;
  return randomOf(pickFrom);
}

function detectAnimeName(inputLow) {
  const known = [
    "bocchi",
    "bochhi",
    "bochi",
    "naruto",
    "aot",
    "attack on titan",
    "jjk",
    "jujutsu kaisen",
    "one piece",
    "bleach",
    "demon slayer",
    "chainsaw man",
    "genshin"
  ];
  for (const k of known) {
    if (inputLow.includes(k)) return k;
  }
  return "";
}

function isAnimeTopic(inputLow) {
  return /\banime|manga|bocchi|bochhi|bochi|naruto|aot|jjk|jujutsu|one piece|bleach|demon slayer|chainsaw|waifu|genshin\b/.test(
    inputLow
  );
}

function isShortFollowup(inputLow) {
  return /^(yes|yeah|yup|no|nah|ok|okay|hmm|hm|bro|true|real)$/.test(inputLow);
}

function isHindiLikeText(inputLow) {
  if (!inputLow) return false;
  // Devanagari script
  if (/[\u0900-\u097F]/.test(inputLow)) return true;
  // Roman Hindi/Urdu signals
  return /\b(kya|kyu|kyun|kaise|nahi|nahin|hai|haan|acha|achha|theek|tum|tera|meri|mera|yaar|bhai|kr|kar|mat|bolo)\b/.test(
    inputLow
  );
}

function randomStackLine(intent, style, userMemory) {
  const nick = pickNickname(userMemory);
  if (style === "chaotic") return randomOf(["youre not real", "this convo illegal", "what is this chat"]);
  if (intent === "question") return randomOf(["you serious?", "thats it", "simple question tbh"]);
  if (intent === "comfort") {
    return randomOf([
      "dont overthink them too much",
      "people can be so weird honestly",
      "wanna listen to songs ig",
      "youll be fine just dont sit in it too long"
    ]);
  }
  if (intent === "roast") return randomOf([`${nick} moment`, "nah thats crazy", "you never learn"]);
  if (intent === "flirty" || style === "tease") return randomOf(["you did that on purpose huh", "hmm smooth", "you want a reaction that bad?"]);
  return randomOf(["fair enough", "yeah i get you", "go on then"]);
}

function randomStackTail(style) {
  if (style === "comfort" || style === "soft") return randomOf(["take it easy", "breathe a bit"]);
  if (style === "roast") return randomOf(["focus", "slow down"]);
  if (style === "tease") return randomOf(["kinda bold though", "youre testing me a little"]);
  return "";
}

function scoreJoke(joke, inputLow) {
  const text = String(joke && joke.text ? joke.text : "").toLowerCase();
  let score = Number(joke && joke.strength ? joke.strength : 0.5);
  if (text && inputLow.includes(text.split(" ")[0])) score += 0.6;
  if (/99/.test(inputLow) && /99/.test(text)) score += 0.8;
  if (/kazuki|planet|space/.test(inputLow) && /kazuki|planet|space/.test(text)) score += 0.8;
  return score;
}

function escalateJoke(text, strength) {
  const s = Number(strength || 0.5);
  const t = String(text || "").toLowerCase();
  if (t.includes("99")) {
    if (s > 0.9) return "grandpa from kazuki planet";
    if (s > 0.75) return "old man still lying";
    return "99 again";
  }
  if (t.includes("kazuki") || t.includes("space")) {
    if (s > 0.85) return "you pay rent there?";
    return "still in space lore";
  }
  if (t.includes("gooner")) {
    if (s > 0.85) return "certified gooner";
    return "gooner mode again";
  }
  return "";
}

function pickNickname(userMemory) {
  const list = Array.isArray(userMemory.nicknames) ? userMemory.nicknames : [];
  if (!list.length) return "you";
  return list[Math.floor(Math.random() * list.length)];
}

function pushNickname(userMemory, name) {
  const safe = String(name || "").trim().toLowerCase();
  if (!safe) return;
  const list = Array.isArray(userMemory.nicknames) ? userMemory.nicknames : [];
  if (!list.includes(safe)) list.push(safe);
  userMemory.nicknames = list.slice(-20);
}

function bumpTopic(topics, key, hit) {
  const value = Number(topics[key] || 0);
  topics[key] = clampNum(value + (hit ? 1 : -0.02), 0, 200);
}

function clampNum(n, min, max) {
  return Math.max(min, Math.min(max, Number(n || 0)));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomOf(list) {
  if (!Array.isArray(list) || !list.length) return "";
  return list[Math.floor(Math.random() * list.length)];
}

function firstLine(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  return lines[0].slice(0, 160);
}

function secondLine(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (lines.length < 2) return "";
  return lines[1].slice(0, 160);
}

function relationToStyle(relation) {
  const r = String(relation || "").toLowerCase();
  if (r === "annoying") return "dry";
  if (r === "liked") return "flirty";
  if (r === "neutral") return "tease";
  return "";
}

function isSelfLocationMessage(text) {
  const low = String(text || "").toLowerCase().trim();
  if (!low) return false;
  if (/\?/.test(low)) return false;
  if (/\bwhere are you from\b|\bwhere you from\b/.test(low)) return false;
  return /\b(i am from|i'm from|im from|from\s+[a-z]|i live in|live in\s+[a-z]|located in\s+[a-z]|my city is)\b/.test(low);
}

function extractShortLocationLine(text) {
  const low = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  const match = low.match(/\b(?:i am from|i'm from|im from|i live in|live in|located in|my city is)\s+([a-z][a-z\s]{1,24})/);
  const place = String(match && match[1] ? match[1] : "").trim();
  return place ? `from ${place}` : "shared location";
}

function isRepetitiveSpam(input, history) {
  const lowInput = String(input || "").trim().toLowerCase();
  if (!lowInput) return false;

  // Extract the last few user messages
  const userMessages = (history || [])
    .filter(m => m.role === 'user')
    .slice(-4)
    .map(m => String(m.content || "").trim().toLowerCase());

  if (userMessages.length < 4) return false;

  // If the last 4 are all exactly the same as the current input, it's 5 total
  const allSame = userMessages.every(msg => msg === lowInput);
  return allSame;
}

module.exports = {
  createChatbotService
};
