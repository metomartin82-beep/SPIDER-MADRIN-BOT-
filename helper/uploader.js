/*
 * Alexa — WhatsApp Multi-Session Bot
 */


const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/**
 * Download a file from URL to a local temp path
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, res => {
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Read a local file as buffer
 */
function readFileBuffer(filePath) {
  return fs.readFileSync(filePath);
}

/**
 * Get file extension from URL or filename
 */
function getExtension(filename) {
  return path.extname(filename).replace('.', '') || 'bin';
}

module.exports = { downloadFile, readFileBuffer, getExtension };
