import {
  cacheAudioOnGoogleDrive,
  getCachedTelegramMessage,
} from "./audio-cache.ts";
import { ensureMp3Cached, prepareMp3Audio } from "./streaming.ts";
import { issueApiKey, revokeApiKey } from "./api-keys.ts";

type BotConfig = {
  token: string;
  channelId: string;
  adminChatId?: string;
};

function channelId(): string | undefined {
  return (
    Deno.env.get("TELEGRAM_CACHE_CHANNEL_ID") ||
    Deno.env.get("TELEGRAM_CHANNEL_ID")
  )?.trim() || undefined;
}

function config(): BotConfig | null {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim();
  const storageChannelId = channelId();
  if (!token || !storageChannelId) return null;
  return {
    token,
    channelId: storageChannelId,
    adminChatId: Deno.env.get("TELEGRAM_ADMIN_CHAT_ID")?.trim() || undefined,
  };
}

function outputConfig(): BotConfig | null {
  const token = Deno.env.get("TELEGRAM_OUTPUT_BOT_TOKEN")?.trim();
  const storageChannelId = channelId();
  if (!token || !storageChannelId) return null;
  return {
    token,
    channelId: storageChannelId,
    adminChatId: Deno.env.get("TELEGRAM_ADMIN_CHAT_ID")?.trim() || undefined,
  };
}

async function telegramApi(
  token: string,
  method: string,
  body: unknown,
  timeoutMs = 35_000,
  signal?: AbortSignal,
): Promise<any | null> {
  try {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.ok ? data.result : null;
  } catch {
    return null;
  }
}

