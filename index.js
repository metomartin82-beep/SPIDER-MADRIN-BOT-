/*
 * Alexa — WhatsApp Multi-Session Bot
 */


const fs = require('fs');
const path = require('path');
const pino = require('pino');
const readline = require('readline');
const { Telegraf, Markup } = require('telegraf');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason
} = require('@trashcore/baileys');

const settings = require('./settings');
const { handleMessage, handleDelete, storeMsg, COMMANDS } = require('./case');
const {
  deleteSession, listSessions, getSessionDir,
  loadUserSettings, saveUserSettings, normalizeNumber
} = require('./helper/function');
const { sleep, cleanNumber } = require('./helper/utils');

global.botStartTime = global.botStartTime || Date.now();

// ─── Dirs ──────────────────────────────────────────────────────────────────────
fs.mkdirSync(settings.SESSIONS_DIR, { recursive: true });
fs.mkdirSync('./database', { recursive: true });

// ─── State ─────────────────────────────────────────────────────────────────────
const activeSessions = new Map(); // sessionName → { conn, ownerNumber, telegramChatId }

// ─── Telegram (optional — only runs if TELEGRAM_TOKEN is set) ─────────────────
const bot = settings.TELEGRAM_TOKEN
  ? new Telegraf(settings.TELEGRAM_TOKEN)
  : {
      command: () => {},
      telegram: { sendMessage: async () => {} },
      launch: () => {},
      stop: () => {}
    };

// ─── Console pairing interface (for Pterodactyl / bare terminal deploys) ──────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(query) {
  return new Promise(resolve => rl.question(query, answer => resolve(answer)));
}

// ─── Auto-join groups ───────────────────────────────────────────────────────────
async function runAutoJoins(conn, sessionName) {
  const us = loadUserSettings(sessionName);

  // Auto-join groups (max 2)
  const groups = us.autoJoinGroups || [];
  for (const link of groups.slice(0, 2)) {
    try {
      const code = link.split('https://chat.whatsapp.com/')[1];
      if (code) {
        await conn.groupAcceptInvite(code);
        process.stdout.write(`[AUTO-JOIN] ${sessionName} → ${link}\n`);
      }
    } catch {}
    await sleep(1000);
  }
}

// ─── WA session starter ────────────────────────────────────────────────────────
async function startWASession(sessionName, telegramChatId, ownerNumber) {
  const sessionDir = getSessionDir(sessionName);
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const conn = makeWASocket({
    version,
    keepAliveIntervalMs: 10000,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    browser: ['Ubuntu', 'Opera', '100.0.4815.0'],
    syncFullHistory: false,
    // Enable group participant metadata for correct admin detection
    getMessage: async (key) => {
      return { conversation: '' };
    }
  });

  conn.ev.on('creds.update', saveCreds);

  // Pairing code
  let pairCode = null;
  if (!state.creds.registered) {
    await sleep(3000);
    try {
      pairCode = await conn.requestPairingCode(ownerNumber);
      if (telegramChatId) {
        await bot.telegram.sendMessage(
          telegramChatId,
          `🔗 *Pairing Code for session* \`${sessionName}\`:\n\n` +
          `\`${pairCode}\`\n\n` +
          `Enter this code on WhatsApp → Linked Devices → Link a device.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
      console.log('\n╔══════════════════════════════════════╗');
      console.log(`  WhatsApp Pairing Code (${sessionName})`);
      console.log(`  Number : ${ownerNumber}`);
      console.log(`  Code   : ${pairCode}`);
      console.log('╚══════════════════════════════════════╝');
      console.log('Open WhatsApp → Linked Devices → Link with phone number → enter the code above.\n');
      process.stdout.write(`[PAIR] ${sessionName} → ${pairCode}\n`);
    } catch (err) {
      process.stdout.write(`[PAIR ERROR] ${sessionName}: ${err.message}\n`);
    }
  }

  // Connection events
  conn.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const session = activeSessions.get(sessionName);
      const storedChatId = session?.telegramChatId || telegramChatId;
      activeSessions.delete(sessionName);

      if (code !== DisconnectReason.loggedOut) {
        process.stdout.write(`[RECONNECT] ${sessionName}\n`);
        await sleep(3000);
        startWASession(sessionName, null, ownerNumber);
      } else {
        process.stdout.write(`[LOGGED OUT] ${sessionName}\n`);
        if (storedChatId) {
          await bot.telegram.sendMessage(
            storedChatId,
            `⚠️ Session *${sessionName}* was logged out.\nUse /pair to reconnect.`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        }
      }
    }

    if (connection === 'open') {
      const botNum = normalizeNumber(conn.user.id);
      process.stdout.write(`[CONNECTED] ${sessionName} → ${botNum}\n`);

      activeSessions.set(sessionName, {
        conn,
        ownerNumber: ownerNumber || botNum,
        telegramChatId: telegramChatId || null
      });

      // Persist telegramChatId + ownerNumber
      const us = loadUserSettings(sessionName);
      if (telegramChatId) us.telegramChatId = telegramChatId;
      us.ownerNumber = ownerNumber || botNum;
      saveUserSettings(sessionName, us);

      // Connection success message to Telegram
      const chatTarget = telegramChatId || us.telegramChatId;
      if (chatTarget) {
        const userInfo = conn.user?.name || botNum;
        await bot.telegram.sendMessage(
          chatTarget,
          `✅ *NUMBER CONNECTED*\n\n` +
          `👤 *user :* ${userInfo}\n` +
          `📡 *session :* \`${sessionName}\`\n` +
          `👑 *owner :* ${settings.OWNER_HANDLE}`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }

      // Run auto-joins after connect
      await runAutoJoins(conn, sessionName);
    }
  });

  // Messages handler
  conn.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const m = messages?.[0];
    if (!m?.message) return;
    const session = activeSessions.get(sessionName);
    if (!session) return;
    await handleMessage(conn, m, sessionName, session.ownerNumber);
  });

  // Antidelete — listen for message deletes
  conn.ev.on('messages.delete', async (update) => {
    await handleDelete(conn, update, sessionName);
  });

  return { conn, pairCode };
}

