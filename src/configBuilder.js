'use strict';

/**
 * Builds a full Xray-core or sing-box JSON configuration from a normalized
 * profile (see profileParser.js) plus user-defined local listener settings.
 */

function buildXrayStreamSettings(profile, settings) {
  const defaultFp = (settings && settings.defaultFingerprint) || 'chrome';
  const stream = { network: profile.network === 'tcp' ? 'tcp' : profile.network };

  if (profile.network === 'tcp') {
    stream.network = 'tcp';
    if (profile.tcpHeaderType === 'http') {
      stream.tcpSettings = { header: { type: 'http' } };
    } else {
      stream.tcpSettings = { header: { type: 'none' } };
    }
  } else if (profile.network === 'ws') {
    stream.network = 'ws';
    stream.wsSettings = {
      path: profile.wsPath || '/',
      headers: profile.wsHost ? { Host: profile.wsHost } : {}
    };
  } else if (profile.network === 'xhttp') {
    stream.network = 'xhttp';
    stream.xhttpSettings = {
      path: profile.xhttpPath || '/',
      host: profile.xhttpHost || profile.address,
      mode: profile.xhttpMode || 'auto'
    };
  } else if (profile.network === 'grpc') {
    stream.network = 'grpc';
    stream.grpcSettings = { serviceName: profile.grpcServiceName || '' };
  } else if (profile.network === 'kcp') {
    stream.network = 'kcp';
    stream.kcpSettings = {
      header: { type: profile.kcpHeaderType || 'none' },
      seed: profile.kcpSeed || ''
    };
  }

  if (profile.security === 'reality') {
    stream.security = 'reality';
    stream.realitySettings = {
      serverName: profile.sni,
      fingerprint: profile.fingerprint || defaultFp,
      publicKey: profile.publicKey,
      shortId: profile.shortId || '',
      spiderX: profile.spiderX || ''
    };
  } else if (profile.security === 'tls') {
    stream.security = 'tls';
    stream.tlsSettings = {
      serverName: profile.sni,
      fingerprint: profile.fingerprint || defaultFp,
      allowInsecure: !!profile.allowInsecure,
      alpn: profile.alpn ? profile.alpn.split(',') : undefined
    };
  } else {
    stream.security = 'none';
  }

  return stream;
}

function buildXrayOutbound(profile, settings) {
  const sockopt = {};
  let hasSockopt = false;

  if (settings && settings.enableFragment && (profile.security === 'reality' || profile.security === 'tls')) {
    sockopt.fragment = { packets: 'tlshello', length: '10-30', interval: '10-20' };
    hasSockopt = true;
  }
  if (settings && settings.enableTcpFastOpen) {
    sockopt.tcpFastOpen = true;
    hasSockopt = true;
  }
  if (settings && settings.mtu && Number(settings.mtu) > 0) {
    // Clamp TCP segment size to (MTU - 40 bytes IPv4/TCP header overhead) so
    // packets don't get fragmented mid-path — the practical effect of "MTU
    // tuning" for a TCP-based proxy outbound (Xray has no literal MTU knob).
    sockopt.tcpMaxSeg = Math.max(536, Number(settings.mtu) - 40);
    hasSockopt = true;
  }

  const extras = { sockopt: hasSockopt ? sockopt : undefined };
  if (settings && settings.enableMux) {
    extras.mux = { enabled: true, concurrency: settings.muxConcurrency || 8 };
  }

  if (profile.protocol === 'vless') {
    return {
      protocol: 'vless',
      tag: 'proxy',
      settings: {
        vnext: [
          {
            address: profile.address,
            port: profile.port,
            users: [
              {
                id: profile.uuid,
                encryption: profile.encryption || 'none',
                flow: profile.flow || undefined
              }
            ]
          }
        ]
      },
      streamSettings: { ...buildXrayStreamSettings(profile, settings), sockopt: extras.sockopt },
      mux: extras.mux
    };
  }

  if (profile.protocol === 'trojan') {
    return {
      protocol: 'trojan',
      tag: 'proxy',
      settings: {
        servers: [{ address: profile.address, port: profile.port, password: profile.password }]
      },
      streamSettings: { ...buildXrayStreamSettings(profile, settings), sockopt: extras.sockopt },
      mux: extras.mux
    };
  }

  if (profile.protocol === 'vmess') {
    return {
      protocol: 'vmess',
      tag: 'proxy',
      settings: {
        vnext: [
          {
            address: profile.address,
            port: profile.port,
            users: [{ id: profile.uuid, alterId: profile.alterId || 0, security: 'auto' }]
          }
        ]
      },
      streamSettings: { ...buildXrayStreamSettings(profile, settings), sockopt: extras.sockopt },
      mux: extras.mux
    };
  }

  if (profile.protocol === 'shadowsocks') {
    return {
      protocol: 'shadowsocks',
      tag: 'proxy',
      settings: {
        servers: [{ address: profile.address, port: profile.port, method: profile.method, password: profile.password }]
      },
      streamSettings: { network: 'tcp', sockopt: extras.sockopt },
      mux: extras.mux
    };
  }

  throw new Error(`پروتکل ${profile.protocol} توسط این سازنده کانفیگ پشتیبانی نمی‌شود`);
}

