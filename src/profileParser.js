'use strict';

/**
 * Parses proxy share links (vless://, vmess://, trojan://) into a normalized
 * profile object that configBuilder.js can turn into an Xray-core or
 * sing-box configuration.
 */

function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch (e) {
    return str;
  }
}

function parseQuery(qs) {
  const out = {};
  if (!qs) return out;
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    const key = idx === -1 ? pair : pair.slice(0, idx);
    const val = idx === -1 ? '' : pair.slice(idx + 1);
    out[safeDecode(key)] = safeDecode(val.replace(/\+/g, '%20'));
  }
  return out;
}

function parseVless(uri) {
  // vless://uuid@host:port?params#remark
  const withoutScheme = uri.replace(/^vless:\/\//i, '');
  const hashIdx = withoutScheme.indexOf('#');
  const remark = hashIdx !== -1 ? safeDecode(withoutScheme.slice(hashIdx + 1)) : '';
  const beforeHash = hashIdx !== -1 ? withoutScheme.slice(0, hashIdx) : withoutScheme;

  const qIdx = beforeHash.indexOf('?');
  const query = qIdx !== -1 ? parseQuery(beforeHash.slice(qIdx + 1)) : {};
  const userAndHost = qIdx !== -1 ? beforeHash.slice(0, qIdx) : beforeHash;

  const atIdx = userAndHost.lastIndexOf('@');
  if (atIdx === -1) throw new Error('لینک VLESS نامعتبر است: شناسه کاربر یافت نشد');
  const uuid = userAndHost.slice(0, atIdx);
  const hostPort = userAndHost.slice(atIdx + 1);

  // Support IPv6 in brackets: [::1]:443
  let address, port;
  if (hostPort.startsWith('[')) {
    const closeIdx = hostPort.indexOf(']');
    address = hostPort.slice(1, closeIdx);
    port = parseInt(hostPort.slice(closeIdx + 2), 10);
  } else {
    const lastColon = hostPort.lastIndexOf(':');
    address = hostPort.slice(0, lastColon);
    port = parseInt(hostPort.slice(lastColon + 1), 10);
  }

  if (!address || !port) throw new Error('لینک VLESS نامعتبر است: آدرس یا پورت یافت نشد');

  const network = (query.type || 'tcp').toLowerCase(); // tcp | ws | xhttp | grpc | kcp
  const security = (query.security || 'none').toLowerCase(); // none | tls | reality

  const profile = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    protocol: 'vless',
    remark: remark || `${address}:${port}`,
    uuid,
    address,
    port,
    encryption: query.encryption || 'none',
    flow: query.flow || '',
    network,
    security,
    raw: uri
  };

  if (network === 'ws') {
    profile.wsPath = query.path || '/';
    profile.wsHost = query.host || address;
  } else if (network === 'xhttp') {
    profile.xhttpPath = query.path || '/';
    profile.xhttpHost = query.host || address;
    profile.xhttpMode = query.mode || 'auto'; // auto | packet-up | stream-up | stream-one
  } else if (network === 'grpc') {
    profile.grpcServiceName = query.serviceName || query.path || '';
  } else if (network === 'kcp') {
    profile.kcpSeed = query.seed || '';
    profile.kcpHeaderType = query.headerType || 'none';
  } else if (network === 'tcp') {
    profile.tcpHeaderType = query.headerType || 'none'; // none | http (raw vs http-disguise)
  }

  if (security === 'reality') {
    profile.sni = query.sni || address;
    profile.fingerprint = query.fp || 'chrome';
    profile.publicKey = query.pbk || '';
    profile.shortId = query.sid || '';
    profile.spiderX = query.spx || '';
  } else if (security === 'tls') {
    profile.sni = query.sni || (network === 'ws' ? (query.host || address) : address);
    profile.fingerprint = query.fp || 'chrome';
    profile.alpn = query.alpn || '';
    profile.allowInsecure = query.allowInsecure === '1' || query.allowInsecure === 'true';
  }

  return profile;
}

