/*
 * Alexa — WhatsApp Multi-Session Bot
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { downloadContentFromMessage } = require('@trashcore/baileys');
const yts = require('yt-search');
const settings = require('./settings');
const {
  isPremium, addPremium, delPremium,
  loadUserSettings, saveUserSettings,
  getSessionSetting, setSessionSetting,
  isGroupAdmin, normalizeNumber, cleanJidNumber,
} = require('./helper/function');
const { fromJid, formatUptime, measureSpeed } = require('./helper/utils'); 
const { applyFont, FONT_COUNT } = require('./helper/fonts');
const { siteRequest } = require('./helper/site');

global.botStartTime = global.botStartTime || Date.now();

// ─── Antidelete store ─────────────────────────────────────────────────────────
const antideleteStore = new Map();

function storeMsg(sessionName, m) {
  if (!antideleteStore.has(sessionName)) antideleteStore.set(sessionName, new Map());
  const store = antideleteStore.get(sessionName);
  if (m.message && Object.keys(m.message).length > 0) store.set(m.key.id, m);
  if (store.size > 500) store.delete(store.keys().next().value);
}

function getStoredMsg(sessionName, msgId) {
  const store = antideleteStore.get(sessionName);
  return store ? store.get(msgId) : null;
}

// ─── Download media using downloadContentFromMessage ─────────────────────────
async function downloadMedia(msg, type) {
  // type = 'image' | 'video' | 'audio' | 'sticker' | 'document'
  const stream = await downloadContentFromMessage(msg, type);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Detect media type from message object
function getMediaType(msgObj) {
  if (msgObj.imageMessage) return { type: 'image', inner: msgObj.imageMessage };
  if (msgObj.videoMessage) return { type: 'video', inner: msgObj.videoMessage };
  if (msgObj.audioMessage) return { type: 'audio', inner: msgObj.audioMessage };
  if (msgObj.stickerMessage) return { type: 'sticker', inner: msgObj.stickerMessage };
  if (msgObj.documentMessage) return { type: 'document', inner: msgObj.documentMessage };
  return null;
}

// ─── Extract a usable direct download URL from varying API response shapes ────
function extractDownloadUrl(json) {
  if (!json || typeof json !== 'object') return null;
  const candidates = [
    json?.result?.download,
    json?.result?.downloadUrl,
    json?.result?.download_url,
    json?.result?.url,
    json?.result?.dl,
    json?.result?.audio,
    json?.result?.data?.url,
    json?.data?.download,
    json?.data?.url,
    json?.data?.dl,
    json?.url,
    json?.download,
    json?.downloadUrl,
    json?.dl,
    json?.link,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.startsWith('http')) return c;
  }
  return null;
}

// ─── Fetch mp3 download link from fallback APIs ───────────────────────────────
async function fetchYtMp3(ytUrl) {
  const apis = [
    `https://yt-dl.officialhectormanuel.workers.dev/?url=${encodeURIComponent(ytUrl)}`,
    `https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(ytUrl)}`,
    `https://api.ryzendesu.vip/api/downloader/ytmp3?url=${encodeURIComponent(ytUrl)}`,
  ];
  for (const api of apis) {
    try {
      const res = await fetch(api);
      if (!res.ok) continue;
      const json = await res.json();
      const dlUrl = extractDownloadUrl(json);
      if (dlUrl) return dlUrl;
    } catch {}
  }
  return null;
}

// ─── Command registry ──────────────────────────────────────────────────────────
const COMMANDS = {};
function registerCmd(name, handler) { COMMANDS[name] = handler; }

// ─── Font-aware send (raw, no font applied to non-text parts) ─────────────────
async function fReply(conn, m, text, sessionName) {
  const fontNum = getSessionSetting(sessionName, 'font', 1);
  const out = (fontNum && fontNum > 1) ? applyFont(text, fontNum) : text;
  await conn.sendMessage(m.key.remoteJid, { text: out }, { quoted: m });
}

// Plain send without font (for system/error messages that shouldn't be fonted)
async function plainReply(conn, m, text) {
  await conn.sendMessage(m.key.remoteJid, { text }, { quoted: m });
}

// ─── Extract quoted context ───────────────────────────────────────────────────
function getQuotedCtx(m) {
  return m.message?.extendedTextMessage?.contextInfo || null;
}
function getQuotedMsg(m) {
  return m.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;
}

// ─── Extract message text ─────────────────────────────────────────────────────
function getMsgText(m) {
  return (
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption ||
    m.message?.documentMessage?.caption || ''
  );
}

// ─── Get mentioned jids ───────────────────────────────────────────────────────
function getMentioned(m) {
  return m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

// ─── Get target from reply or mention or arg ──────────────────────────────────
// Returns a full JID string or null
function resolveTarget(m, args) {
  // 1. Reply to message — use quoted participant
  const ctx = getQuotedCtx(m);
  if (ctx?.participant) return ctx.participant;
  if (ctx?.remoteJid && !ctx.remoteJid.endsWith('@g.us')) return ctx.remoteJid;

  // 2. Mention
  const mentioned = getMentioned(m);
  if (mentioned.length) return mentioned[0];

  // 3. Plain number arg
  if (args[0]) {
    const num = args[0].replace(/[^0-9]/g, '');
    if (num) return `${num}@s.whatsapp.net`;
  }

  return null;
}

// ─── .menu ────────────────────────────────────────────────────────────────────
const MENU_CATEGORIES = [
  { title: '⚙️ SETTINGS', cmds: ['setprefix', 'setowner', 'setbotname', 'setmenuimg', 'setfonts', 'fonts', 'addprem', 'delprem', 'public', 'self'] },
  { title: '🤖 AUTO FEATURES', cmds: ['autoviewstatus', 'autolikestatus', 'autosavestatus', 'autotyping', 'autorecording', 'autogroupreact'] },
  { title: '🛡️ PROTECTION', cmds: ['antilink', 'antidelete', 'ban', 'unban'] },
  { title: '👑 GROUP ADMIN', cmds: ['promote', 'demote', 'kick', 'group', 'add', 'tagall', 'groupinfo', 'mute', 'unmute', 'addautojoin', 'listautojoin'] },
  { title: '🎨 MEDIA & TOOLS', cmds: ['sticker', 'toimg', 'play', 'vv', 'copy'] },
  { title: '📊 INFO', cmds: ['ping', 'uptime', 'runtime', 'owner', 'menu'] },
  { title: '🌐 SITE CONTROL', cmds: ['sitestats', 'siteusers', 'sitewarn', 'sitesuspend', 'siteban', 'siteunban', 'sitetopup', 'sitededuct', 'sitewithdrawals', 'siteapprove', 'sitereject', 'siteannounce'] },
];

registerCmd('menu', async (conn, m, args, ctx) => {
  const { prefix, senderNumber, sessionName } = ctx;
  const us = loadUserSettings(sessionName);
  const fontNum = us.font || 1;
  const botName = us.botName || settings.BOT_NAME;
  const menuImg = us.menuImage || settings.MENU_IMAGE;
  const mode = us.mode || 'public';
  const uptime = formatUptime(Date.now() - global.botStartTime);
  const speed = measureSpeed();
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB');
  const timeStr = now.toLocaleTimeString('en-GB');
  const totalCmds = Object.keys(COMMANDS).length;
  const readmore = '\u200e\u200b'.repeat(1000);

  let menuText =
    `╭─❍ *${botName}* ❍─╮\n` +
    `│ 👤 Owner   : ${us.ownerNumber || senderNumber}\n` +
    `│ 🔑 Prefix  : ${prefix}\n` +
    `│ 🌍 Mode    : ${mode}\n` +
    `│ ⏱️ Uptime  : ${uptime}\n` +
    `│ ⚡ Speed   : ${speed}ms\n` +
    `│ 📅 Date    : ${dateStr}\n` +
    `│ 🕐 Time    : ${timeStr}\n` +
    `│ 🔢 Commands: ${totalCmds}\n` +
    `╰────────────────╯\n\n` +
    readmore;

  for (const cat of MENU_CATEGORIES) {
    const available = cat.cmds.filter(c => COMMANDS[c]);
    if (!available.length) continue;
    menuText += `┌─「 *${cat.title}* 」\n`;
    menuText += available.map(c => `│ ▸ ${prefix}${c}`).join('\n');
    menuText += `\n└───────────────\n\n`;
  }

  menuText += `_${botName} — always online for you 🚀_`;

  if (fontNum > 1) menuText = applyFont(menuText, fontNum);

  try {
    let imgMsg;
    if (menuImg && menuImg !== 'quoted' && menuImg.startsWith('http')) {
      imgMsg = { image: { url: menuImg }, caption: menuText };
    } else if (menuImg && fs.existsSync(menuImg)) {
      imgMsg = { image: fs.readFileSync(menuImg), caption: menuText };
    } else throw new Error('no image');
    await conn.sendMessage(m.key.remoteJid, imgMsg, { quoted: m });
  } catch {
    await conn.sendMessage(m.key.remoteJid, { text: menuText }, { quoted: m });
  }
});

// ─── .setprefix ───────────────────────────────────────────────────────────────
registerCmd('setprefix', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  if (!args[0]) return fReply(conn, m, `Usage: ${ctx.prefix}setprefix <symbol>`, ctx.sessionName);
  setSessionSetting(ctx.sessionName, 'prefix', args[0].trim());
  await fReply(conn, m, `✅ Prefix changed to: ${args[0].trim()}`, ctx.sessionName);
});

// ─── .setowner ────────────────────────────────────────────────────────────────
registerCmd('setowner', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  let target = resolveTarget(m, args);
  if (!target) return fReply(conn, m, `Usage: ${ctx.prefix}setowner <number>`, ctx.sessionName);
  target = target.replace(/[^0-9]/g, '');
  setSessionSetting(ctx.sessionName, 'ownerNumber', target);
  await fReply(conn, m, `✅ Owner set to: ${target}`, ctx.sessionName);
});

// ─── .setbotname ──────────────────────────────────────────────────────────────
registerCmd('setbotname', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const name = args.join(' ').trim();
  if (!name) return fReply(conn, m, `Usage: ${ctx.prefix}setbotname <name>`, ctx.sessionName);
  setSessionSetting(ctx.sessionName, 'botName', name);
  await fReply(conn, m, `✅ Bot name set to: ${name}`, ctx.sessionName);
});

// ─── .setmenuimg ──────────────────────────────────────────────────────────────
registerCmd('setmenuimg', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const imgUrl = args[0];
  if (!imgUrl) return fReply(conn, m, `Usage: ${ctx.prefix}setmenuimg <url>`, ctx.sessionName);
  setSessionSetting(ctx.sessionName, 'menuImage', imgUrl);
  await fReply(conn, m, `✅ Menu image updated.`, ctx.sessionName);
});

// ─── .setfonts ────────────────────────────────────────────────────────────────
registerCmd('setfonts', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const num = parseInt(args[0]);
  if (!num || num < 1 || num > FONT_COUNT) {
    return plainReply(conn, m,
      `Usage: ${ctx.prefix}setfonts <1-${FONT_COUNT}>\n\n` +
      `1 = Normal (Aa)\n2 = Script (𝒜𝒶)\n3 = Italic (𝐴𝑎)\n4 = Bold Italic (𝑨𝒂)\n` +
      `5 = Bold (𝐀𝐚)\n6 = Sans (𝖠𝖺)\n7 = Sans Italic (𝘈𝘢)\n8 = Sans Bold Italic (𝘼𝙖)\n` +
      `9 = Bold Sans (𝗔𝗮)\n10 = Fraktur (𝔄𝔞)\n11 = Bold Fraktur (𝕬𝖆)\n` +
      `12 = Monospace (𝙰𝚊)\n13 = Double Struck (𝔸𝕒)\n14 = Mono Alt\n\n` +
      `Use ${ctx.prefix}fonts to preview all`
    );
  }
  setSessionSetting(ctx.sessionName, 'font', num);
  // Apply the NEW font to confirmation message
  const sample = num > 1 ? applyFont('Font active! Hello World 123', num) : 'Font active! Hello World 123 (Normal)';
  await conn.sendMessage(m.key.remoteJid, { text: `✅ ${sample}` }, { quoted: m });
});

// ─── .fonts — preview list ────────────────────────────────────────────────────
registerCmd('fonts', async (conn, m, args, ctx) => {
  // Build font list WITHOUT applying session font — show raw unicode samples
  let list = `🔤 *Available Fonts*\n\nUse: ${ctx.prefix}setfonts <number>\n\n`;
  const samples = [
    '1. Normal → Hello World',
    '2. Script → 𝒜𝓁𝓁 𝒢𝓇𝑒𝒶𝓉',
    '3. Italic → 𝐻𝑒𝑙𝑙𝑜 𝑊𝑜𝑟𝑙𝑑',
    '4. Bold Italic → 𝑯𝒆𝒍𝒍𝒐 𝑾𝒐𝒓𝒍𝒅',
    '5. Bold → 𝐇𝐞𝐥𝐥𝐨 𝐖𝐨𝐫𝐥𝐝',
    '6. Sans → 𝖧𝖾𝗅𝗅𝗈 𝖶𝗈𝗋𝗅𝖽',
    '7. Sans Italic → 𝘏𝘦𝘭𝘭𝘰 𝘞𝘰𝘳𝘭𝘥',
    '8. Sans Bold Italic → 𝙃𝙚𝙡𝙡𝙤 𝙒𝙤𝙧𝙡𝙙',
    '9. Bold Sans → 𝗛𝗲𝗹𝗹𝗼 𝗪𝗼𝗿𝗹𝗱',
    '10. Fraktur → 𝔥𝔢𝔩𝔩𝔬 𝔴𝔬𝔯𝔩𝔡',
    '11. Bold Fraktur → 𝖍𝖊𝖑𝖑𝖔 𝖜𝖔𝖗𝖑𝖉',
    '12. Monospace → 𝚑𝚎𝚕𝚕𝚘 𝚠𝚘𝚛𝚕𝚍',
    '13. Double Struck → 𝕙𝕖𝕝𝕝𝕠 𝕨𝕠𝕣𝕝𝕕',
    '14. Mono Alt → 𝚑𝚎𝚕𝚕𝚘 𝚠𝚘𝚛𝚕𝚍',
  ];
  list += samples.join('\n');
  // Always send plain — don't apply session font to the preview list
  await conn.sendMessage(m.key.remoteJid, { text: list }, { quoted: m });
});

// ─── .addprem / .delprem ──────────────────────────────────────────────────────
registerCmd('addprem', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  let target = resolveTarget(m, args);
  if (!target) return fReply(conn, m, `Usage: ${ctx.prefix}addprem <number>`, ctx.sessionName);
  target = target.replace(/[^0-9]/g, '');
  await fReply(conn, m, addPremium(target) ? `✅ ${target} added as premium.` : `⚠️ Already premium.`, ctx.sessionName);
});

registerCmd('delprem', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  let target = resolveTarget(m, args);
  if (!target) return fReply(conn, m, `Usage: ${ctx.prefix}delprem <number>`, ctx.sessionName);
  target = target.replace(/[^0-9]/g, '');
  await fReply(conn, m, delPremium(target) ? `✅ ${target} removed.` : `⚠️ Not in list.`, ctx.sessionName);
});

// ─── .public / .self ─────────────────────────────────────────────────────────
registerCmd('public', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  setSessionSetting(ctx.sessionName, 'mode', 'public');
  await fReply(conn, m, '✅ Bot set to public mode.', ctx.sessionName);
});

registerCmd('self', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  setSessionSetting(ctx.sessionName, 'mode', 'self');
  await fReply(conn, m, '✅ Bot set to self mode.', ctx.sessionName);
});

// ─── .autoviewstatus / .autolikestatus ───────────────────────────────────────
registerCmd('autoviewstatus', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const next = !getSessionSetting(ctx.sessionName, 'autoViewStatus', false);
  setSessionSetting(ctx.sessionName, 'autoViewStatus', next);
  await fReply(conn, m, `✅ Auto view status: ${next ? 'ON' : 'OFF'}`, ctx.sessionName);
});

registerCmd('autolikestatus', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const next = !getSessionSetting(ctx.sessionName, 'autoLikeStatus', false);
  setSessionSetting(ctx.sessionName, 'autoLikeStatus', next);
  await fReply(conn, m, `✅ Auto like status: ${next ? 'ON' : 'OFF'}`, ctx.sessionName);
});

registerCmd('autosavestatus', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const next = !getSessionSetting(ctx.sessionName, 'autoSaveStatus', false);
  setSessionSetting(ctx.sessionName, 'autoSaveStatus', next);
  await fReply(conn, m, `✅ Auto save status: ${next ? 'ON' : 'OFF'}`, ctx.sessionName);
});

// ─── .autotyping / .autorecording ────────────────────────────────────────────
registerCmd('autotyping', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const next = !getSessionSetting(ctx.sessionName, 'autoTyping', false);
  setSessionSetting(ctx.sessionName, 'autoTyping', next);
  await fReply(conn, m, `✅ Auto typing: ${next ? 'ON' : 'OFF'}`, ctx.sessionName);
});

registerCmd('autorecording', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const next = !getSessionSetting(ctx.sessionName, 'autoRecording', false);
  setSessionSetting(ctx.sessionName, 'autoRecording', next);
  await fReply(conn, m, `✅ Auto recording: ${next ? 'ON' : 'OFF'}`, ctx.sessionName);
});

// ─── .autogroupreact ──────────────────────────────────────────────────────────
registerCmd('autogroupreact', async (conn, m, args, ctx) => {
  if (!ctx.isOwner && !ctx.isAdmin) return fReply(conn, m, '❌ Admin only.', ctx.sessionName);
  const next = !getSessionSetting(ctx.sessionName, 'autoGroupReact', false);
  setSessionSetting(ctx.sessionName, 'autoGroupReact', next);
  await fReply(conn, m, `✅ Auto group react: ${next ? 'ON' : 'OFF'}`, ctx.sessionName);
});

// ─── .antilink ───────────────────────────────────────────────────────────────
registerCmd('antilink', async (conn, m, args, ctx) => {
  if (!ctx.isOwner && !ctx.isAdmin) return fReply(conn, m, '❌ Admin only.', ctx.sessionName);
  const option = (args[0] || '').toLowerCase();
  if (!['off', 'del', 'warn', 'kick'].includes(option))
    return fReply(conn, m, `Usage: ${ctx.prefix}antilink off/del/warn/kick`, ctx.sessionName);
  setSessionSetting(ctx.sessionName, 'antilink', option);
  await fReply(conn, m, `✅ Antilink: ${option.toUpperCase()}`, ctx.sessionName);
});

// ─── .antidelete ─────────────────────────────────────────────────────────────
registerCmd('antidelete', async (conn, m, args, ctx) => {
  if (!ctx.isOwner && !ctx.isAdmin) return fReply(conn, m, '❌ Admin only.', ctx.sessionName);
  const next = !getSessionSetting(ctx.sessionName, 'antidelete', false);
  setSessionSetting(ctx.sessionName, 'antidelete', next);
  await fReply(conn, m, `✅ Antidelete: ${next ? 'ON' : 'OFF'}`, ctx.sessionName);
});

// ─── .promote — works via reply to message, @mention, or number ──────────────
registerCmd('promote', async (conn, m, args, ctx) => {
  if (!ctx.isOwner && !ctx.isAdmin) return fReply(conn, m, '❌ Admin only.', ctx.sessionName);
  const remoteJid = m.key.remoteJid;
  if (!remoteJid.endsWith('@g.us')) return fReply(conn, m, '❌ Groups only.', ctx.sessionName);

  const target = resolveTarget(m, args);
  if (!target) return fReply(conn, m, `Reply to a message, @mention, or provide number.\nUsage: ${ctx.prefix}promote`, ctx.sessionName);
  const targetJid = target.includes('@') ? target : `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  const targetNum = normalizeNumber(targetJid);

  await conn.groupParticipantsUpdate(remoteJid, [targetJid], 'promote');
  await conn.sendMessage(remoteJid, {
    text: `👑 @${targetNum} has been promoted to admin!`,
    mentions: [targetJid]
  }, { quoted: m });
});

// ─── .demote ─────────────────────────────────────────────────────────────────
registerCmd('demote', async (conn, m, args, ctx) => {
  if (!ctx.isOwner && !ctx.isAdmin) return fReply(conn, m, '❌ Admin only.', ctx.sessionName);
  const remoteJid = m.key.remoteJid;
  if (!remoteJid.endsWith('@g.us')) return fReply(conn, m, '❌ Groups only.', ctx.sessionName);

  const target = resolveTarget(m, args);
  if (!target) return fReply(conn, m, `Reply to a message, @mention, or provide number.\nUsage: ${ctx.prefix}demote`, ctx.sessionName);
  const targetJid = target.includes('@') ? target : `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  const targetNum = normalizeNumber(targetJid);

  await conn.groupParticipantsUpdate(remoteJid, [targetJid], 'demote');
  await conn.sendMessage(remoteJid, {
    text: `⬇️ @${targetNum} has been demoted.`,
    mentions: [targetJid]
  }, { quoted: m });
});

// ─── .kick ───────────────────────────────────────────────────────────────────
registerCmd('kick', async (conn, m, args, ctx) => {
  if (!ctx.isOwner && !ctx.isAdmin) return fReply(conn, m, '❌ Admin only.', ctx.sessionName);
  const remoteJid = m.key.remoteJid;
  if (!remoteJid.endsWith('@g.us')) return fReply(conn, m, '❌ Groups only.', ctx.sessionName);

  const target = resolveTarget(m, args);
  if (!target) return fReply(conn, m, `Reply to a message, @mention, or provide number.\nUsage: ${ctx.prefix}kick`, ctx.sessionName);
  const targetJid = target.includes('@') ? target : `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  const targetNum = normalizeNumber(targetJid);

  await conn.groupParticipantsUpdate(remoteJid, [targetJid], 'remove');
  await conn.sendMessage(remoteJid, {
    text: `🦵 @${targetNum} has been kicked from the group.`,
    mentions: [targetJid]
  }, { quoted: m });
});

// ─── .group open/close ───────────────────────────────────────────────────────
registerCmd('group', async (conn, m, args, ctx) => {
  if (!ctx.isOwner && !ctx.isAdmin) return fReply(conn, m, '❌ Admin only.', ctx.sessionName);
  const remoteJid = m.key.remoteJid;
  if (!remoteJid.endsWith('@g.us')) return fReply(conn, m, '❌ Groups only.', ctx.sessionName);
  const option = (args[0] || '').toLowerCase();
  if (option === 'open') {
    await conn.groupSettingUpdate(remoteJid, 'not_announcement');
    await fReply(conn, m, '✅ Group opened.', ctx.sessionName);
  } else if (option === 'close') {
    await conn.groupSettingUpdate(remoteJid, 'announcement');
    await fReply(conn, m, '✅ Group closed — admins only.', ctx.sessionName);
  } else {
    await fReply(conn, m, `Usage: ${ctx.prefix}group open/close`, ctx.sessionName);
  }
});

// ─── .add ────────────────────────────────────────────────────────────────────
registerCmd('add', async (conn, m, args, ctx) => {
  if (!ctx.isOwner && !ctx.isAdmin) return fReply(conn, m, '❌ Admin only.', ctx.sessionName);
  const remoteJid = m.key.remoteJid;
  if (!remoteJid.endsWith('@g.us')) return fReply(conn, m, '❌ Groups only.', ctx.sessionName);
  let target = (args[0] || '').replace(/[^0-9]/g, '');
  if (!target) return fReply(conn, m, `Usage: ${ctx.prefix}add <number>`, ctx.sessionName);
  await conn.groupParticipantsUpdate(remoteJid, [`${target}@s.whatsapp.net`], 'add');
  await fReply(conn, m, `✅ ${target} added to group.`, ctx.sessionName);
});

// ─── .tagall ─────────────────────────────────────────────────────────────────
registerCmd('tagall', async (conn, m, args, ctx) => {
  if (!ctx.isOwner && !ctx.isAdmin) return fReply(conn, m, '❌ Admin only.', ctx.sessionName);
  const remoteJid = m.key.remoteJid;
  if (!remoteJid.endsWith('@g.us')) return fReply(conn, m, '❌ Groups only.', ctx.sessionName);
  const meta = await conn.groupMetadata(remoteJid);
  const members = meta.participants.map(p => p.id);
  const message = args.join(' ') || 'Attention everyone!';
  const text = message + '\n\n' + members.map(id => `@${normalizeNumber(id)}`).join(' ');
  await conn.sendMessage(remoteJid, { text, mentions: members }, { quoted: m });
});

// ─── .groupinfo ──────────────────────────────────────────────────────────────
registerCmd('groupinfo', async (conn, m, args, ctx) => {
  const remoteJid = m.key.remoteJid;
  if (!remoteJid.endsWith('@g.us')) return fReply(conn, m, '❌ Groups only.', ctx.sessionName);
  const meta = await conn.groupMetadata(remoteJid);
  const admins = meta.participants.filter(p => p.admin).map(p => normalizeNumber(p.id)).join(', ');
  await fReply(conn, m,
    `📋 *Group Info*\n\n` +
    `🏷️ Name: ${meta.subject}\n` +
    `👥 Members: ${meta.participants.length}\n` +
    `👮 Admins: ${admins || 'None'}\n` +
    `📝 Desc: ${meta.desc || 'None'}`,
    ctx.sessionName
  );
});

// ─── .mute / .unmute ─────────────────────────────────────────────────────────
registerCmd('mute', async (conn, m, args, ctx) => {
  if (!ctx.isOwner && !ctx.isAdmin) return fReply(conn, m, '❌ Admin only.', ctx.sessionName);
  if (!m.key.remoteJid.endsWith('@g.us')) return fReply(conn, m, '❌ Groups only.', ctx.sessionName);
  await conn.groupSettingUpdate(m.key.remoteJid, 'announcement');
  await fReply(conn, m, '🔇 Group muted.', ctx.sessionName);
});

registerCmd('unmute', async (conn, m, args, ctx) => {
  if (!ctx.isOwner && !ctx.isAdmin) return fReply(conn, m, '❌ Admin only.', ctx.sessionName);
  if (!m.key.remoteJid.endsWith('@g.us')) return fReply(conn, m, '❌ Groups only.', ctx.sessionName);
  await conn.groupSettingUpdate(m.key.remoteJid, 'not_announcement');
  await fReply(conn, m, '🔊 Group unmuted.', ctx.sessionName);
});

// ─── .sticker — uses downloadContentFromMessage ───────────────────────────────
registerCmd('sticker', async (conn, m, args, ctx) => {
  const remoteJid = m.key.remoteJid;
  const quotedCtx = getQuotedCtx(m);
  const quotedMsg = getQuotedMsg(m);

  // Figure out which message has media
  let mediaSource = null;
  let mediaType = null;

  if (quotedMsg) {
    const t = getMediaType(quotedMsg);
    if (t && (t.type === 'image' || t.type === 'video')) {
      mediaSource = t.inner;
      mediaType = t.type;
    }
  }
  if (!mediaSource) {
    const t = getMediaType(m.message || {});
    if (t && (t.type === 'image' || t.type === 'video')) {
      mediaSource = t.inner;
      mediaType = t.type;
    }
  }

  if (!mediaSource) return fReply(conn, m, `Reply to an image or video with ${ctx.prefix}sticker`, ctx.sessionName);

  try {
    const buf = await downloadMedia(mediaSource, mediaType);
    await conn.sendMessage(remoteJid, { sticker: buf }, { quoted: m });
  } catch (e) {
    await plainReply(conn, m, `❌ Sticker failed: ${e.message}`);
  }
});

// ─── .toimg — sticker to image ───────────────────────────────────────────────
registerCmd('toimg', async (conn, m, args, ctx) => {
  const remoteJid = m.key.remoteJid;
  const quotedMsg = getQuotedMsg(m);
  const stickerObj = quotedMsg?.stickerMessage || m.message?.stickerMessage;
  if (!stickerObj) return fReply(conn, m, `Reply to a sticker with ${ctx.prefix}toimg`, ctx.sessionName);

  try {
    const buf = await downloadMedia(stickerObj, 'sticker');
    await conn.sendMessage(remoteJid, { image: buf, caption: '🖼️ Converted sticker' }, { quoted: m });
  } catch (e) {
    await plainReply(conn, m, `❌ Failed: ${e.message}`);
  }
});

// ─── .play — search & download audio via fallback APIs ──────────────────────
registerCmd('play', async (conn, m, args, ctx) => {
  const query = args.join(' ').trim();
  if (!query) return fReply(conn, m, `Usage: ${ctx.prefix}play <song name / YouTube link>`, ctx.sessionName);

  try {
    let ytUrl = query;
    let title = query;

    if (!/youtu\.?be/i.test(query)) {
      const searchRes = await yts(query);
      const video = searchRes?.videos?.[0];
      if (!video) return fReply(conn, m, '❌ No results found.', ctx.sessionName);
      ytUrl = video.url;
      title = video.title;
    }

    const audioUrl = await fetchYtMp3(ytUrl);
    if (!audioUrl) return fReply(conn, m, '❌ All download sources failed. Try again later.', ctx.sessionName);

    await conn.sendMessage(m.key.remoteJid, {
      audio: { url: audioUrl },
      mimetype: 'audio/mpeg',
      fileName: `${title}.mp3`,
    }, { quoted: m });
  } catch (e) {
    await plainReply(conn, m, `❌ Play failed: ${e.message}`);
  }
});

// ─── .vv — reveal view-once ───────────────────────────────────────────────────
registerCmd('vv', async (conn, m, args, ctx) => {
  const remoteJid = m.key.remoteJid;
  const quotedMsg = getQuotedMsg(m);
  if (!quotedMsg) return fReply(conn, m, `Reply to a view-once message with ${ctx.prefix}vv`, ctx.sessionName);

  const inner = quotedMsg?.viewOnceMessageV2?.message || quotedMsg?.viewOnceMessage?.message || quotedMsg;
  const t = getMediaType(inner);
  if (!t) return fReply(conn, m, '❌ No media found in quoted message.', ctx.sessionName);

  try {
    const buf = await downloadMedia(t.inner, t.type);
    if (t.type === 'image') {
      await conn.sendMessage(remoteJid, { image: buf, caption: '👁️ View Once Revealed' }, { quoted: m });
    } else if (t.type === 'video') {
      await conn.sendMessage(remoteJid, { video: buf, caption: '👁️ View Once Revealed' }, { quoted: m });
    }
  } catch (e) {
    await plainReply(conn, m, `❌ Failed: ${e.message}`);
  }
});

// ─── .copy ───────────────────────────────────────────────────────────────────
registerCmd('copy', async (conn, m, args, ctx) => {
  const quotedMsg = getQuotedMsg(m);
  if (!quotedMsg) return fReply(conn, m, `Reply to a message with ${ctx.prefix}copy`, ctx.sessionName);
  await conn.sendMessage(m.key.remoteJid, quotedMsg, { quoted: m });
});

// ─── .ping ───────────────────────────────────────────────────────────────────
registerCmd('ping', async (conn, m, args, ctx) => {
  const start = Date.now();
  await conn.sendMessage(m.key.remoteJid, { text: '🏓 Pong!' }, { quoted: m });
  const ms = Date.now() - start;
  await fReply(conn, m, `🏓 Pong! ${ms}ms`, ctx.sessionName);
});

// ─── .uptime ─────────────────────────────────────────────────────────────────
registerCmd('uptime', async (conn, m, args, ctx) => {
  await fReply(conn, m, `⏱️ Uptime: ${formatUptime(Date.now() - global.botStartTime)}`, ctx.sessionName);
});

// ─── .runtime ────────────────────────────────────────────────────────────────
registerCmd('runtime', async (conn, m, args, ctx) => {
  const mem = process.memoryUsage();
  await fReply(conn, m,
    `🖥️ *System Info*\n\n` +
    `⏱️ Uptime: ${formatUptime(Date.now() - global.botStartTime)}\n` +
    `💾 RAM: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB\n` +
    `💻 Platform: ${os.platform()}\n` +
    `🔢 Node.js: ${process.version}`,
    ctx.sessionName
  );
});

// ─── .owner ──────────────────────────────────────────────────────────────────
registerCmd('owner', async (conn, m, args, ctx) => {
  const us = loadUserSettings(ctx.sessionName);
  const ownerNum = us.ownerNumber || ctx.botNumber;
  await conn.sendMessage(m.key.remoteJid, {
    text: `👑 *Bot Owner*\n\nwa.me/${ownerNum}`,
    mentions: [`${ownerNum}@s.whatsapp.net`]
  }, { quoted: m });
});

// ─── .addautojoin ─────────────────────────────────────────────────────────────
registerCmd('addautojoin', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const link = args[0];
  if (!link) return fReply(conn, m, `Usage: ${ctx.prefix}addautojoin <invite_link>`, ctx.sessionName);
  const us = loadUserSettings(ctx.sessionName);
  if (!us.autoJoinGroups) us.autoJoinGroups = [];
  if (us.autoJoinGroups.includes(link)) return fReply(conn, m, '⚠️ Already added.', ctx.sessionName);
  if (us.autoJoinGroups.length >= 2) return fReply(conn, m, '❌ Max 2 groups.', ctx.sessionName);
  us.autoJoinGroups.push(link);
  saveUserSettings(ctx.sessionName, us);
  try {
    const code = link.split('https://chat.whatsapp.com/')[1];
    if (code) await conn.groupAcceptInvite(code);
  } catch {}
  await fReply(conn, m, `✅ Auto-join group saved: ${link}`, ctx.sessionName);
});

// ─── .listautojoin ────────────────────────────────────────────────────────────
registerCmd('listautojoin', async (conn, m, args, ctx) => {
  const us = loadUserSettings(ctx.sessionName);
  const list = us.autoJoinGroups || [];
  await fReply(conn, m, list.length ? `👥 Auto-join:\n${list.join('\n')}` : '📭 No groups saved.', ctx.sessionName);
});

// ─── .ban / .unban ───────────────────────────────────────────────────────────
const bannedUsers = new Set();

registerCmd('ban', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  let target = resolveTarget(m, args);
  if (!target) return fReply(conn, m, `Usage: ${ctx.prefix}ban <number>`, ctx.sessionName);
  target = target.replace(/[^0-9]/g, '');
  bannedUsers.add(target);
  await fReply(conn, m, `✅ ${target} banned.`, ctx.sessionName);
});

registerCmd('unban', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  let target = resolveTarget(m, args);
  if (!target) return fReply(conn, m, `Usage: ${ctx.prefix}unban <number>`, ctx.sessionName);
  target = target.replace(/[^0-9]/g, '');
  bannedUsers.delete(target);
  await fReply(conn, m, `✅ ${target} unbanned.`, ctx.sessionName);
});

// ══════════════════════════════════════════════════════════════════════════
//  SITE CONTROL — talks to the ScottyHub API via SITE_API_KEY (owner only)
// ══════════════════════════════════════════════════════════════════════════

// ─── .sitestats ─────────────────────────────────────────────────────────────
registerCmd('sitestats', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const r = await siteRequest('get', '/admin/stats');
  if (!r.ok) return fReply(conn, m, `❌ ${r.error}`, ctx.sessionName);
  const s = r.data;
  await fReply(conn, m,
    `📊 *ScottyHub Stats*\n\n` +
    `👤 Users: ${s.totalUsers} (${s.verifiedUsers} verified)\n` +
    `📝 Posts: ${s.totalPosts}\n` +
    `📰 News: ${s.totalNews}\n` +
    `⚡ COPS in circulation: ${s.totalCopsInCirculation}\n` +
    `💰 Pending withdrawals: ${s.pendingWithdrawals} (⚡${s.pendingWithdrawalAmount})\n` +
    `⭐ Active premium users: ${s.activePremiumUsers}\n` +
    `🛒 Marketplace listings: ${s.activeMarketplaceListings}\n` +
    `🚩 Pending reports: ${s.pendingReports}`,
    ctx.sessionName);
});

// ─── .siteusers [search] ────────────────────────────────────────────────────
registerCmd('siteusers', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const search = args.join(' ').trim();
  const r = await siteRequest('get', search ? `/admin/users?search=${encodeURIComponent(search)}` : '/admin/users');
  if (!r.ok) return fReply(conn, m, `❌ ${r.error}`, ctx.sessionName);
  const users = r.data.users || [];
  if (!users.length) return fReply(conn, m, 'No users found.', ctx.sessionName);
  const list = users.slice(0, 20).map(u =>
    `▸ *${u.username}* (${u.id})\n   ${u.email} · ⚡${u.wallet_balance} · ${u.role} · ${u.account_status}`
  ).join('\n');
  await fReply(conn, m, `👥 *Users* (${users.length}${users.length > 20 ? ', showing 20' : ''})\n\n${list}`, ctx.sessionName);
});

// ─── .sitewarn <userId> <reason> ────────────────────────────────────────────
registerCmd('sitewarn', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const [userId, ...reasonParts] = args;
  if (!userId) return fReply(conn, m, `Usage: ${ctx.prefix}sitewarn <userId> <reason>`, ctx.sessionName);
  const r = await siteRequest('post', `/admin/users/${userId}/warn`, { reason: reasonParts.join(' ') });
  await fReply(conn, m, r.ok ? `✅ ${r.data.message}` : `❌ ${r.error}`, ctx.sessionName);
});

// ─── .sitesuspend <userId> <days> <reason> ─────────────────────────────────
registerCmd('sitesuspend', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const [userId, days, ...reasonParts] = args;
  if (!userId) return fReply(conn, m, `Usage: ${ctx.prefix}sitesuspend <userId> <days> <reason>`, ctx.sessionName);
  const r = await siteRequest('post', `/admin/users/${userId}/suspend`, { days: parseInt(days, 10) || 7, reason: reasonParts.join(' ') });
  await fReply(conn, m, r.ok ? `✅ ${r.data.message}` : `❌ ${r.error}`, ctx.sessionName);
});

// ─── .siteban <userId> ──────────────────────────────────────────────────────
registerCmd('siteban', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const [userId] = args;
  if (!userId) return fReply(conn, m, `Usage: ${ctx.prefix}siteban <userId>`, ctx.sessionName);
  const r = await siteRequest('post', `/admin/users/${userId}/ban`);
  await fReply(conn, m, r.ok ? `✅ ${r.data.message}` : `❌ ${r.error}`, ctx.sessionName);
});

// ─── .siteunban <userId> ────────────────────────────────────────────────────
registerCmd('siteunban', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const [userId] = args;
  if (!userId) return fReply(conn, m, `Usage: ${ctx.prefix}siteunban <userId>`, ctx.sessionName);
  const r = await siteRequest('post', `/admin/users/${userId}/unban`);
  await fReply(conn, m, r.ok ? `✅ ${r.data.message}` : `❌ ${r.error}`, ctx.sessionName);
});

// ─── .sitetopup <userId> <amount> [description] ────────────────────────────
registerCmd('sitetopup', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const [userId, amount, ...descParts] = args;
  if (!userId || !amount || isNaN(amount)) return fReply(conn, m, `Usage: ${ctx.prefix}sitetopup <userId> <amount> [description]`, ctx.sessionName);
  const r = await siteRequest('post', '/admin/wallet/topup', { userId, amount, description: descParts.join(' ') });
  await fReply(conn, m, r.ok ? `✅ ${r.data.message} — new balance: ⚡${r.data.balance}` : `❌ ${r.error}`, ctx.sessionName);
});

// ─── .sitededuct <userId> <amount> [description] ───────────────────────────
registerCmd('sitededuct', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const [userId, amount, ...descParts] = args;
  if (!userId || !amount || isNaN(amount)) return fReply(conn, m, `Usage: ${ctx.prefix}sitededuct <userId> <amount> [description]`, ctx.sessionName);
  const r = await siteRequest('post', '/admin/wallet/deduct', { userId, amount, description: descParts.join(' ') });
  await fReply(conn, m, r.ok ? `✅ ${r.data.message} — new balance: ⚡${r.data.balance}` : `❌ ${r.error}`, ctx.sessionName);
});

// ─── .sitewithdrawals [status] ──────────────────────────────────────────────
registerCmd('sitewithdrawals', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const status = args[0];
  const r = await siteRequest('get', status ? `/admin/withdrawals?status=${encodeURIComponent(status)}` : '/admin/withdrawals');
  if (!r.ok) return fReply(conn, m, `❌ ${r.error}`, ctx.sessionName);
  const list = r.data.withdrawals || [];
  if (!list.length) return fReply(conn, m, 'No withdrawals found.', ctx.sessionName);
  const text = list.slice(0, 15).map(w =>
    `▸ *${w.id}*\n   ${w.username} · ⚡${w.amount} · ${w.method} · ${w.status}`
  ).join('\n');
  await fReply(conn, m, `💸 *Withdrawals* (${list.length}${list.length > 15 ? ', showing 15' : ''})\n\n${text}`, ctx.sessionName);
});

// ─── .siteapprove <withdrawalId> [note] ─────────────────────────────────────
registerCmd('siteapprove', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const [id, ...noteParts] = args;
  if (!id) return fReply(conn, m, `Usage: ${ctx.prefix}siteapprove <withdrawalId> [note]`, ctx.sessionName);
  const r = await siteRequest('post', `/admin/withdrawals/${id}/approve`, { note: noteParts.join(' ') });
  await fReply(conn, m, r.ok ? `✅ ${r.data.message}` : `❌ ${r.error}`, ctx.sessionName);
});

// ─── .sitereject <withdrawalId> [note] ──────────────────────────────────────
registerCmd('sitereject', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const [id, ...noteParts] = args;
  if (!id) return fReply(conn, m, `Usage: ${ctx.prefix}sitereject <withdrawalId> [note]`, ctx.sessionName);
  const r = await siteRequest('post', `/admin/withdrawals/${id}/reject`, { note: noteParts.join(' ') });
  await fReply(conn, m, r.ok ? `✅ ${r.data.message}` : `❌ ${r.error}`, ctx.sessionName);
});

// ─── .siteannounce <message> ────────────────────────────────────────────────
registerCmd('siteannounce', async (conn, m, args, ctx) => {
  if (!ctx.isOwner) return fReply(conn, m, '❌ Owner only.', ctx.sessionName);
  const content = args.join(' ').trim();
  if (!content) return fReply(conn, m, `Usage: ${ctx.prefix}siteannounce <message>`, ctx.sessionName);
  const r = await siteRequest('post', '/admin/announce', { content });
  await fReply(conn, m, r.ok ? `✅ ${r.data.message}` : `❌ ${r.error}`, ctx.sessionName);
});

// ─── Link regex ───────────────────────────────────────────────────────────────
const LINK_REGEX = /(https?:\/\/|www\.|chat\.whatsapp\.com\/|t\.me\/)[^\s]*/i;
function containsLink(text) { return LINK_REGEX.test(text || ''); }

