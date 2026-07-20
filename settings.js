/*
 * Alexa — WhatsApp Multi-Session Bot
 */

require('dotenv').config();

module.exports = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || '',
  OWNER_ID: parseInt(process.env.OWNER_ID) || 0,
  BOT_NAME: process.env.BOT_NAME || 'Alexa',
  DEFAULT_PREFIX: process.env.PREFIX || '.',
  SESSIONS_DIR: './sessions',
  PREMIUM_DB: './database/premium.json',
  MENU_IMAGE: process.env.MENU_IMAGE || '',
  REPORT_CHAT: parseInt(process.env.REPORT_CHAT) || parseInt(process.env.OWNER_ID) || 0,
  OWNER_HANDLE: process.env.OWNER_HANDLE || '',
  CHANNEL_LINK: process.env.CHANNEL_LINK || '',
  GROUP_LINK: process.env.GROUP_LINK || '',
  SITE_API_URL: process.env.SITE_API_URL || 'https://scottyhub.onrender.com/api',
  SITE_API_KEY: process.env.SITE_API_KEY || '',
  WEB_PORT: parseInt(process.env.WEB_PORT) || 3000,
  WEB_PAIR_CODE: process.env.WEB_PAIR_CODE || '',
};
