/*
 * Alexa — WhatsApp Multi-Session Bot
 */

const fs = require('fs');
const path = require('path');
const settings = require('../settings');

// ─── Premium ───────────────────────────────────────────────────────────────────
function loadPremium() {
  try { return JSON.parse(fs.readFileSync(settings.PREMIUM_DB, 'utf-8')); }
  catch { return { premiumUsers: [] }; }
}
function savePremium(data) { fs.writeFileSync(settings.PREMIUM_DB, JSON.stringify(data, null, 2)); }
function isPremium(number) { return loadPremium().premiumUsers.includes(number); }
function addPremium(number) {
  const db = loadPremium();
  if (db.premiumUsers.includes(number)) return false;
  db.premiumUsers.push(number); savePremium(db); return true;
}
function delPremium(number) {
  const db = loadPremium();
  const idx = db.premiumUsers.indexOf(number);
  if (idx === -1) return false;
  db.premiumUsers.splice(idx, 1); savePremium(db); return true;
}

// ─── Sessions ──────────────────────────────────────────────────────────────────
function getSessionDir(sessionName) { return path.join(settings.SESSIONS_DIR, sessionName); }
function sessionExists(sessionName) {
  const dir = getSessionDir(sessionName);
  return fs.existsSync(dir) && fs.existsSync(path.join(dir, 'creds.json'));
}
function deleteSession(sessionName) {
  const dir = getSessionDir(sessionName);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true }); return true;
}
function listSessions() {
  if (!fs.existsSync(settings.SESSIONS_DIR)) return [];
  return fs.readdirSync(settings.SESSIONS_DIR).filter(name =>
    fs.existsSync(path.join(settings.SESSIONS_DIR, name, 'creds.json'))
  );
}

// ─── Per-session settings ──────────────────────────────────────────────────────
function getUserSettingsPath(sessionName) {
  return path.join(settings.SESSIONS_DIR, sessionName, 'usersettings.json');
}
function defaultSettings() {
  return {
    prefix: settings.DEFAULT_PREFIX,
    mode: 'public',
    ownerNumber: '',
    telegramChatId: null,
    autoViewStatus: false,
    autoLikeStatus: false,
    antilink: 'off',
    antidelete: false,
    font: 1,
    botName: settings.BOT_NAME,
    menuImage: settings.MENU_IMAGE,
    autoJoinGroups: [],
    autoTyping: false,
    autoRecording: false,
    autoSaveStatus: false,
    autoGroupReact: false,
  };
}
function loadUserSettings(sessionName) {
  const p = getUserSettingsPath(sessionName);
  try { return Object.assign(defaultSettings(), JSON.parse(fs.readFileSync(p, 'utf-8'))); }
  catch { return defaultSettings(); }
}
function saveUserSettings(sessionName, data) {
  const dir = getSessionDir(sessionName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getUserSettingsPath(sessionName), JSON.stringify(data, null, 2));
}
function getSessionSetting(sessionName, key, fallback = null) {
  const us = loadUserSettings(sessionName);
  return (key in us && us[key] !== undefined && us[key] !== null) ? us[key] : fallback;
}
function setSessionSetting(sessionName, key, value) {
  const us = loadUserSettings(sessionName);
  us[key] = value;
  saveUserSettings(sessionName, us);
}

// ─── Admin check — strips device suffix + domain, checks every way ────────────
// senderJid can be: "2547xxx@s.whatsapp.net", "2547xxx:12@s.whatsapp.net", or plain "2547xxx"
function cleanJidNumber(jid) {
  if (!jid) return '';
  return jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

async function isGroupAdmin(conn, groupJid, senderJid) {
  try {
    const meta = await conn.groupMetadata(groupJid);
    const senderClean = cleanJidNumber(senderJid);
    for (const p of meta.participants) {
      if (cleanJidNumber(p.id) === senderClean) {
        return p.admin === 'admin' || p.admin === 'superadmin';
      }
    }
    return false;
  } catch { return false; }
}

function normalizeNumber(jid) {
  return jid ? jid.split('@')[0].split(':')[0] : '';
}

module.exports = {
  isPremium, addPremium, delPremium, loadPremium,
  getSessionDir, sessionExists, deleteSession, listSessions,
  loadUserSettings, saveUserSettings, getSessionSetting, setSessionSetting,
  isGroupAdmin, normalizeNumber, cleanJidNumber,
};