function parseTrojan(uri) {
  const withoutScheme = uri.replace(/^trojan:\/\//i, '');
  const hashIdx = withoutScheme.indexOf('#');
  const remark = hashIdx !== -1 ? safeDecode(withoutScheme.slice(hashIdx + 1)) : '';
  const beforeHash = hashIdx !== -1 ? withoutScheme.slice(0, hashIdx) : withoutScheme;
  const qIdx = beforeHash.indexOf('?');
  const query = qIdx !== -1 ? parseQuery(beforeHash.slice(qIdx + 1)) : {};
  const userAndHost = qIdx !== -1 ? beforeHash.slice(0, qIdx) : beforeHash;
  const atIdx = userAndHost.lastIndexOf('@');
  const password = safeDecode(userAndHost.slice(0, atIdx));
  const hostPort = userAndHost.slice(atIdx + 1);
  const lastColon = hostPort.lastIndexOf(':');
  const address = hostPort.slice(0, lastColon);
  const port = parseInt(hostPort.slice(lastColon + 1), 10);

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    protocol: 'trojan',
    remark: remark || `${address}:${port}`,
    password,
    address,
    port,
    network: (query.type || 'tcp').toLowerCase(),
    security: (query.security || 'tls').toLowerCase(),
    sni: query.sni || address,
    fingerprint: query.fp || 'chrome',
    wsPath: query.path || '/',
    wsHost: query.host || address,
    raw: uri
  };
}

function parseVmess(uri) {
  const b64 = uri.replace(/^vmess:\/\//i, '');
  let json;
  try {
    json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) {
    throw new Error('لینک VMess نامعتبر است (base64 قابل خواندن نیست)');
  }
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    protocol: 'vmess',
    remark: json.ps || `${json.add}:${json.port}`,
    uuid: json.id,
    address: json.add,
    port: parseInt(json.port, 10),
    alterId: parseInt(json.aid || '0', 10),
    security: json.tls === 'tls' ? 'tls' : 'none',
    network: json.net || 'tcp',
    wsPath: json.path || '/',
    wsHost: json.host || json.add,
    sni: json.sni || json.host || json.add,
    raw: uri
  };
}

function parseHysteria2(uri) {
  // hysteria2://auth@host:port/?insecure=1&sni=xxx&obfs=salamander&obfs-password=yyy&pinSHA256=zzz#remark
  const withoutScheme = uri.replace(/^hysteria2:\/\//i, '').replace(/^hy2:\/\//i, '');
  const hashIdx = withoutScheme.indexOf('#');
  const remark = hashIdx !== -1 ? safeDecode(withoutScheme.slice(hashIdx + 1)) : '';
  const beforeHash = hashIdx !== -1 ? withoutScheme.slice(0, hashIdx) : withoutScheme;
  const qIdx = beforeHash.indexOf('?');
  const query = qIdx !== -1 ? parseQuery(beforeHash.slice(qIdx + 1)) : {};
  let userAndHost = qIdx !== -1 ? beforeHash.slice(0, qIdx) : beforeHash;
  userAndHost = userAndHost.replace(/\/$/, '');

  const atIdx = userAndHost.lastIndexOf('@');
  if (atIdx === -1) throw new Error('لینک Hysteria2 نامعتبر است: اطلاعات احراز هویت یافت نشد');
  const auth = safeDecode(userAndHost.slice(0, atIdx));
  const hostPort = userAndHost.slice(atIdx + 1);
  const lastColon = hostPort.lastIndexOf(':');
  const address = hostPort.slice(0, lastColon);
  const port = parseInt(hostPort.slice(lastColon + 1), 10);
  if (!address || !port) throw new Error('لینک Hysteria2 نامعتبر است: آدرس یا پورت یافت نشد');

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    protocol: 'hysteria2',
    remark: remark || `${address}:${port}`,
    password: auth,
    address,
    port,
    network: 'udp',
    security: 'tls',
    sni: query.sni || address,
    allowInsecure: query.insecure === '1' || query.insecure === 'true',
    obfsType: query.obfs || '',
    obfsPassword: query['obfs-password'] || '',
    pinSHA256: query.pinSHA256 || '',
    raw: uri
  };
}