function buildXrayConfig(profile, settings) {
  const socksPort = settings.socksPort || 10808;
  const httpPort = settings.httpPort || 10809;
  const statsApiPort = settings.statsApiPort || 18888;
  const dnsServers = parseDnsList(settings.dnsServers);

  return {
    log: { loglevel: settings.logLevel || 'warning' },
    dns: dnsServers.length ? { servers: dnsServers } : undefined,
    stats: {},
    api: { tag: 'api', listen: `127.0.0.1:${statsApiPort}`, services: ['StatsService'] },
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsOutboundUplink: true, statsOutboundDownlink: true }
    },
    inbounds: [
      {
        tag: 'socks-in',
        port: socksPort,
        listen: '127.0.0.1',
        protocol: 'socks',
        settings: { auth: 'noauth', udp: true },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] }
      },
      {
        tag: 'http-in',
        port: httpPort,
        listen: '127.0.0.1',
        protocol: 'http',
        settings: {},
        sniffing: { enabled: true, destOverride: ['http', 'tls'] }
      },
      // Raw local DNS listener: lets the OS resolver itself (and any app
      // that doesn't honor the system SOCKS/HTTP proxy) be pointed at
      // 127.0.0.1:53 (see systemDns.js), so its plain UDP/TCP:53 queries
      // are caught here and forwarded through the tunnel below — instead
      // of leaking out the network adapter directly.
      ...(settings.dnsThroughTunnel !== false && dnsServers.length
        ? [
            {
              tag: 'dns-in',
              port: 53,
              listen: '127.0.0.1',
              protocol: 'dokodemo-door',
              settings: { address: dnsServers[0], port: 53, network: 'udp,tcp' }
            }
          ]
        : [])
    ],
    outbounds: [
      buildXrayOutbound(profile, settings),
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' },
      ...(settings.dnsThroughTunnel !== false && dnsServers.length ? [{ protocol: 'dns', tag: 'dns-out' }] : [])
    ],
    routing: {
      domainStrategy: settings.domainStrategy || 'IPIfNonMatch',
      rules: [
        ...(settings.bypassLAN
          ? [
              {
                type: 'field',
                ip: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', 'fc00::/7', 'fe80::/10'],
                outboundTag: 'direct'
              }
            ]
          : []),
        // Answered by Xray's own internal DNS resolver (cached per TTL, see
        // the top-level "dns" object above) instead of blindly re-forwarding
        // every raw packet through the tunnel — repeat lookups for the same
        // domain come back instantly from cache rather than paying the
        // Iran→Turkey→upstream round-trip every single time.
        ...(settings.dnsThroughTunnel !== false && dnsServers.length ? [{ type: 'field', inboundTag: ['dns-in'], outboundTag: 'dns-out' }] : []),
        // Force DNS lookups (UDP/TCP port 53) through the proxy tunnel so the
        // query itself travels as ordinary encrypted proxy traffic instead of
        // a plainly-identifiable/blockable DNS packet leaving the ISP directly.
        // Placed after the LAN bypass (so local network DNS still resolves
        // directly) but before the Iran geoip bypass, so it takes priority.
        ...(settings.dnsThroughTunnel !== false ? [{ type: 'field', port: '53', network: 'udp,tcp', outboundTag: 'proxy' }] : []),
        ...(settings.bypassIran && settings.geoipAvailable ? [{ type: 'field', ip: ['geoip:ir'], outboundTag: 'direct' }] : [])
      ]
    }
  };
}