// ─── Auto-save status media to bot's own DM ───────────────────────────────────
async function saveStatusMedia(conn, m) {
  const selfNumber = normalizeNumber(conn.user.id);
  const selfJid = `${selfNumber}@s.whatsapp.net`;
  const msg = m.message;
  if (!msg) return;

  const participant = m.key.participant || m.key.remoteJid;
  const senderNum = normalizeNumber(participant);
  const caption = `💾 *Saved Status*\n👤 @${senderNum}`;

  if (msg.imageMessage) {
    const buf = await downloadMedia(msg.imageMessage, 'image');
    await conn.sendMessage(selfJid, {
      image: buf,
      caption: `${caption}\n${msg.imageMessage.caption || ''}`,
      mentions: [`${senderNum}@s.whatsapp.net`]
    });
  } else if (msg.videoMessage) {
    const buf = await downloadMedia(msg.videoMessage, 'video');
    await conn.sendMessage(selfJid, {
      video: buf,
      caption: `${caption}\n${msg.videoMessage.caption || ''}`,
      mentions: [`${senderNum}@s.whatsapp.net`]
    });
  } else if (msg.conversation || msg.extendedTextMessage) {
    const text = msg.conversation || msg.extendedTextMessage?.text || '';
    await conn.sendMessage(selfJid, {
      text: `${caption}\n\n${text}`,
      mentions: [`${senderNum}@s.whatsapp.net`]
    });
  }
}

