/*
 * Site control helper — talks to the ScottyHub API using an API key
 * generated from Settings → API Keys on the site itself.
 *
 * Configure in .env:
 *   SITE_API_URL=https://scottyhub.onrender.com/api
 *   SITE_API_KEY=sh_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *
 * The key must belong to an admin account on the site — the /api/admin/*
 * routes require role = 'admin' in addition to a valid key.
 */
const axios = require('axios');
const settings = require('../settings');

const site = axios.create({
  baseURL: settings.SITE_API_URL,
  timeout: 15000,
  headers: settings.SITE_API_KEY ? { 'X-API-Key': settings.SITE_API_KEY } : {},
});

// Small wrapper so command handlers get a consistent { ok, data, error } shape
// instead of having to try/catch axios errors everywhere.
async function siteRequest(method, path, body) {
  if (!settings.SITE_API_KEY) {
    return { ok: false, error: 'SITE_API_KEY is not set in .env — add it, then restart the bot.' };
  }
  try {
    const res = await site.request({ method, url: path, data: body });
    return { ok: true, data: res.data };
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'Request failed';
    return { ok: false, error: msg, status: err.response?.status };
  }
}

module.exports = { site, siteRequest };