function buildSingboxOutbound(profile, settings) {
  const base = { tag: 'proxy' };
  const defaultFp = (settings && settings.defaultFingerprint) || 'chrome';

  const tls = (() => {
    if (profile.security === 'reality') {
      const t = {
        enabled: true,
        server_name: profile.sni,
        utls: { enabled: true, fingerprint: profile.fingerprint || defaultFp },
        reality: { enabled: true, public_key: profile.publicKey, short_id: profile.shortId || '' }
      };
      if (settings && settings.enableFragment) t.fragment = true;
      return t;
    }
    if (profile.security === 'tls') {
      const t = {
        enabled: true,
        server_name: profile.sni,
        insecure: !!profile.allowInsecure,
        utls: { enabled: true, fingerprint: profile.fingerprint || defaultFp },
        alpn: profile.alpn ? profile.alpn.split(',') : undefined
      };
      if (settings && settings.enableFragment) t.fragment = true;
      return t;
    }
    return undefined;
  })();

  const transport = (() => {
    if (profile.network === 'ws') {
      return { type: 'ws', path: profile.wsPath || '/', headers: profile.wsHost ? { Host: profile.wsHost } : {} };
    }
    if (profile.network === 'xhttp') {
      return { type: 'httpupgrade', path: profile.xhttpPath || '/', host: profile.xhttpHost || profile.address };
    }
    if (profile.network === 'grpc') {
      return { type: 'grpc', service_name: profile.grpcServiceName || '' };
    }
    return undefined; // tcp / raw
  })();

  // sing-box (unlike Xray) hard-rejects a VLESS config where XTLS flow is
  // combined with multiplex, or with anything other than raw TCP transport.
  // Drop whichever is invalid instead of producing a config sing-box refuses
  // to start at all.
  const isVisionFlow = profile.protocol === 'vless' && profile.flow === 'xtls-rprx-vision';
  const flow = isVisionFlow && !transport ? profile.flow : undefined;
  const multiplex = settings && settings.enableMux && !isVisionFlow
    ? { enabled: true, protocol: 'smux', max_connections: settings.muxConcurrency || 8 }
    : undefined;
  const tcpFastOpen = settings && settings.enableTcpFastOpen ? true : undefined;

  if (profile.protocol === 'vless') {
    return {
      ...base,
      type: 'vless',
      server: profile.address,
      server_port: profile.port,
      uuid: profile.uuid,
      flow,
      tcp_fast_open: tcpFastOpen,
      tls,
      transport,
      multiplex
    };
  }

  if (profile.protocol === 'trojan') {
    return {
      ...base,
      type: 'trojan',
      server: profile.address,
      server_port: profile.port,
      password: profile.password,
      tcp_fast_open: tcpFastOpen,
      tls,
      transport,
      multiplex
    };
  }

  if (profile.protocol === 'vmess') {
    return {
      ...base,
      type: 'vmess',
      server: profile.address,
      server_port: profile.port,
      uuid: profile.uuid,
      alter_id: profile.alterId || 0,
      security: 'auto',
      tcp_fast_open: tcpFastOpen,
      tls,
      transport,
      multiplex
    };
  }

  if (profile.protocol === 'hysteria2') {
    return {
      ...base,
      type: 'hysteria2',
      server: profile.address,
      server_port: profile.port,
      password: profile.password,
      tls: {
        enabled: true,
        server_name: profile.sni,
        insecure: !!profile.allowInsecure
      },
      obfs: profile.obfsType
        ? { type: profile.obfsType, password: profile.obfsPassword || '' }
        : undefined
    };
  }

  if (profile.protocol === 'shadowsocks') {
    return {
      ...base,
      type: 'shadowsocks',
      server: profile.address,
      server_port: profile.port,
      method: profile.method,
      password: profile.password,
      multiplex
    };
  }

  if (profile.protocol === 'tuic') {
    return {
      ...base,
      type: 'tuic',
      server: profile.address,
      server_port: profile.port,
      uuid: profile.uuid,
      password: profile.password,
      congestion_control: profile.congestionControl || 'bbr',
      udp_relay_mode: profile.udpRelayMode || 'native',
      tls: {
        enabled: true,
        server_name: profile.sni,
        insecure: !!profile.allowInsecure,
        alpn: profile.alpn ? [profile.alpn] : ['h3']
      }
    };
  }

  if (profile.protocol === 'wireguard') {
    // Should be unreachable in practice — buildSingboxConfig() special-cases
    // WireGuard before ever calling this function, since it needs its own
    // top-level `endpoints[]` section, not a normal outbound.
    throw new Error('WireGuard در sing-box به‌عنوان outbound ساخته نمی‌شود؛ این مسیر کد نباید فراخوانی شود');
  }

  throw new Error(`پروتکل ${profile.protocol} توسط این سازنده کانفیگ پشتیبانی نمی‌شود`);
}

/**
 * WireGuard is NOT a regular outbound in sing-box 1.11+ — it moved to a
 * top-level `endpoints[]` section entirely (and the old outbound-style
 * config was removed completely in 1.13.0). This builds that endpoint.
 */
function buildSingboxWireguardEndpoint(profile) {
  return {
    type: 'wireguard',
    tag: 'wg-endpoint',
    system: false, // userspace (gVisor) stack — no admin/root privileges required
    address: profile.localAddress || ['10.0.0.2/32'],
    private_key: profile.privateKey,
    mtu: profile.mtu || 1408,
    peers: [
      {
        address: profile.address,
        port: profile.port,
        public_key: profile.peerPublicKey,
        pre_shared_key: profile.presharedKey || undefined,
        allowed_ips: profile.allowedIPs || ['0.0.0.0/0']
      }
    ]
  };
}

