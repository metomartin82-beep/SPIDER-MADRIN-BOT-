/*
 * Alexa — WhatsApp Multi-Session Bot
 */

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${d}d ${h}h ${m}m ${sec}s`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function cleanNumber(raw) { return raw.replace(/[^0-9]/g, ''); }
function toJid(number) { return `${cleanNumber(number)}@s.whatsapp.net`; }
function fromJid(jid) { return jid ? jid.split('@')[0].split(':')[0] : ''; }
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
// Speed test: measure ms for a simple op
function measureSpeed() {
  const start = Date.now();
  let x = 0;
  for (let i = 0; i < 1e5; i++) x += i;
  return Date.now() - start;
}
module.exports = { formatUptime, sleep, cleanNumber, toJid, fromJid, chunk, measureSpeed };
