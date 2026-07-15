'use strict';

const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * Toggles the OS-wide HTTP/HTTPS system proxy so ordinary apps (browsers,
 * etc.) route through SignalRay's local HTTP inbound automatically —
 * without the user manually configuring proxy settings elsewhere.
 *
 * Windows: writes the standard registry keys under
 *   HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
 * and calls InternetSetOption via a small inline PowerShell/C# snippet so
 * Windows picks up the change immediately — the same mechanism v2rayN /
 * NekoBox use.
 *
 * Linux (GNOME/GTK desktops): uses `gsettings org.gnome.system.proxy`.
 * Only takes effect on GNOME-based environments (GNOME, Cinnamon, Unity,
 * many others that read the same gsettings schema); KDE/XFCE and other
 * desktops don't read this key and would need their own mechanism, so on
 * those the call fails gracefully and the app just continues without
 * system-wide proxying (SOCKS/HTTP inbound still works for apps you point
 * at 127.0.0.1 manually).
 *
 * macOS: uses `networksetup -setwebproxy/-setsecurewebproxy` against every
 * active network service (Wi-Fi, Ethernet, etc.), which is the standard
 * approach used by GUI proxy managers on macOS.
 */

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true
    });
    let stderr = '';
    ps.stderr.on('data', (d) => (stderr += d.toString()));
    ps.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `powershell exited with code ${code}`));
    });
    ps.on('error', reject);
  });
}

const REFRESH_SNIPPET = `
Add-Type -MemberDefinition @'
[DllImport("wininet.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
'@ -Namespace Win32 -Name NetOptions
[Win32.NetOptions]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
[Win32.NetOptions]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
`;

async function enableWindows(httpPort) {
  const proxyServer = `127.0.0.1:${httpPort}`;
  const script = `
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
Set-ItemProperty -Path $path -Name ProxyEnable -Value 1
Set-ItemProperty -Path $path -Name ProxyServer -Value '${proxyServer}'
Set-ItemProperty -Path $path -Name ProxyOverride -Value '<local>'
${REFRESH_SNIPPET}
`;
  await runPowerShell(script);
}

async function disableWindows() {
  const script = `
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
Set-ItemProperty -Path $path -Name ProxyEnable -Value 0
${REFRESH_SNIPPET}
`;
  await runPowerShell(script);
}

async function enableLinuxGnome(httpPort) {
  const cmds = [
    `gsettings set org.gnome.system.proxy mode 'manual'`,
    `gsettings set org.gnome.system.proxy.http host '127.0.0.1'`,
    `gsettings set org.gnome.system.proxy.http port ${httpPort}`,
    `gsettings set org.gnome.system.proxy.https host '127.0.0.1'`,
    `gsettings set org.gnome.system.proxy.https port ${httpPort}`
  ];
  for (const cmd of cmds) await execAsync(cmd);

  // gsettings can exit 0 even when the write didn't actually persist (e.g.
  // no D-Bus/dconf session available, common in minimal/headless setups) —
  // read the value back so a silent failure surfaces as a real error.
  const { stdout: modeOut } = await execAsync('gsettings get org.gnome.system.proxy mode');
  const { stdout: portOut } = await execAsync('gsettings get org.gnome.system.proxy.http port');
  if (!modeOut.includes('manual') || portOut.trim() !== String(httpPort)) {
    throw new Error(
      'تنظیم پروکسی روی این محیط دسکتاپ اعمال نشد (احتمالاً محیطی غیر از GNOME دارید یا نشست dconf در دسترس نیست). می‌توانید به‌جای آن، پروکسی HTTP/SOCKS را دستی در تنظیمات شبکهٔ سیستم روی 127.0.0.1 تنظیم کنید.'
    );
  }
}

async function disableLinuxGnome() {
  await execAsync(`gsettings set org.gnome.system.proxy mode 'none'`);
}

async function macActiveNetworkServices() {
  const { stdout } = await execAsync('networksetup -listallnetworkservices');
  return stdout
    .split('\n')
    .slice(1) // first line is a header/instructions line
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*')); // '*' prefix marks a disabled service
}

async function enableMac(httpPort) {
  const services = await macActiveNetworkServices();
  if (!services.length) throw new Error('هیچ سرویس شبکه‌ای برای تنظیم پروکسی پیدا نشد');
  for (const svc of services) {
    await execAsync(`networksetup -setwebproxy "${svc}" 127.0.0.1 ${httpPort}`);
    await execAsync(`networksetup -setsecurewebproxy "${svc}" 127.0.0.1 ${httpPort}`);
    await execAsync(`networksetup -setwebproxystate "${svc}" on`);
    await execAsync(`networksetup -setsecurewebproxystate "${svc}" on`);
  }
}

async function disableMac() {
  const services = await macActiveNetworkServices();
  for (const svc of services) {
    await execAsync(`networksetup -setwebproxystate "${svc}" off`);
    await execAsync(`networksetup -setsecurewebproxystate "${svc}" off`);
  }
}

async function enableSystemProxy(httpPort) {
  if (process.platform === 'win32') return enableWindows(httpPort);
  if (process.platform === 'darwin') return enableMac(httpPort);
  if (process.platform === 'linux') return enableLinuxGnome(httpPort);
  throw new Error('تنظیم پروکسی سیستم روی این سیستم‌عامل پشتیبانی نمی‌شود');
}

async function disableSystemProxy() {
  if (process.platform === 'win32') return disableWindows();
  if (process.platform === 'darwin') return disableMac();
  if (process.platform === 'linux') return disableLinuxGnome();
  throw new Error('تنظیم پروکسی سیستم روی این سیستم‌عامل پشتیبانی نمی‌شود');
}

module.exports = { enableSystemProxy, disableSystemProxy };