function parseVideoId(input: string): string | null {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const id = url.hostname === "youtu.be"
      ? url.pathname.slice(1).split("/")[0]
      : url.searchParams.get("v") ||
        url.pathname.match(/\/(?:shorts|embed|live)\/([^/?]+)/)?.[1];
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

type InlineKeyboard = { inline_keyboard: Array<Array<{
  text: string;
  callback_data: string;
}>> };

async function sendMessage(
  token: string,
  chatId: string | number,
  text: string,
  options: { parseMode?: "HTML"; replyMarkup?: InlineKeyboard } = {},
): Promise<void> {
  await telegramApi(token, "sendMessage", {
    chat_id: chatId,
    text,
    ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
    ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
  });
}

async function copyCachedMessage(
  token: string,
  chatId: string,
  channelId: string,
  messageId: number,
): Promise<boolean> {
  const startedAt = Date.now();
  const copied = await telegramApi(token, "copyMessage", {
    chat_id: chatId,
    from_chat_id: channelId,
    message_id: messageId,
  });
  console.log(JSON.stringify({
    event: "telegram_output",
    state: copied ? "sent" : "failed",
    chatId,
    messageId,
    durationMs: Date.now() - startedAt,
  }));
  return Boolean(copied);
}

function isAdmin(
  chatId: string,
  senderId: string,
  adminChatId?: string,
): boolean {
  return Boolean(adminChatId && (chatId === adminChatId || senderId === adminChatId));
}

async function handleAdminCommand(
  token: string,
  chatId: string,
  senderId: string,
  command: string,
  adminChatId?: string,
): Promise<boolean> {
  if (command !== "/ping" && command !== "/status" && command !== "/restart") {
    return false;
  }
  if (!isAdmin(chatId, senderId, adminChatId)) return true;

  if (command === "/ping") {
    await sendMessage(token, chatId, "pong — input/output bots online");
    return true;
  }

  if (command === "/status") {
    await sendMessage(
      token,
      chatId,
      `Zefron bot status: online\nInput bot: ${config() ? "enabled" : "disabled"}\nOutput bot: ${outputConfig() ? "enabled" : "disabled"}\nCache channel: configured`,
    );
    return true;
  }

  await sendMessage(token, chatId, "Restarting input/output bot polling...");
  restartTelegramBots();
  return true;
}

async function processUpdate(
  token: string,
  update: any,
  channelId: string,
  adminChatId?: string,
): Promise<void> {
  const message = update.message || update.channel_post;
  const text = String(message?.text || "").trim();
  if (!message || !text) return;

  const chatId = String(message.chat?.id || "");
  const senderId = String(message.from?.id || "");
  const [rawCommand, input] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split("@")[0];
  if (await handleAdminCommand(token, chatId, senderId, command, adminChatId)) return;
  if (command !== "/reload") return;

  // A configured admin may use the bot from a private chat. Without one,
  // accept only commands posted in the cache channel itself.
  if (adminChatId ? senderId !== adminChatId && chatId !== adminChatId : chatId !== channelId) {
    return;
  }

  const videoId = input ? parseVideoId(input) : null;
  if (!videoId) {
    await sendMessage(token, chatId, "Usage: /reload <YouTube video ID or URL>");
    return;
  }

  await sendMessage(token, chatId, `Reloading ${videoId}...`);
  const audio = await prepareMp3Audio(videoId, 45_000);
  if (!audio.success) {
    await sendMessage(token, chatId, `Reload failed: ${audio.error}`);
    return;
  }
  const cached = await cacheAudioOnGoogleDrive(videoId, audio, true, "mp3");
  await sendMessage(token, chatId, cached ? `Reloaded and cached ${videoId}.` : "Reload prepared, but cache upload failed.");
}

const outputDeliveryJobs = new Map<string, Promise<void>>();

async function deliverOutputSong(
  token: string,
  chatId: string,
  channelId: string,
  videoId: string,
): Promise<void> {
  let cached = await getCachedTelegramMessage(videoId, "mp3");
  if (!cached?.telegramMessageId) {
    await ensureMp3Cached(videoId, 45_000);
    cached = await getCachedTelegramMessage(videoId, "mp3");
  }

  if (!cached?.telegramMessageId) {
    await sendMessage(token, chatId, "Song cache nahi ho payi. Thodi der baad dobara try karein.");
    return;
  }

  const sent = await copyCachedMessage(
    token,
    chatId,
    channelId,
    cached.telegramMessageId,
  );
  if (!sent) {
    await sendMessage(
      token,
      chatId,
      "Song deliver nahi ho paya. Output bot ko storage channel ka access check karein.",
    );
  }
}

function queueOutputDelivery(
  token: string,
  chatId: string,
  channelId: string,
  videoId: string,
): boolean {
  const key = `${chatId}:${videoId}`;
  if (outputDeliveryJobs.has(key)) return false;
  const job = deliverOutputSong(token, chatId, channelId, videoId)
    .catch((err) => {
      console.warn("Telegram output delivery failed:", String(err).slice(0, 160));
    })
    .finally(() => {
      outputDeliveryJobs.delete(key);
    });
  outputDeliveryJobs.set(key, job);
  return true;
}

async function processOutputUpdate(
  token: string,
  update: any,
  channelId: string,
  adminChatId?: string,
): Promise<void> {
  if (update.callback_query) {
    await processOutputCallback(token, update.callback_query);
    return;
  }

  const message = update.message;
  const text = String(message?.text || "").trim();
  if (!message || !text) return;

  const [rawCommand, input] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split("@")[0];
  const chatId = String(message.chat?.id || "");
  if (!chatId) return;
  const senderId = String(message.from?.id || "");
  if (await handleAdminCommand(token, chatId, senderId, command, adminChatId)) return;

  if (command === "/start" || command === "/help") {
    await sendMessage(
      token,
      chatId,
      "Welcome to Zefron API.\n\nSong ke liye /song <YouTube ID ya URL> bhejein. API key aur docs ke liye neeche options chunein. Nayi key banane se purani keys active rahengi.",
      {
        replyMarkup: {
          inline_keyboard: [
            [{ text: "🔑 View / Generate API Key", callback_data: "api_key" }],
            [{ text: "📚 API Docs", callback_data: "api_docs" }],
          ],
        },
      },
    );
    return;
  }
  if (command === "/apikey") {
    if (message.chat?.type !== "private" || !senderId) {
      await sendMessage(token, chatId, "API key private chat mein /apikey bhejkar generate karein.");
      return;
    }
    try {
      const apiKey = await issueApiKey(senderId);
      if (!apiKey) {
        await sendMessage(token, chatId, "API key abhi generate nahi ho payi. MongoDB connection check karein.");
        return;
      }
      await sendMessage(
        token,
        chatId,
        apiKeyCard(apiKey),
        { parseMode: "HTML", replyMarkup: apiKeyKeyboard() },
      );
    } catch {
      await sendMessage(token, chatId, "API key generate nahi ho payi. Thodi der baad try karein.");
    }
    return;
  }
  if (command === "/revokeapikey") {
    if (message.chat?.type !== "private" || !senderId) {
      await sendMessage(token, chatId, "API key private chat mein /revokeapikey bhejkar revoke karein.");
      return;
    }
    try {
      const revoked = await revokeApiKey(senderId);
      await sendMessage(
        token,
        chatId,
        revoked
          ? "Aapki sabhi active API keys revoke ho gayi hain."
          : "Aapki koi active API key nahi mili.",
      );
    } catch {
      await sendMessage(token, chatId, "API key revoke nahi ho payi. Thodi der baad try karein.");
    }
    return;
  }
  if (command !== "/song" && command !== "/download") return;

  const videoId = input ? parseVideoId(input) : null;
  if (!videoId) {
    await sendMessage(token, chatId, "Usage: /song <YouTube video ID ya URL>");
    return;
  }

  const cached = await getCachedTelegramMessage(videoId, "mp3");
  if (cached?.telegramMessageId) {
    await copyCachedMessage(token, chatId, channelId, cached.telegramMessageId);
    return;
  }

  const queued = queueOutputDelivery(token, chatId, channelId, videoId);
  if (queued) {
    await sendMessage(token, chatId, "Song prepare ho raha hai. Ready hote hi yahin bhej dunga.");
  }
}

function apiKeyKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "🔄 Generate another key", callback_data: "api_key" }],
      [{ text: "📚 API Docs", callback_data: "api_docs" }],
      [{ text: "⬅️ Back to menu", callback_data: "api_menu" }],
    ],
  };
}

function outputMenuKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "🔑 View / Generate API Key", callback_data: "api_key" }],
      [{ text: "📚 API Docs", callback_data: "api_docs" }],
    ],
  };
}

function apiKeyCard(apiKey: string): string {
  const createdAt = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date());
  return (
    "<b>Zefron API Key</b>\n\n" +
    `<code>${apiKey}</code>\n\n` +
    "<b>Status:</b> 🟢 Active\n" +
    `<b>Created:</b> ${createdAt} UTC\n\n` +
    "<b>Usage</b>\n" +
    `<code>GET /download?url=VIDEO_ID&amp;type=audio&amp;api_key=${apiKey}</code>\n\n` +
    "Keep this key private. Generating another key will not disable this one."
  );
}

function apiDocsCard(): string {
  return (
    "<b>Zefron API Docs</b>\n\n" +
    "<b>Personal-key download</b>\n" +
    "<code>GET /download?url=VIDEO_ID&amp;type=audio&amp;api_key=YOUR_KEY</code>\n\n" +
    "<b>Parameters</b>\n" +
    "<code>url</code> — YouTube video ID or URL\n" +
    "<code>type</code> — audio\n" +
    "<code>api_key</code> — your personal Zefron key\n\n" +
    "<b>Other endpoints</b>\n" +
    "<code>GET /api/search?q=...</code>\n" +
    "<code>GET /api/yt_search?q=...</code>\n" +
    "<code>GET /api/lyrics?title=...&amp;artist=...</code>\n\n" +
    "Use the API site's Docs tab for the full endpoint list."
  );
}