// ─── Reload all existing sessions ─────────────────────────────────────────────
async function reloadExistingSessions() {
  const sessions = listSessions();
  process.stdout.write(`[STARTUP] Reloading ${sessions.length} session(s)...\n`);
  for (const sessionName of sessions) {
    const us = loadUserSettings(sessionName);
    const ownerNumber = us.ownerNumber || '';
    process.stdout.write(`[RELOAD] ${sessionName}\n`);
    await startWASession(sessionName, null, ownerNumber);
    await sleep(2500);
  }
}

// ─── Pair a number from the console (Pterodactyl-friendly) ───────────────────
async function pairFromConsole(sessionName, rawNumber) {
  const ownerNumber = cleanNumber(rawNumber || '');
  if (!ownerNumber || ownerNumber.length < 7) {
    console.log('❌ Invalid number. Include the country code, e.g. 2547XXXXXXXX');
    return false;
  }

  const sessionDir = getSessionDir(sessionName);
  fs.mkdirSync(sessionDir, { recursive: true });
  const us = loadUserSettings(sessionName);
  us.ownerNumber = ownerNumber;
  saveUserSettings(sessionName, us);

  console.log(`\n⏳ Requesting pairing code for ${ownerNumber}...`);
  await startWASession(sessionName, null, ownerNumber);
  return true;
}

// ─── First-run console prompt: ask for a number if no sessions exist ─────────
async function runConsoleOnboarding() {
  if (listSessions().length > 0) return;

  console.log('\n=============================================');
  console.log(`   ${settings.BOT_NAME} — WhatsApp Setup`);
  console.log('=============================================');

  let paired = false;
  while (!paired) {
    const raw = await ask('\n📱 Enter WhatsApp number to connect (with country code, no +): ');
    paired = await pairFromConsole('main', raw);
  }
}

// ─── Persistent console command listener ─────────────────────────────────────
function startConsoleListener() {
  console.log('\n💻 Console ready. Type "pair <number>" to link another WhatsApp number, or "sessions" to list them.\n');

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const [cmd, ...rest] = trimmed.split(' ');

    if (cmd.toLowerCase() === 'pair') {
      const sessionName = `session_console_${Date.now()}`;
      await pairFromConsole(sessionName, rest.join(''));
    } else if (cmd.toLowerCase() === 'sessions') {
      const sessions = listSessions();
      if (!sessions.length) return console.log('📂 No sessions found.');
      for (const s of sessions) {
        const us = loadUserSettings(s);
        console.log(`• ${s} ${activeSessions.has(s) ? '🟢 online' : '🔴 offline'} — ${us.ownerNumber || '?'}`);
      }
    } else if (cmd.toLowerCase() === 'help') {
      console.log('Commands: pair <number> | sessions | help');
    }
  });
}

// ─── Web pairing server (no Telegram account needed) ──────────────────────────
// Serves a small pairing page + a couple of JSON endpoints so a WhatsApp
// number can be linked entirely from a browser. Gated behind WEB_PAIR_CODE —
// without it set, pairing/deleting sessions over the web is disabled outright
// rather than left open to anyone who finds the URL.
const express = require('express');
const rateLimit = require('express-rate-limit');

const webApp = express();
webApp.use(express.json());
webApp.use(express.static(path.join(__dirname, 'public')));

const webLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many attempts, slow down.' } });
webApp.use('/api', webLimiter);

function checkWebAuth(req, res, next) {
  if (!settings.WEB_PAIR_CODE) {
    return res.status(503).json({ error: 'Web pairing is disabled — set WEB_PAIR_CODE in .env to enable it.' });
  }
  const code = req.headers['x-pair-code'] || req.body?.accessCode;
  if (code !== settings.WEB_PAIR_CODE) {
    return res.status(401).json({ error: 'Invalid access code.' });
  }
  next();
}

// POST /api/pair — { accessCode, number } → { sessionName, pairCode }
webApp.post('/api/pair', checkWebAuth, async (req, res) => {
  const ownerNumber = cleanNumber(req.body?.number || '');
  if (!ownerNumber || ownerNumber.length < 7) {
    return res.status(400).json({ error: 'Enter a valid number with country code, e.g. 2547XXXXXXXX (no +).' });
  }

  const sessionName = `session_web_${Date.now()}`;
  const sessionDir = getSessionDir(sessionName);
  fs.mkdirSync(sessionDir, { recursive: true });
  const us = loadUserSettings(sessionName);
  us.ownerNumber = ownerNumber;
  saveUserSettings(sessionName, us);

  try {
    const { pairCode } = await startWASession(sessionName, null, ownerNumber);
    if (!pairCode) {
      return res.status(500).json({ error: 'WhatsApp did not return a pairing code. Try again.' });
    }
    res.json({ sessionName, pairCode, number: ownerNumber });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Pairing failed.' });
  }
});

// GET /api/sessions — list sessions with live status
webApp.get('/api/sessions', checkWebAuth, (req, res) => {
  const sessions = listSessions().map(name => {
    const us = loadUserSettings(name);
    return { name, online: activeSessions.has(name), number: us.ownerNumber || '?' };
  });
  res.json({ sessions });
});

// DELETE /api/sessions/:name — unlink a number
webApp.delete('/api/sessions/:name', checkWebAuth, (req, res) => {
  const sessionName = req.params.name;
  if (activeSessions.has(sessionName)) {
    try { activeSessions.get(sessionName).conn.end(); } catch {}
    activeSessions.delete(sessionName);
  }
  const deleted = deleteSession(sessionName);
  if (!deleted) return res.status(404).json({ error: 'Session not found.' });
  res.json({ message: 'Session deleted.' });
});

function startWebServer() {
  webApp.listen(settings.WEB_PORT, () => {
    process.stdout.write(`[WEB] Pairing page on http://localhost:${settings.WEB_PORT}\n`);
    if (!settings.WEB_PAIR_CODE) {
      process.stdout.write('[WEB] ⚠ WEB_PAIR_CODE is not set — pairing/deleting over the web is disabled until you set one.\n');
    }
  });
}

// ─── Telegram: /start ─────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  const firstName = ctx.from.first_name || 'there';
  const caption =
    `👋 *Hello, ${firstName}!*\n\n` +
    `Welcome to *${settings.BOT_NAME}*\n\n` +
    `📌 *Commands:*\n` +
    `/pair <number> - Connect a WhatsApp number\n` +
    `/delsession - Delete a session\n` +
    `/listsession - List all sessions (owner)\n` +
    `/reportissue <text> - Report a problem\n\n` +
    `_Use /pair to get started!_`;

  const buttons = Markup.inlineKeyboard([
    [
      Markup.button.url('📢 Join Channel', settings.CHANNEL_LINK),
      Markup.button.url('👥 Join Group', settings.GROUP_LINK)
    ]
  ]);

  try {
    await ctx.replyWithPhoto(
      { url: settings.MENU_IMAGE },
      { caption, parse_mode: 'Markdown', ...buttons }
    );
  } catch {
    await ctx.reply(caption, { parse_mode: 'Markdown', ...buttons });
  }
});

// ─── Telegram: /pair — unlimited sessions ─────────────────────────────────────
bot.command('pair', async (ctx) => {
  const chatId = ctx.chat.id;
  const parts = ctx.message.text.split(' ');

  if (parts.length < 2) {
    return ctx.reply('📱 Usage: `/pair <number>`\nExample: `/pair 2547XXXXXXXX`', { parse_mode: 'Markdown' });
  }

  const ownerNumber = cleanNumber(parts[1]);
  if (ownerNumber.length < 7) {
    return ctx.reply('❌ Invalid number. Include country code.', { parse_mode: 'Markdown' });
  }

  // Unique session name per pairing — allows unlimited
  const sessionName = `session_${chatId}_${Date.now()}`;

  await ctx.reply(
    `⏳ Generating pairing code for \`${ownerNumber}\`...\nSession: \`${sessionName}\``,
    { parse_mode: 'Markdown' }
  );

  // Pre-save session settings
  const sessionDir = getSessionDir(sessionName);
  fs.mkdirSync(sessionDir, { recursive: true });
  const us = loadUserSettings(sessionName);
  us.ownerNumber = ownerNumber;
  us.telegramChatId = chatId;
  saveUserSettings(sessionName, us);

  await startWASession(sessionName, chatId, ownerNumber);
});

