'use strict';

const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * Points the OS's own DNS resolution at SignalRay's local DNS listener
 * (127.0.0.1:53, see configBuilder's dns-in inbound), so DNS traffic from
 * the OS resolver and non-proxy-aware apps — which never passes through
 * the SOCKS/HTTP inbound and so can't be caught by routing rules alone —
 * is forced into the tunnel too. Reverted automatically on disconnect.
 */

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let stderr = '';
    ps.stderr.on('data', (d) => (stderr += d.toString()));
    ps.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `powershell exited with code ${code}`))));
    ps.on('error', reject);
  });
}

async function enableWindows() {
  await runPowerShell(
    `Get-DnsClientServerAddress -AddressFamily IPv4 | ` +
      `Where-Object { (Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue).Status -eq 'Up' } | ` +
      `ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ServerAddresses '127.0.0.1' }`
  );
}

async function disableWindows() {
  await runPowerShell(
    `Get-NetAdapter | Where-Object Status -eq 'Up' | ` +
      `ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses }`
  );
}

async function macActiveNetworkServices() {
  const { stdout } = await execAsync('networksetup -listallnetworkservices');
  return stdout.split('\n').slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith('*'));
}

async function enableMac() {
  const services = await macActiveNetworkServices();
  for (const svc of services) await execAsync(`networksetup -setdnsservers "${svc}" 127.0.0.1`);
}

async function disableMac() {
  const services = await macActiveNetworkServices();
  for (const svc of services) await execAsync(`networksetup -setdnsservers "${svc}" Empty`);
}

async function enableLinux() {
  // Only takes effect where systemd-resolved is in use; on other setups
  // (plain resolv.conf, NetworkManager without resolved) this fails
  // gracefully and the local dns-in listener still helps proxy-aware apps.
  const { stdout } = await execAsync('resolvectl dns 2>/dev/null || true');
  const iface = (stdout.match(/^Link \d+ \((\S+)\)/m) || [])[1] || 'eth0';
  await execAsync(`resolvectl dns ${iface} 127.0.0.1`);
  await execAsync(`resolvectl domain ${iface} '~.'`);
}

async function disableLinux() {
  const { stdout } = await execAsync('resolvectl dns 2>/dev/null || true');
  const iface = (stdout.match(/^Link \d+ \((\S+)\)/m) || [])[1] || 'eth0';
  await execAsync(`resolvectl revert ${iface}`).catch(() => {});
}

async function enableSystemDns() {
  if (process.platform === 'win32') return enableWindows();
  if (process.platform === 'darwin') return enableMac();
  if (process.platform === 'linux') return enableLinux();
  throw new Error('تنظیم DNS سیستم روی این سیستم‌عامل پشتیبانی نمی‌شود');
}

async function disableSystemDns() {
  if (process.platform === 'win32') return disableWindows();
  if (process.platform === 'darwin') return disableMac();
  if (process.platform === 'linux') return disableLinux();
  throw new Error('تنظیم DNS سیستم روی این سیستم‌عامل پشتیبانی نمی‌شود');
}

module.exports = { enableSystemDns, disableSystemDns };
