'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

/**
 * Downloads a URL to destPath, following up to 5 redirects (GitHub release
 * "latest/download" links redirect twice before reaching the actual asset).
 * No external dependencies — plain Node https.
 */
function downloadFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'SignalRay-App' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('تعداد ریدایرکت‌ها بیش از حد مجاز بود'));
        return resolve(downloadFile(res.headers.location, destPath, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`دانلود ناموفق بود (کد HTTP ${res.statusCode})`));
      }

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const tmpPath = `${destPath}.download`;
      const fileStream = fs.createWriteStream(tmpPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close((err) => {
          if (err) return reject(err);
          fs.renameSync(tmpPath, destPath);
          resolve(destPath);
        });
      });
      fileStream.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(30000, () => {
      request.destroy(new Error('زمان دانلود به پایان رسید (timeout)'));
    });
  });
}

const SOURCES = {
  xrayGeoip: 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat',
  xrayGeosite: 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat',
  singboxGeoipIr: 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-ir.srs'
};

/**
 * Downloads whichever geo files are relevant to the active core into
 * userDataDir/geo/, updating settings paths only for files that succeeded.
 * Returns { updatedPaths, errors }.
 */
async function updateGeoFiles(userDataDir, activeCore) {
  const geoDir = path.join(userDataDir, 'geo');
  const updatedPaths = {};
  const errors = [];

  if (activeCore === 'singbox') {
    try {
      const dest = path.join(geoDir, 'geoip-ir.srs');
      await downloadFile(SOURCES.singboxGeoipIr, dest);
      updatedPaths.singboxGeoipIrPath = dest;
    } catch (e) {
      errors.push(`geoip-ir.srs (sing-box): ${e.message}`);
    }
  } else {
    try {
      const dest = path.join(geoDir, 'geoip.dat');
      await downloadFile(SOURCES.xrayGeoip, dest);
      updatedPaths.geoipDatPath = dest;
    } catch (e) {
      errors.push(`geoip.dat (Xray): ${e.message}`);
    }
    try {
      const dest = path.join(geoDir, 'geosite.dat');
      await downloadFile(SOURCES.xrayGeosite, dest);
      updatedPaths.geositeDatPath = dest;
    } catch (e) {
      errors.push(`geosite.dat (Xray): ${e.message}`);
    }
  }

  return { updatedPaths, errors };
}

module.exports = { downloadFile, updateGeoFiles, SOURCES };