// ─── Telegram: /delsession ────────────────────────────────────────────────────
bot.command('delsession', async (ctx) => {
  const chatId = ctx.chat.id;
  const parts = ctx.message.text.split(' ');

  if (parts.length < 2) {
    const allSessions = listSessions();
    const mySessions = allSessions.filter(s => {
      try { return String(loadUserSettings(s).telegramChatId) === String(chatId); } catch { return false; }
    });

    if (!mySessions.length) return ctx.reply('⚠️ You have no sessions.');
    const list = mySessions.map(s => {
      const isActive = activeSessions.has(s);
      return `• \`${s}\` ${isActive ? '🟢' : '🔴'}`;
    }).join('\n');
    return ctx.reply(
      `📋 Your sessions:\n${list}\n\nUse: \`/delsession <session_name>\``,
      { parse_mode: 'Markdown' }
    );
  }

  const sessionName = parts[1].trim();

  try {
    const us = loadUserSettings(sessionName);
    if (String(us.telegramChatId) !== String(chatId) && chatId !== settings.OWNER_ID) {
      return ctx.reply('❌ That session does not belong to you.');
    }
  } catch {
    return ctx.reply('❌ Session not found.');
  }

  if (activeSessions.has(sessionName)) {
    try { activeSessions.get(sessionName).conn.end(); } catch {}
    activeSessions.delete(sessionName);
  }

  const deleted = deleteSession(sessionName);
  await ctx.reply(
    deleted
      ? `✅ Session \`${sessionName}\` deleted. Use /pair to connect a new number.`
      : '⚠️ Session not found.',
    { parse_mode: 'Markdown' }
  );
});

// ─── Telegram: /listsession (owner only) ──────────────────────────────────────
bot.command('listsession', async (ctx) => {
  if (ctx.chat.id !== settings.OWNER_ID) return ctx.reply('❌ Owner only.');
  const sessions = listSessions();
  if (!sessions.length) return ctx.reply('📂 No sessions found.');

  let msg = `📋 *Sessions (${sessions.length}):*\n\n`;
  for (const name of sessions) {
    const isActive = activeSessions.has(name);
    const us = loadUserSettings(name);
    const num = activeSessions.get(name)?.ownerNumber || us.ownerNumber || '?';
    msg += `• \`${name}\` ${isActive ? '🟢' : '🔴'} — ${num}\n`;
  }
  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ─── Telegram: /reportissue ───────────────────────────────────────────────────
bot.command('reportissue', async (ctx) => {
  const text = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!text) return ctx.reply('📝 Usage: `/reportissue <your problem>`', { parse_mode: 'Markdown' });

  const from = ctx.from;
  const report =
    `🚨 *Issue Report*\n\n` +
    `👤 ${from.first_name || ''} ${from.last_name || ''}\n` +
    `🆔 \`${from.id}\`\n` +
    `📛 ${from.username ? '@' + from.username : 'N/A'}\n\n` +
    `📋 *Issue:*\n${text}`;

  try {
    await bot.telegram.sendMessage(settings.REPORT_CHAT, report, { parse_mode: 'Markdown' });
    await ctx.reply('✅ Report sent to owner. Thank you!');
  } catch {
    await ctx.reply('❌ Failed to send report. Try again later.');
  }
});

// ─── Launch ────────────────────────────────────────────────────────────────────
(async () => {
  process.stdout.write(`[BOOT] ${settings.BOT_NAME} starting...\n`);
  await reloadExistingSessions();

  // Start the web pairing server FIRST and don't await it — it must be usable
  // immediately, even while the console prompt below is sitting there waiting
  // for input nobody may ever type (e.g. on a host with no interactive console).
  startWebServer();

  // Console-based pairing (Pterodactyl / bare terminal deploys) — optional now
  // that web pairing exists, but left in for anyone who does have console access.
  await runConsoleOnboarding();
  startConsoleListener();

  if (settings.TELEGRAM_TOKEN) {
    bot.launch({ dropPendingUpdates: true });
    process.stdout.write(`[TELEGRAM] Bot online.\n`);
  } else {
    process.stdout.write(`[TELEGRAM] Skipped — no TELEGRAM_TOKEN set. Use the console or the web pairing page instead.\n`);
  }

  process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
})();