function parseShadowsocks(uri) {
  // SIP002: ss://BASE64(method:password)@host:port#remark
  // legacy:  ss://BASE64(method:password@host:port)#remark
  const withoutScheme = uri.replace(/^ss:\/\//i, '');
  const hashIdx = withoutScheme.indexOf('#');
  const remark = hashIdx !== -1 ? safeDecode(withoutScheme.slice(hashIdx + 1)) : '';
  let beforeHash = hashIdx !== -1 ? withoutScheme.slice(0, hashIdx) : withoutScheme;
  // Strip an optional plugin query string (?plugin=...) — not supported yet, ignored safely.
  const qIdx = beforeHash.indexOf('?');
  if (qIdx !== -1) beforeHash = beforeHash.slice(0, qIdx);

  let method, password, address, port;

  if (beforeHash.includes('@')) {
    // SIP002 form: userinfo (base64 or plain) @ host:port
    const atIdx = beforeHash.lastIndexOf('@');
    let userinfo = beforeHash.slice(0, atIdx);
    const hostPort = beforeHash.slice(atIdx + 1);
    if (!/:/.test(userinfo)) {
      // userinfo is base64-encoded "method:password"
      try {
        userinfo = Buffer.from(userinfo.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      } catch (e) {
        throw new Error('لینک Shadowsocks نامعتبر است: اطلاعات احراز هویت قابل رمزگشایی نیست');
      }
    }
    const sepIdx = userinfo.indexOf(':');
    method = userinfo.slice(0, sepIdx);
    password = userinfo.slice(sepIdx + 1);
    const lastColon = hostPort.lastIndexOf(':');
    address = hostPort.slice(0, lastColon);
    port = parseInt(hostPort.slice(lastColon + 1), 10);
  } else {
    // Legacy form: the whole method:password@host:port is base64-encoded
    let decoded;
    try {
      decoded = Buffer.from(beforeHash.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    } catch (e) {
      throw new Error('لینک Shadowsocks نامعتبر است');
    }
    const atIdx = decoded.lastIndexOf('@');
    const userinfo = decoded.slice(0, atIdx);
    const hostPort = decoded.slice(atIdx + 1);
    const sepIdx = userinfo.indexOf(':');
    method = userinfo.slice(0, sepIdx);
    password = userinfo.slice(sepIdx + 1);
    const lastColon = hostPort.lastIndexOf(':');
    address = hostPort.slice(0, lastColon);
    port = parseInt(hostPort.slice(lastColon + 1), 10);
  }

  if (!address || !port || !method || password === undefined) {
    throw new Error('لینک Shadowsocks نامعتبر است: اطلاعات ناقص است');
  }

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    protocol: 'shadowsocks',
    remark: remark || `${address}:${port}`,
    method,
    password,
    address,
    port,
    network: 'tcp',
    security: 'none',
    raw: uri
  };
}

function parseTuic(uri) {
  // tuic://uuid:password@host:port?congestion_control=bbr&alpn=h3&sni=xxx&allow_insecure=1#remark
  const withoutScheme = uri.replace(/^tuic:\/\//i, '');
  const hashIdx = withoutScheme.indexOf('#');
  const remark = hashIdx !== -1 ? safeDecode(withoutScheme.slice(hashIdx + 1)) : '';
  const beforeHash = hashIdx !== -1 ? withoutScheme.slice(0, hashIdx) : withoutScheme;
  const qIdx = beforeHash.indexOf('?');
  const query = qIdx !== -1 ? parseQuery(beforeHash.slice(qIdx + 1)) : {};
  const userAndHost = qIdx !== -1 ? beforeHash.slice(0, qIdx) : beforeHash;

  const atIdx = userAndHost.lastIndexOf('@');
  if (atIdx === -1) throw new Error('لینک TUIC نامعتبر است: اطلاعات احراز هویت یافت نشد');
  const userinfo = safeDecode(userAndHost.slice(0, atIdx));
  const sepIdx = userinfo.indexOf(':');
  const uuid = sepIdx !== -1 ? userinfo.slice(0, sepIdx) : userinfo;
  const password = sepIdx !== -1 ? userinfo.slice(sepIdx + 1) : '';

  const hostPort = userAndHost.slice(atIdx + 1);
  const lastColon = hostPort.lastIndexOf(':');
  const address = hostPort.slice(0, lastColon);
  const port = parseInt(hostPort.slice(lastColon + 1), 10);
  if (!address || !port) throw new Error('لینک TUIC نامعتبر است: آدرس یا پورت یافت نشد');

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    protocol: 'tuic',
    remark: remark || `${address}:${port}`,
    uuid,
    password,
    address,
    port,
    network: 'udp',
    security: 'tls',
    sni: query.sni || address,
    allowInsecure: query.allow_insecure === '1' || query.allow_insecure === 'true',
    congestionControl: query.congestion_control || 'bbr',
    alpn: query.alpn || 'h3',
    udpRelayMode: query.udp_relay_mode || 'native',
    raw: uri
  };
}

/**
 * Parses a standard wg-quick style WireGuard .conf file (INI sections
 * [Interface] / [Peer]) into a normalized profile. WireGuard has no widely
 * adopted share-link URI scheme like vless://, so this is a separate
 * paste-the-config import path rather than parseUri().
 */
function parseWireGuardConf(text, remark) {
  const lines = text.split(/\r?\n/);
  let section = null;
  const iface = {};
  const peer = {};

  for (let rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[(\w+)\]$/i);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (section === 'interface') iface[key] = value;
    else if (section === 'peer') peer[key] = value;
  }

  if (!iface.PrivateKey) throw new Error('فایل WireGuard نامعتبر است: PrivateKey در بخش [Interface] یافت نشد');
  if (!peer.PublicKey) throw new Error('فایل WireGuard نامعتبر است: PublicKey در بخش [Peer] یافت نشد');
  if (!peer.Endpoint) throw new Error('فایل WireGuard نامعتبر است: Endpoint در بخش [Peer] یافت نشد');

  const lastColon = peer.Endpoint.lastIndexOf(':');
  const address = peer.Endpoint.slice(0, lastColon).replace(/^\[|\]$/g, '');
  const port = parseInt(peer.Endpoint.slice(lastColon + 1), 10);
  if (!address || !port) throw new Error('فایل WireGuard نامعتبر است: Endpoint قابل تفکیک نیست');

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    protocol: 'wireguard',
    remark: remark || `${address}:${port}`,
    address,
    port,
    privateKey: iface.PrivateKey,
    localAddress: iface.Address ? iface.Address.split(',').map((s) => s.trim()) : ['10.0.0.2/32'],
    dns: iface.DNS ? iface.DNS.split(',').map((s) => s.trim()) : [],
    mtu: iface.MTU ? parseInt(iface.MTU, 10) : 1408,
    peerPublicKey: peer.PublicKey,
    presharedKey: peer.PresharedKey || '',
    allowedIPs: peer.AllowedIPs ? peer.AllowedIPs.split(',').map((s) => s.trim()) : ['0.0.0.0/0'],
    raw: text
  };
}

function parseUri(uri) {
  const trimmed = uri.trim();
  if (/^vless:\/\//i.test(trimmed)) return parseVless(trimmed);
  if (/^trojan:\/\//i.test(trimmed)) return parseTrojan(trimmed);
  if (/^vmess:\/\//i.test(trimmed)) return parseVmess(trimmed);
  if (/^(hysteria2|hy2):\/\//i.test(trimmed)) return parseHysteria2(trimmed);
  if (/^ss:\/\//i.test(trimmed)) return parseShadowsocks(trimmed);
  if (/^tuic:\/\//i.test(trimmed)) return parseTuic(trimmed);
  throw new Error('پروتکل پشتیبانی نمی‌شود. لینک باید با vless://‎, trojan://‎, vmess://‎, ss://‎, tuic://‎ یا hysteria2://‎ شروع شود.');
}

/** Parses a block of text that may contain multiple links, one per line. */
function parseBulk(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const profiles = [];
  const errors = [];
  for (const line of lines) {
    try {
      profiles.push(parseUri(line));
    } catch (e) {
      errors.push({ line, error: e.message });
    }
  }
  return { profiles, errors };
}

module.exports = { parseUri, parseBulk, parseWireGuardConf };