async function processOutputCallback(token: string, query: any): Promise<void> {
  const callbackId = String(query.id || "");
  const data = String(query.data || "");
  const message = query.message;
  const chatId = String(message?.chat?.id || "");
  const senderId = String(query.from?.id || "");
  const messageId = Number(message?.message_id);
  if (!callbackId) return;

  const answer = async (text?: string) => {
    await telegramApi(token, "answerCallbackQuery", {
      callback_query_id: callbackId,
      ...(text ? { text, show_alert: true } : {}),
    });
  };

  if (!chatId || !messageId) {
    await answer();
    return;
  }

  let text: string;
  let replyMarkup: InlineKeyboard;
  let parseMode: "HTML" | undefined;

  if (data === "api_key") {
    if (message.chat?.type !== "private" || !senderId) {
      await answer("Open a private chat with the bot to view or generate a key.");
      return;
    }
    try {
      const apiKey = await issueApiKey(senderId);
      if (!apiKey) {
        text = "API key abhi generate nahi ho payi. MongoDB connection check karein.";
        replyMarkup = outputMenuKeyboard();
      } else {
        text = apiKeyCard(apiKey);
        replyMarkup = apiKeyKeyboard();
        parseMode = "HTML";
      }
    } catch {
      text = "API key generate nahi ho payi. Thodi der baad try karein.";
      replyMarkup = outputMenuKeyboard();
    }
  } else if (data === "api_docs") {
    text = apiDocsCard();
    replyMarkup = {
      inline_keyboard: [[{ text: "⬅️ Back to menu", callback_data: "api_menu" }]],
    };
    parseMode = "HTML";
  } else if (data === "api_menu") {
    text = "Welcome to Zefron API.\n\nSong ke liye /song <YouTube ID ya URL> bhejein.";
    replyMarkup = outputMenuKeyboard();
  } else {
    await answer();
    return;
  }

  await telegramApi(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(parseMode ? { parse_mode: parseMode } : {}),
    reply_markup: replyMarkup,
  });
  await answer();
}

const botControllers = new Map<"input" | "output", AbortController>();
const botOffsets = new Map<"input" | "output", number>();

async function poll(
  current: BotConfig,
  role: "input" | "output",
  controller: AbortController,
): Promise<void> {
  let offset = botOffsets.get(role) ?? 0;
  console.log(`Telegram ${role} bot enabled`);

  while (!controller.signal.aborted) {
    const updates = await telegramApi(current.token, "getUpdates", {
      offset,
      timeout: 25,
      allowed_updates: ["message", "channel_post", "callback_query"],
    }, 35_000, controller.signal);
    if (controller.signal.aborted) return;
    if (Array.isArray(updates)) {
      for (const update of updates) {
        offset = Math.max(offset, Number(update.update_id || 0) + 1);
        botOffsets.set(role, offset);
        if (controller.signal.aborted) return;
        if (role === "input") {
          await processUpdate(current.token, update, current.channelId, current.adminChatId);
        } else {
          await processOutputUpdate(
            current.token,
            update,
            current.channelId,
            current.adminChatId,
          );
        }
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

function startConfiguredTelegramBots(): void {
  for (const controller of botControllers.values()) controller.abort();
  botControllers.clear();

  const input = config();
  if (input) {
    const controller = new AbortController();
    botControllers.set("input", controller);
    void poll(input, "input", controller).catch((err) =>
      console.warn("Telegram input bot stopped:", String(err).slice(0, 160))
    );
  }

  const output = outputConfig();
  if (output) {
    const controller = new AbortController();
    botControllers.set("output", controller);
    void poll(output, "output", controller).catch((err) =>
      console.warn("Telegram output bot stopped:", String(err).slice(0, 160))
    );
  }
}

export function restartTelegramBots(): void {
  startConfiguredTelegramBots();
}

export function startTelegramBot(): void {
  startConfiguredTelegramBots();
}