// ─── Status handler ───────────────────────────────────────────────────────────
async function handleStatus(conn, m, sessionName) {
  const autoView = getSessionSetting(sessionName, 'autoViewStatus', false);
  const autoLike = getSessionSetting(sessionName, 'autoLikeStatus', false);
  const autoSave = getSessionSetting(sessionName, 'autoSaveStatus', false);
  if (autoView || autoLike) await conn.readMessages([m.key]);
  if (autoLike) {
    try { await conn.sendMessage(m.key.remoteJid, { react: { text: '❤️', key: m.key } }); } catch {}
  }
  if (autoSave) {
    try { await saveStatusMedia(conn, m); } catch (e) { process.stdout.write(`[AUTOSAVE ERR] ${e.message}\n`); }
  }
}

// ─── Antidelete handler ───────────────────────────────────────────────────────
async function handleDelete(conn, update, sessionName) {
  const enabled = getSessionSetting(sessionName, 'antidelete', false);
  if (!enabled) return;

  const keys = update?.keys || [];
  for (const key of keys) {
    const stored = getStoredMsg(sessionName, key.id);
    if (!stored) continue;
    const remoteJid = stored.key.remoteJid;
    const sender = normalizeNumber(stored.key.participant || stored.key.remoteJid);
    const msg = stored.message;
    if (!msg) continue;

    const header = `🔒 *Antidelete*\n👤 @${sender}`;

    try {
      if (msg.conversation || msg.extendedTextMessage) {
        const text = msg.conversation || msg.extendedTextMessage?.text || '';
        await conn.sendMessage(remoteJid, {
          text: `${header}\n\n${text}`,
          mentions: [`${sender}@s.whatsapp.net`]
        });
      } else if (msg.imageMessage) {
        const buf = await downloadMedia(msg.imageMessage, 'image');
        await conn.sendMessage(remoteJid, { image: buf, caption: `${header}\n${msg.imageMessage.caption || ''}`, mentions: [`${sender}@s.whatsapp.net`] });
      } else if (msg.videoMessage) {
        const buf = await downloadMedia(msg.videoMessage, 'video');
        await conn.sendMessage(remoteJid, { video: buf, caption: `${header}\n${msg.videoMessage.caption || ''}`, mentions: [`${sender}@s.whatsapp.net`] });
      } else if (msg.audioMessage) {
        const buf = await downloadMedia(msg.audioMessage, 'audio');
        await conn.sendMessage(remoteJid, { audio: buf, mimetype: 'audio/mp4' });
        await conn.sendMessage(remoteJid, { text: header, mentions: [`${sender}@s.whatsapp.net`] });
      } else if (msg.stickerMessage) {
        const buf = await downloadMedia(msg.stickerMessage, 'sticker');
        await conn.sendMessage(remoteJid, { sticker: buf });
        await conn.sendMessage(remoteJid, { text: header, mentions: [`${sender}@s.whatsapp.net`] });
      } else if (msg.documentMessage) {
        const buf = await downloadMedia(msg.documentMessage, 'document');
        await conn.sendMessage(remoteJid, { document: buf, mimetype: msg.documentMessage.mimetype, fileName: msg.documentMessage.fileName });
        await conn.sendMessage(remoteJid, { text: header, mentions: [`${sender}@s.whatsapp.net`] });
      } else {
        await conn.sendMessage(remoteJid, { text: `${header}\n[Unsupported message type deleted]`, mentions: [`${sender}@s.whatsapp.net`] });
      }
    } catch (e) {
      process.stdout.write(`[ANTIDELETE ERR] ${e.message}\n`);
    }
  }
}