function parseDnsList(dnsServers) {
  if (!dnsServers) return [];
  return String(dnsServers)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildSingboxConfig(profile, settings) {
  const socksPort = settings.socksPort || 10808;
  const httpPort = settings.httpPort || 10809;
  const dnsList = parseDnsList(settings.dnsServers);

  const isWireguard = profile.protocol === 'wireguard';
  const finalTag = isWireguard ? 'wg-endpoint' : 'proxy';

  const dnsThroughTunnel = settings.dnsThroughTunnel !== false && !isWireguard;

  const routeRules = [];
  if (dnsThroughTunnel) routeRules.push({ inbound: ['dns-hijack-in'], action: 'hijack-dns' });
  routeRules.push({ inbound: ['socks-in', 'http-in'], action: 'sniff' });
  if (settings.bypassLAN) routeRules.push({ ip_is_private: true, outbound: 'direct' });

  // Force any raw DNS traffic (port 53) through the proxy tunnel as well, as
  // a fallback alongside the per-server "detour" below (covers DNS packets
  // that bypass sing-box's own resolver, e.g. from apps doing their own
  // lookups through the SOCKS/HTTP inbound).
  if (dnsThroughTunnel) routeRules.push({ port: 53, network: 'udp,tcp', outbound: 'proxy' });

  const ruleSets = [];
  if (settings.bypassIran && settings.geoipAvailable) {
    ruleSets.push({ type: 'local', tag: 'geoip-ir', format: 'binary', path: settings.singboxGeoipIrPath });
    routeRules.push({ rule_set: 'geoip-ir', outbound: 'direct' });
  }

  const statsApiPort = settings.statsApiPort || 18888;

  return {
    log: { level: settings.logLevel === 'warning' ? 'warn' : settings.logLevel || 'warn', timestamp: true },
    dns: dnsList.length
      ? {
          servers: [
            ...dnsList.map((addr, i) => ({
              tag: `dns-${i}`,
              type: 'udp',
              server: addr,
              // Route the DNS server's own outgoing queries through the proxy
              // tunnel instead of the local network, so they never appear on
              // the ISP's link as plain, filterable DNS traffic.
              detour: dnsThroughTunnel ? 'proxy' : undefined
            })),
            // FakeIP: answers A/AAAA queries instantly with a local fake
            // address instead of waiting on a real (often slow/unstable
            // from Iran) DNS round-trip. Combined with inbound sniffing,
            // the real domain is read straight off the connection and sent
            // to the tunnel server to resolve — so proxied browsing never
            // waits on DNS at all.
            ...(dnsThroughTunnel ? [{ tag: 'fakeip', type: 'fakeip', inet4_range: '198.18.0.0/15', inet6_range: 'fc00::/18' }] : []),
            // Resolves the TUNNEL SERVER'S OWN hostname (when it's a domain,
            // not a raw IP) directly/undetoured. This one lookup must not go
            // through "proxy" — the proxy outbound can't be reached until its
            // own address is known, so detouring it would deadlock (exactly
            // what caused every connection to hang for 10s and time out).
            { tag: 'bootstrap', type: 'udp', server: dnsList[0] }
          ],
          rules: dnsThroughTunnel ? [{ query_type: ['A', 'AAAA'], server: 'fakeip' }] : undefined,
          independent_cache: true,
          final: 'dns-0'
        }
      : undefined,
    experimental: { clash_api: { external_controller: `127.0.0.1:${statsApiPort}` } },
    inbounds: [
      { type: 'socks', tag: 'socks-in', listen: '127.0.0.1', listen_port: socksPort },
      { type: 'http', tag: 'http-in', listen: '127.0.0.1', listen_port: httpPort },
      // Raw local DNS listener: lets the OS resolver itself (and any app
      // that doesn't honor the system proxy) be pointed at 127.0.0.1:53
      // (see systemDns.js); paired with the hijack-dns route rule below,
      // those plain queries get pulled into sing-box's own DNS engine
      // (fakeip/tunnel) instead of leaking out the network adapter.
      ...(dnsThroughTunnel ? [{ type: 'direct', tag: 'dns-hijack-in', listen: '127.0.0.1', listen_port: 53, network: 'udp' }] : [])
    ],
    endpoints: isWireguard ? [buildSingboxWireguardEndpoint(profile)] : undefined,
    outbounds: isWireguard ? [{ type: 'direct', tag: 'direct' }] : [buildSingboxOutbound(profile, settings), { type: 'direct', tag: 'direct' }],
    route: {
      rule_set: ruleSets.length ? ruleSets : undefined,
      rules: routeRules,
      default_domain_resolver: dnsList.length ? 'bootstrap' : undefined,
      final: finalTag
    }
  };
}

module.exports = { buildXrayConfig, buildSingboxConfig };
