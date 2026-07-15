'use strict';

const { spawn } = require('child_process');

/**
 * Finds the largest ICMP payload size that travels to `target` without
 * fragmentation (ping -f -l <size>), then derives the path MTU from it
 * (payload + 28 bytes of IPv4+ICMP headers). This is the same technique
 * used by network engineers manually running "ping -f -l N" on Windows.
 *
 * Only meaningful on Windows (uses ping.exe's -f/-l flags); on other
 * platforms this resolves with an explanatory failure.
 */
function pingOnce(target, size, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return resolve({ ok: false, reason: 'unsupported-platform' });
    }
    const proc = spawn('ping', ['-n', '1', '-w', String(timeoutMs), '-f', '-l', String(size), target], {
      windowsHide: true
    });
    let output = '';
    proc.stdout.on('data', (d) => (output += d.toString()));
    proc.stderr.on('data', (d) => (output += d.toString()));
    proc.on('close', () => {
      const lower = output.toLowerCase();
      if (lower.includes('reply from') && !lower.includes('needs to be fragmented')) {
        resolve({ ok: true });
      } else if (lower.includes('needs to be fragmented')) {
        resolve({ ok: false, reason: 'fragmentation-needed' });
      } else {
        // Timeout / unreachable / ICMP blocked by a firewall — inconclusive.
        resolve({ ok: false, reason: 'no-reply' });
      }
    });
    proc.on('error', () => resolve({ ok: false, reason: 'ping-unavailable' }));
  });
}

/**
 * Binary-searches the payload size between `lo` and `hi` for the largest
 * size that still gets an unfragmented reply. Calls onProgress(size) so the
 * UI can show live feedback while the search runs.
 */
/**
 * Binary-searches the payload size between `lo` and `hi` for the largest
 * size that still gets an unfragmented reply. Calls onProgress(size) so the
 * UI can show live feedback while the search runs. `prober` is injectable
 * for testing; defaults to the real pingOnce().
 */
async function findOptimalMtuWith(prober, lo, hi, onProgress) {
  let bestKnownGood = null;
  let inconclusive = 0;

  if (onProgress) onProgress(lo);
  const baseline = await prober(lo);
  if (!baseline.ok) {
    return {
      ok: false,
      error:
        baseline.reason === 'no-reply'
          ? 'سرور به پینگ ICMP پاسخ نمی‌دهد (احتمالاً فایروال مسدود کرده)؛ از مقدار پیش‌فرض ۱۴۲۰ استفاده کنید.'
          : 'تشخیص خودکار MTU ممکن نشد.'
    };
  }
  bestKnownGood = lo;

  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (onProgress) onProgress(mid);
    const res = await prober(mid);
    if (res.ok) {
      bestKnownGood = mid;
      lo = mid;
    } else if (res.reason === 'fragmentation-needed') {
      hi = mid;
    } else {
      inconclusive += 1;
      if (inconclusive > 6) break;
      hi = mid;
    }
  }

  const mtu = bestKnownGood + 28;
  return { ok: true, mtu, payload: bestKnownGood };
}

async function findOptimalMtu(target, onProgress) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'تشخیص خودکار MTU فقط روی ویندوز پشتیبانی می‌شود' };
  }
  const prober = (size) => pingOnce(target, size);
  return findOptimalMtuWith(prober, 1000, 1472, onProgress);
}

module.exports = { findOptimalMtu, findOptimalMtuWith, pingOnce };