// ─── Antilink handler ─────────────────────────────────────────────────────────
async function handleAntilink(conn, m, sessionName, senderJid, botNumber) {
  const mode = getSessionSetting(sessionName, 'antilink', 'off');
  if (mode === 'off') return;
  const text = getMsgText(m);
  if (!containsLink(text)) return;
  const remoteJid = m.key.remoteJid;
  const senderNumber = normalizeNumber(senderJid);
  if (senderNumber === botNumber) return;
  // Skip if sender is admin
  if (await isGroupAdmin(conn, remoteJid, senderJid)) return;

  if (mode === 'del') {
    await conn.sendMessage(remoteJid, { delete: m.key });
  } else if (mode === 'warn') {
    await conn.sendMessage(remoteJid, { delete: m.key });
    await conn.sendMessage(remoteJid, {
      text: `⚠️ @${senderNumber} links are not allowed!`,
      mentions: [senderJid]
    });
  } else if (mode === 'kick') {
    await conn.sendMessage(remoteJid, { delete: m.key });
    await conn.groupParticipantsUpdate(remoteJid, [senderJid], 'remove');
  }
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────
async function handleMessage(conn, m, sessionName, ownerNumber) {
  try {
    if (!m?.message) return;
    const remoteJid = m.key.remoteJid;

    if (remoteJid === 'status@broadcast') {
      await handleStatus(conn, m, sessionName);
      return;
    }

    if (m.message.ephemeralMessage) m.message = m.message.ephemeralMessage.message;

    // Store for antidelete before any processing
    storeMsg(sessionName, m);

    // senderJid: in groups it's participant, in DMs it's remoteJid
    const senderJid = m.key.fromMe
      ? (conn.user.id)
      : (m.key.participant || remoteJid);

    const senderNumber = cleanJidNumber(senderJid);
    const botNumber = cleanJidNumber(conn.user.id);

    if (bannedUsers.has(senderNumber)) return;

    if (remoteJid.endsWith('@g.us')) {
      await handleAntilink(conn, m, sessionName, senderJid, botNumber);

      if (!m.key.fromMe && getSessionSetting(sessionName, 'autoGroupReact', false)) {
        const emojis = ['😂', '❤️', '🔥', '👍', '😮', '🎉', '💯', '😍'];
        const emoji = emojis[Math.floor(Math.random() * emojis.length)];
        try { await conn.sendMessage(remoteJid, { react: { text: emoji, key: m.key } }); } catch {}
      }
    }

    // Auto typing / recording presence simulation
    if (!m.key.fromMe) {
      if (getSessionSetting(sessionName, 'autoTyping', false)) {
        try { await conn.sendPresenceUpdate('composing', remoteJid); } catch {}
      }
      if (getSessionSetting(sessionName, 'autoRecording', false)) {
        try { await conn.sendPresenceUpdate('recording', remoteJid); } catch {}
      }
    }

    const userSettings = loadUserSettings(sessionName);
    const prefix = userSettings.prefix || settings.DEFAULT_PREFIX;
    const mode = userSettings.mode || 'public';

    const msgContent = getMsgText(m);
    if (!msgContent.startsWith(prefix)) return;

    const body = msgContent.slice(prefix.length).trim();
    const [commandRaw, ...args] = body.split(' ');
    const command = commandRaw.toLowerCase();

    // Owner check: match against stored ownerNumber, passed ownerNumber, or bot itself
    const storedOwner = cleanJidNumber(userSettings.ownerNumber || '');
    const isOwner = !!(
      senderNumber === cleanJidNumber(ownerNumber) ||
      (storedOwner && senderNumber === storedOwner) ||
      senderNumber === botNumber ||
      m.key.fromMe
    );

    const isUserPremium = isPremium(senderNumber);

    // Admin check — use isGroupAdmin which does proper JID cleaning
    let isAdmin = false;
    if (remoteJid.endsWith('@g.us')) {
      isAdmin = await isGroupAdmin(conn, remoteJid, senderJid);
    }

    if (mode === 'self' && !isOwner) return;

    const ctx = {
      prefix, sessionName, senderNumber, botNumber,
      isOwner, isUserPremium, isAdmin, args, command,
      senderJid
    };

    if (COMMANDS[command]) {
      await COMMANDS[command](conn, m, args, ctx);
    }
  } catch (err) {
    process.stdout.write(`[CASE ERROR] ${err.message}\n`);
  }
}

module.exports = { handleMessage, handleDelete, storeMsg, COMMANDS };
