'use strict';

const state = {
  profiles: [],
  subscriptions: [],
  expandedSubs: new Set(),
  settings: null,
  selectedProfileId: null,
  connection: { status: 'disconnected', profileId: null, uptimeMs: 0 },
  pingResults: {}, // profileId -> {ok, ms} | {ok:false}
  renameTargetId: null,
  lastPingMs: null
};

const el = (id) => document.getElementById(id);

// ---------- Toast ----------
let toastTimer = null;
function showToast(message, type = '') {
  const t = el('toast');
  t.textContent = message;
  t.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast hidden'), 3200);
}

// ---------- Window controls ----------
el('btn-min').addEventListener('click', () => window.signalray.win.minimize());
el('btn-close').addEventListener('click', () => window.signalray.win.close());

// ---------- Screen navigation (bottom nav) ----------
function goToScreen(name) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.screen === name));
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
}
document.querySelectorAll('.nav-btn').forEach((btn) => btn.addEventListener('click', () => goToScreen(btn.dataset.screen)));
el('btn-goto-profiles-banner').addEventListener('click', () => goToScreen('profiles'));

el('btn-quick-refresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.classList.add('spinning');
  if (state.selectedProfileId) fetchServerIp(state.selectedProfileId);
  if (state.connection.status === 'connected') {
    const res = await window.signalray.core.ping();
    if (res.ok) setSignalQuality(res.ms);
  } else if (state.selectedProfileId) {
    const res = await window.signalray.core.pingDirect(state.selectedProfileId);
    setSignalQuality(res.ok ? res.ms : null);
  }
  setTimeout(() => btn.classList.remove('spinning'), 500);
  showToast('بروزرسانی شد', 'success');
});

el('tile-speedtest').addEventListener('click', async () => {
  if (state.connection.status !== 'connected') {
    showToast('برای تست سرعت واقعی باید متصل باشید — در حال حاضر پینگ مستقیم انجام می‌شود', 'error');
    if (!state.selectedProfileId) {
      goToScreen('profiles');
      return;
    }
    const res = await window.signalray.core.pingDirect(state.selectedProfileId);
    if (res.ok) {
      setSignalQuality(res.ms);
      showToast(`پینگ مستقیم: ${toPersianDigits(res.ms)}ms`, 'success');
    } else {
      showToast(`تست ناموفق: ${res.error}`, 'error');
    }
    return;
  }
  runRealSpeedTest();
});

async function runRealSpeedTest() {
  el('speedtest-download').textContent = '—';
  el('speedtest-upload').textContent = '—';
  el('speedtest-status').textContent = 'در حال تست دانلود…';
  el('speedtest-modal').classList.remove('hidden');
  try {
    const result = await window.signalray.core.speedTest();
    if (result.download.ok) {
      el('speedtest-download').textContent = `${result.download.mbps.toFixed(1)} Mbps`;
    } else {
      el('speedtest-download').textContent = 'ناموفق';
    }
    el('speedtest-status').textContent = 'در حال تست آپلود…';
    if (result.upload.ok) {
      el('speedtest-upload').textContent = `${result.upload.mbps.toFixed(1)} Mbps`;
    } else {
      el('speedtest-upload').textContent = 'ناموفق';
    }
    el('speedtest-status').textContent = 'تست کامل شد ✓';
  } catch (err) {
    el('speedtest-status').textContent = `خطا: ${err.message}`;
  }
}
el('btn-speedtest-close').addEventListener('click', () => el('speedtest-modal').classList.add('hidden'));

el('tile-mtu').addEventListener('click', () => {
  goToScreen('settings');
  const card = el('mtu-value').closest('.settings-card');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
el('tile-smart-tunnel').addEventListener('click', () => {
  goToScreen('settings');
  const card = el('toggle-bypass-ir').closest('.settings-card');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
el('tile-history').addEventListener('click', () => goToScreen('logs'));

// ---------- Unit formatting ----------
function formatBytes(bytes) {
  if (bytes < 1024) return { value: toPersianDigits(Math.round(bytes)), unit: 'B' };
  if (bytes < 1024 * 1024) return { value: toPersianDigits((bytes / 1024).toFixed(1)), unit: 'KB' };
  if (bytes < 1024 * 1024 * 1024) return { value: toPersianDigits((bytes / 1024 / 1024).toFixed(1)), unit: 'MB' };
  return { value: toPersianDigits((bytes / 1024 / 1024 / 1024).toFixed(2)), unit: 'GB' };
}
function formatSpeed(bytesPerSec) {
  const b = formatBytes(bytesPerSec);
  return { value: b.value, unit: b.unit + '/s' };
}

// ---------- Profiles ----------
function badgeText(profile) {
  return { net: (profile.network || 'tcp').toUpperCase(), sec: (profile.security || 'none').toUpperCase() };
}

function pingBadgeClass(res) {
  if (!res || !res.ok) return 'ping-bad';
  if (res.ms <= 150) return 'ping-good';
  if (res.ms <= 350) return 'ping-mid';
  return 'ping-bad';
}

function buildProfileCard(profile) {
  const { net, sec } = badgeText(profile);
  const pingRes = state.pingResults[profile.id];
  const pingText = pingRes ? (pingRes.ok ? `${toPersianDigits(pingRes.ms)}ms` : '✕') : '';
  const totalUsage = (profile.usageUpload || 0) + (profile.usageDownload || 0);
  const maxUsage = Math.max(1, ...state.profiles.map((p) => (p.usageUpload || 0) + (p.usageDownload || 0)));
  const usagePct = totalUsage > 0 ? Math.max(4, Math.min(100, (totalUsage / maxUsage) * 100)) : 0;
  const usageText = totalUsage > 0 ? formatQuotaBytes(totalUsage) : '';

  const card = document.createElement('div');
  card.className = 'profile-card' + (profile.id === state.selectedProfileId ? ' active' : '');
  card.innerHTML = `
    <span class="profile-radio"></span>
    <div class="profile-info">
      <div class="profile-remark"></div>
      <div class="profile-meta">
        <span class="badge">${profile.protocol}</span>
        <span class="badge">${net}</span>
        <span class="badge badge-security">${sec}</span>
        <span class="badge-ping ${pingBadgeClass(pingRes)}" data-ping-for="${profile.id}">${pingText}</span>
      </div>
      ${
        totalUsage > 0
          ? `<div class="profile-usage-row"><div class="profile-usage-bar"><div class="profile-usage-fill" style="width:${usagePct}%"></div></div><span class="profile-usage-text">${usageText}</span></div>`
          : ''
      }
    </div>
    <div class="profile-actions">
      <button class="profile-ping" title="پینگ مستقیم">&#8635;</button>
      <button class="profile-edit" title="ویرایش">&#9998;</button>
      <button class="profile-delete" title="حذف">&#x2715;</button>
    </div>
  `;
  card.querySelector('.profile-remark').textContent = profile.remark;
  card.querySelector('.profile-info').addEventListener('click', () => selectProfile(profile.id));
  card.querySelector('.profile-info').addEventListener('dblclick', () => openRenameModal(profile));
  card.querySelector('.profile-ping').addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.textContent = '…';
    const res = await window.signalray.core.pingDirect(profile.id);
    btn.textContent = '\u21bb';
    state.pingResults[profile.id] = res;
    refreshAllProfileViews();
  });
  card.querySelector('.profile-edit').addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(profile);
  });
  card.querySelector('.profile-delete').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (state.connection.status !== 'disconnected' && state.connection.profileId === profile.id) {
      showToast('ابتدا اتصال را قطع کنید', 'error');
      return;
    }
    state.profiles = await window.signalray.profiles.delete(profile.id);
    if (state.selectedProfileId === profile.id) state.selectedProfileId = null;
    refreshAllProfileViews();
    refreshConnectButton();
  });
  return card;
}

function refreshAllProfileViews() {
  renderProfiles(el('search-input') ? el('search-input').value : '');
  renderSubscriptions();
}

function renderProfiles(filter = '') {
  const list = el('profile-list');
  const q = filter.trim().toLowerCase();
  const standalone = state.profiles.filter((p) => !p.subscriptionId);
  const filtered = standalone.filter((p) => !q || p.remark.toLowerCase().includes(q) || p.address.toLowerCase().includes(q));
  el('profile-count').textContent = `${toPersianDigits(standalone.length)} کانفیگ`;

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-hint">هنوز کانفیگ مستقلی اضافه نشده.<br/>روی دکمهٔ + بالا بزنید و لینک vless:// خود را از پنل ثنایی (x-ui) وارد کنید.<br/>برای افزودن سابسکریپشن، به تب «سابسکریپشن‌ها» بروید.</div>`;
    return;
  }

  list.innerHTML = '';
  for (const profile of filtered) {
    list.appendChild(buildProfileCard(profile));
  }
}

async function selectProfile(id) {
  const wasConnectedElsewhere = state.connection.status === 'connected' || state.connection.status === 'connecting';
  const switchingProfile = state.connection.profileId && state.connection.profileId !== id;

  state.selectedProfileId = id;
  refreshAllProfileViews();
  refreshConnectButton();
  const profile = state.profiles.find((p) => p.id === id);
  if (profile) {
    el('status-profile').textContent = profile.remark;
    el('stat-protocol').textContent = profile.protocol.toUpperCase();
    fetchServerIp(id);
    if (state.connection.status === 'disconnected') updateHomeSubQuotaCard(profile);
  }
  goToScreen('home');

  // Hot-swap: if already connected/connecting to a different profile, seamlessly
  // switch to the newly selected one instead of requiring manual disconnect first.
  if (wasConnectedElsewhere && switchingProfile) {
    showToast('در حال تعویض کانفیگ…');
    applyStatusToUI({ status: 'connecting' });
    try {
      const status = await window.signalray.core.connect(id);
      applyStatusToUI(status);
    } catch (err) {
      applyStatusToUI({ status: 'error', error: err.message });
    }
  }
}

function refreshConnectButton() {
  const btn = el('btn-toggle-connect');
  const busy = state.connection.status === 'connecting';
  btn.disabled = (!state.selectedProfileId && state.connection.status === 'disconnected') || busy;
}

el('search-input').addEventListener('input', (e) => renderProfiles(e.target.value));

// ---------- Ping all ----------
el('btn-ping-all').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  showToast('در حال پینگ همهٔ کانفیگ‌ها…');
  try {
    const results = await window.signalray.core.pingAll();
    state.pingResults = { ...state.pingResults, ...results };
    refreshAllProfileViews();
    showToast('پینگ همهٔ کانفیگ‌ها انجام شد', 'success');
  } finally {
    btn.disabled = false;
  }
});

// ---------- Profiles screen tabs (standalone vs subscriptions) ----------
document.querySelectorAll('.profile-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.profile-tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.profile-tab-panel').forEach((p) => p.classList.toggle('active', p.id === `profile-tab-${btn.dataset.profileTab}`));
  });
});

// ---------- Import modal (tabs: links / subscription) ----------
function openImportModal(defaultTab) {
  el('import-textarea').value = '';
  el('import-errors').textContent = '';
  el('sub-url-input').value = '';
  el('sub-remark-input').value = '';
  el('sub-errors').textContent = '';
  el('wg-textarea').value = '';
  el('wg-remark-input').value = '';
  el('wg-errors').textContent = '';
  switchImportTab(defaultTab);
  el('import-modal').classList.remove('hidden');
  if (defaultTab === 'links') el('import-textarea').focus();
  else if (defaultTab === 'sub') el('sub-url-input').focus();
  else el('wg-textarea').focus();
}
el('btn-add-profile').addEventListener('click', () => openImportModal('links'));
el('btn-add-subscription').addEventListener('click', () => openImportModal('sub'));
document.querySelectorAll('.import-tab-btn').forEach((btn) => btn.addEventListener('click', () => switchImportTab(btn.dataset.importTab)));
function switchImportTab(tab) {
  document.querySelectorAll('.import-tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.importTab === tab));
  el('import-tab-links').classList.toggle('active', tab === 'links');
  el('import-tab-sub').classList.toggle('active', tab === 'sub');
  el('import-tab-wg').classList.toggle('active', tab === 'wg');
}
el('btn-import-cancel').addEventListener('click', () => el('import-modal').classList.add('hidden'));
el('btn-import-confirm').addEventListener('click', async () => {
  const text = el('import-textarea').value;
  if (!text.trim()) return;
  const result = await window.signalray.profiles.import(text);
  state.profiles = result.profiles;
  refreshAllProfileViews();
  if (result.errors && result.errors.length) {
    el('import-errors').innerHTML = result.errors.map((e) => `• ${escapeHtml(e.line.slice(0, 40))}… — ${escapeHtml(e.error)}`).join('<br/>');
  } else {
    el('import-modal').classList.add('hidden');
    showToast(`${toPersianDigits(result.added)} کانفیگ افزوده شد`, 'success');
  }
});

el('btn-wg-cancel').addEventListener('click', () => el('import-modal').classList.add('hidden'));
el('btn-wg-confirm').addEventListener('click', async () => {
  const text = el('wg-textarea').value;
  if (!text.trim()) return;
  const remark = el('wg-remark-input').value.trim();
  const result = await window.signalray.profiles.importWireguard(text, remark);
  state.profiles = result.profiles;
  refreshAllProfileViews();
  if (result.errors && result.errors.length) {
    el('wg-errors').innerHTML = result.errors.map((e) => `• ${escapeHtml(e.error)}`).join('<br/>');
  } else {
    el('import-modal').classList.add('hidden');
    showToast('کانفیگ WireGuard افزوده شد', 'success');
  }
});

el('btn-sub-cancel').addEventListener('click', () => el('import-modal').classList.add('hidden'));
el('btn-sub-confirm').addEventListener('click', async () => {
  const url = el('sub-url-input').value.trim();
  if (!url) return;
  const remark = el('sub-remark-input').value.trim();
  const btn = el('btn-sub-confirm');
  btn.disabled = true;
  el('sub-errors').textContent = '';
  try {
    const result = await window.signalray.subscriptions.add(url, remark);
    state.subscriptions = result.subscriptions;
    state.profiles = result.profiles;
    refreshAllProfileViews();
    el('import-modal').classList.add('hidden');
    showToast(`${toPersianDigits(result.added)} کانفیگ از سابسکریپشن افزوده شد`, 'success');
    if (result.errors && result.errors.length) {
      showToast(`${toPersianDigits(result.errors.length)} خط قابل‌خواندن نبود`, 'error');
    }
  } catch (err) {
    el('sub-errors').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Subscriptions list (with quota bars + expandable nested configs) ----------
function formatQuotaBytes(bytes) {
  const b = formatBytes(bytes);
  return `${b.value} ${b.unit}`;
}
function renderSubscriptions() {
  const container = el('subscriptions-list');
  if (!state.subscriptions || !state.subscriptions.length) {
    container.innerHTML = `<div class="empty-hint">هنوز سابسکریپشنی اضافه نشده.<br/>روی «+ افزودن سابسکریپشن» بزنید و لینک پنل خود را وارد کنید.</div>`;
    return;
  }
  container.innerHTML = '';
  for (const sub of state.subscriptions) {
    const subProfiles = state.profiles.filter((p) => p.subscriptionId === sub.id);
    const isExpanded = state.expandedSubs.has(sub.id);

    const card = document.createElement('div');
    card.className = 'sub-card';
    let quotaHtml = '';
    if (sub.userinfo && sub.userinfo.total > 0) {
      const used = sub.userinfo.upload + sub.userinfo.download;
      const remaining = Math.max(0, sub.userinfo.total - used);
      const usedPct = Math.min(100, (used / sub.userinfo.total) * 100);
      const remainingPct = 100 - usedPct;
      const lowClass = remainingPct < 15 ? ' quota-low' : '';
      quotaHtml = `
        <div class="sub-card-quota-bar"><div class="sub-card-quota-fill${lowClass}" style="width:${usedPct}%"></div></div>
        <div class="sub-card-quota-text">
          <span>باقی‌مانده: ${formatQuotaBytes(remaining)}</span>
          <span>کل: ${formatQuotaBytes(sub.userinfo.total)}</span>
        </div>
        ${sub.userinfo.expire ? `<div class="sub-card-expire">انقضا: ${new Date(sub.userinfo.expire * 1000).toLocaleDateString('fa-IR')}</div>` : ''}
      `;
    } else {
      quotaHtml = `<div class="sub-card-expire">اطلاعات حجم توسط این پنل ارائه نشده</div>`;
    }
    card.innerHTML = `
      <div class="sub-card-head">
        <button class="sub-card-expand-btn">
          <span class="sub-card-chevron ${isExpanded ? 'expanded' : ''}">›</span>
          <span class="sub-card-name"></span>
        </button>
        <span class="sub-card-actions">
          <button class="sub-card-btn sub-ping-all" title="پینگ همهٔ کانفیگ‌های این سابسکریپشن">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 12a9 9 0 1 0 9-9M3 12l3-3M3 12l3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="sub-card-btn sub-refresh" title="بروزرسانی">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 4v6h6M20 20v-6h-6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 15a8 8 0 0 0 14 3M19 9A8 8 0 0 0 5 6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>
          </button>
          <button class="sub-card-btn danger sub-delete" title="حذف">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>
          </button>
        </span>
      </div>
      ${quotaHtml}
      <div class="sub-card-count-row">
        <span class="sub-card-count">${toPersianDigits(subProfiles.length)} کانفیگ</span>
        <span class="sub-card-ping-status hidden"></span>
      </div>
      <div class="sub-nested-list ${isExpanded ? '' : 'hidden'}"></div>
    `;
    card.querySelector('.sub-card-name').textContent = sub.remark;
    card.querySelector('.sub-card-expand-btn').addEventListener('click', () => {
      if (state.expandedSubs.has(sub.id)) state.expandedSubs.delete(sub.id);
      else state.expandedSubs.add(sub.id);
      renderSubscriptions();
    });
    if (isExpanded) {
      const nestedList = card.querySelector('.sub-nested-list');
      if (!subProfiles.length) {
        nestedList.innerHTML = `<div class="empty-hint">این سابسکریپشن کانفیگی ندارد</div>`;
      } else {
        for (const profile of subProfiles) nestedList.appendChild(buildProfileCard(profile));
      }
    }
    card.querySelector('.sub-ping-all').addEventListener('click', (e) => {
      togglePingSubscription(sub.id, subProfiles, e.currentTarget, card.querySelector('.sub-card-ping-status'));
    });
    card.querySelector('.sub-refresh').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const result = await window.signalray.subscriptions.refresh(sub.id);
        state.subscriptions = result.subscriptions;
        state.profiles = result.profiles;
        refreshAllProfileViews();
        showToast('سابسکریپشن بروزرسانی شد', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
    card.querySelector('.sub-delete').addEventListener('click', async () => {
      const result = await window.signalray.subscriptions.delete(sub.id);
      state.subscriptions = result.subscriptions;
      state.profiles = result.profiles;
      refreshAllProfileViews();
    });
    container.appendChild(card);
  }
}

// ---------- Cancellable ping-all for a single subscription (no connection needed — raw TCP) ----------
const pingSubState = { activeSubId: null, cancelled: false };
async function togglePingSubscription(subId, profiles, btn, statusEl) {
  if (pingSubState.activeSubId === subId) {
    pingSubState.cancelled = true; // user clicked cancel
    return;
  }
  if (pingSubState.activeSubId) {
    showToast('یک پینگ‌گروهی دیگر در حال اجراست', 'error');
    return;
  }
  if (!profiles.length) return;

  pingSubState.activeSubId = subId;
  pingSubState.cancelled = false;
  btn.classList.add('pinging');
  btn.title = 'لغو پینگ';
  statusEl.classList.remove('hidden');

  const CONCURRENCY = 4;
  let idx = 0;
  let done = 0;
  statusEl.textContent = `در حال پینگ… ۰/${toPersianDigits(profiles.length)}`;

  async function worker() {
    while (idx < profiles.length) {
      if (pingSubState.cancelled) return;
      const profile = profiles[idx++];
      const res = await window.signalray.core.pingDirect(profile.id);
      if (pingSubState.cancelled) return;
      state.pingResults[profile.id] = res;
      done++;
      statusEl.textContent = `در حال پینگ… ${toPersianDigits(done)}/${toPersianDigits(profiles.length)}`;
      updateSinglePingBadge(profile.id, res);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, profiles.length) }, worker));

  const wasCancelled = pingSubState.cancelled;
  pingSubState.activeSubId = null;
  pingSubState.cancelled = false;
  btn.classList.remove('pinging');
  btn.title = 'پینگ همهٔ کانفیگ‌های این سابسکریپشن';
  statusEl.textContent = wasCancelled ? 'لغو شد' : 'پایان یافت ✓';
  setTimeout(() => statusEl.classList.add('hidden'), 2500);
}

/** Updates just one profile's ping badge in-place (avoids a full re-render mid-scan, which would feel jumpy). */
function updateSinglePingBadge(profileId, res) {
  const badge = document.querySelector(`[data-ping-for="${profileId}"]`);
  if (!badge) return;
  badge.textContent = res.ok ? `${toPersianDigits(res.ms)}ms` : '✕';
  badge.className = `badge-ping ${pingBadgeClass(res)}`;
}

// ---------- Rename modal ----------
function openRenameModal(profile) {
  state.renameTargetId = profile.id;
  el('rename-input').value = profile.remark;
  el('rename-modal').classList.remove('hidden');
  el('rename-input').focus();
}
el('btn-rename-cancel').addEventListener('click', () => el('rename-modal').classList.add('hidden'));
el('btn-rename-confirm').addEventListener('click', async () => {
  const remark = el('rename-input').value.trim();
  if (!remark || !state.renameTargetId) return;
  state.profiles = await window.signalray.profiles.rename(state.renameTargetId, remark);
  el('rename-modal').classList.add('hidden');
  refreshAllProfileViews();
});

// ---------- Edit config modal ----------
const EDIT_FIELD_DEFS = {
  common: [
    { key: 'remark', label: 'نام', type: 'text' },
    { key: 'address', label: 'آدرس سرور', type: 'text', dir: 'ltr' },
    { key: 'port', label: 'پورت', type: 'number' }
  ],
  vless: [
    { key: 'uuid', label: 'UUID', type: 'text', dir: 'ltr' },
    { key: 'flow', label: 'Flow', type: 'text', dir: 'ltr' },
    { key: 'sni', label: 'SNI', type: 'text', dir: 'ltr' },
    { key: 'publicKey', label: 'Public Key (Reality)', type: 'text', dir: 'ltr' },
    { key: 'shortId', label: 'Short ID (Reality)', type: 'text', dir: 'ltr' },
    { key: 'wsPath', label: 'مسیر WS/XHTTP', type: 'text', dir: 'ltr' },
    { key: 'wsHost', label: 'Host WS', type: 'text', dir: 'ltr' }
  ],
  trojan: [
    { key: 'password', label: 'رمز عبور', type: 'text', dir: 'ltr' },
    { key: 'sni', label: 'SNI', type: 'text', dir: 'ltr' }
  ],
  vmess: [
    { key: 'uuid', label: 'UUID', type: 'text', dir: 'ltr' },
    { key: 'sni', label: 'SNI / Host', type: 'text', dir: 'ltr' },
    { key: 'wsPath', label: 'مسیر WS', type: 'text', dir: 'ltr' }
  ],
  hysteria2: [
    { key: 'password', label: 'رمز عبور', type: 'text', dir: 'ltr' },
    { key: 'sni', label: 'SNI', type: 'text', dir: 'ltr' },
    { key: 'obfsPassword', label: 'رمز Obfs', type: 'text', dir: 'ltr' }
  ]
};

let editTargetId = null;
function openEditModal(profile) {
  editTargetId = profile.id;
  const fields = [...EDIT_FIELD_DEFS.common, ...(EDIT_FIELD_DEFS[profile.protocol] || [])];
  const container = el('edit-fields');
  container.innerHTML = fields
    .map(
      (f) => `
      <label class="field-label">${f.label}</label>
      <input class="text-input" type="${f.type}" data-field="${f.key}" value="${escapeHtml(String(profile[f.key] ?? ''))}" ${f.dir ? `dir="${f.dir}"` : ''} />
    `
    )
    .join('');
  el('edit-modal').classList.remove('hidden');
}
el('btn-edit-cancel').addEventListener('click', () => el('edit-modal').classList.add('hidden'));
el('btn-edit-confirm').addEventListener('click', async () => {
  if (!editTargetId) return;
  const inputs = document.querySelectorAll('#edit-fields [data-field]');
  const fields = {};
  inputs.forEach((input) => {
    const key = input.dataset.field;
    fields[key] = input.type === 'number' ? parseInt(input.value, 10) || 0 : input.value.trim();
  });
  state.profiles = await window.signalray.profiles.update(editTargetId, fields);
  el('edit-modal').classList.add('hidden');
  refreshAllProfileViews();
  showToast('کانفیگ ذخیره شد', 'success');
});

// ---------- Status + power ring + uptime ----------
function applyStatusToUI(payload) {
  state.connection = { ...state.connection, ...payload };
  const ringSvg = el('ring-svg');
  const dot = el('profile-pill-dot');
  const btn = el('btn-toggle-connect');
  const statusText = el('hero-status-text');

  const statusMap = {
    disconnected: { text: 'غیرفعال', btnClass: '', dotClass: '' },
    connecting: { text: 'در حال اتصال…', btnClass: 'state-connecting', dotClass: 'dot-connecting' },
    connected: { text: 'متصل هستید', btnClass: 'state-connected', dotClass: 'dot-connected' },
    error: { text: 'خطا در اتصال', btnClass: 'state-error', dotClass: 'dot-error' }
  };
  const s = statusMap[payload.status] || statusMap.disconnected;

  ringSvg.dataset.state = payload.status;
  dot.className = `profile-pill-dot ${s.dotClass}`;
  el('log-panel-dot').className = `log-panel-dot ${s.dotClass}`;
  statusText.textContent = s.text;
  el('btn-pick-profile').className = `hero-status-row status-${payload.status}`;
  btn.className = `power-btn ${s.btnClass}`;
  btn.disabled = payload.status === 'connecting';

  const coreName = state.settings && state.settings.activeCore === 'singbox' ? 'sing-box' : 'Xray-core';
  el('core-badge-text').textContent = coreName;

  if (payload.status === 'connected') {
    startUptimeAndPingLoop();
    startParticles();
  } else {
    stopUptimeAndPingLoop();
    stopParticles();
    el('hero-uptime').textContent = '۰۰:۰۰:۰۰';
    if (payload.status === 'disconnected') {
      resetTrafficStats();
      setSignalQuality(null);
    } else if (payload.status === 'error') {
      setSignalQuality(null);
    }
  }

  if (payload.status === 'connected' || payload.status === 'connecting' || payload.status === 'error') {
    const profile = state.profiles.find((p) => p.id === (payload.profileId || state.connection.profileId));
    if (profile) {
      el('status-profile').textContent = profile.remark;
      el('stat-protocol').textContent = profile.protocol.toUpperCase();
    }
    updateHomeSubQuotaCard(profile);
  } else if (state.selectedProfileId) {
    const profile = state.profiles.find((p) => p.id === state.selectedProfileId);
    el('status-profile').textContent = profile ? profile.remark : 'کانفیگی انتخاب نشده';
    if (profile) el('stat-protocol').textContent = profile.protocol.toUpperCase();
    updateHomeSubQuotaCard(profile);
  } else {
    updateHomeSubQuotaCard(null);
  }

  if (payload.error) showToast(payload.error, 'error');
  refreshConnectButton();
}

/** Shows a compact subscription quota card on Home whenever the active/selected config belongs to a subscription. */
function updateHomeSubQuotaCard(profile) {
  const card = el('sub-quota-card');
  if (!profile || !profile.subscriptionId) {
    card.classList.add('hidden');
    card.innerHTML = '';
    return;
  }
  const sub = state.subscriptions.find((s) => s.id === profile.subscriptionId);
  if (!sub) {
    card.classList.add('hidden');
    card.innerHTML = '';
    return;
  }

  let quotaHtml;
  if (sub.userinfo && sub.userinfo.total > 0) {
    const used = sub.userinfo.upload + sub.userinfo.download;
    const remaining = Math.max(0, sub.userinfo.total - used);
    const usedPct = Math.min(100, (used / sub.userinfo.total) * 100);
    const lowClass = 100 - usedPct < 15 ? ' quota-low' : '';
    quotaHtml = `
      <div class="sub-card-quota-bar"><div class="sub-card-quota-fill${lowClass}" style="width:${usedPct}%"></div></div>
      <div class="sub-card-quota-text">
        <span>باقی‌مانده: ${formatQuotaBytes(remaining)}</span>
        <span>کل: ${formatQuotaBytes(sub.userinfo.total)}</span>
      </div>
    `;
  } else {
    quotaHtml = `<div class="sub-card-expire">این پنل اطلاعات حجم ارائه نمی‌دهد</div>`;
  }

  card.classList.remove('hidden');
  card.innerHTML = `
    <div class="sub-quota-card-head">
      <span class="sub-quota-card-icon">
        <svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>
      </span>
      <span class="sub-quota-card-name"></span>
    </div>
    ${quotaHtml}
  `;
  card.querySelector('.sub-quota-card-name').textContent = sub.remark;
}

function setSignalQuality(ms) {
  const el2 = el('server-row-signal');
  el2.classList.remove('ping-good', 'ping-mid', 'ping-bad');
  if (ms == null) return;
  if (ms <= 150) el2.classList.add('ping-good');
  else if (ms <= 350) el2.classList.add('ping-mid');
  else el2.classList.add('ping-bad');
}

// ---------- Uptime + tunnel ping while connected (periodic re-ping is OPT-IN — see settings) ----------
let uptimeTimer = null;
let pingLoopTimer = null;
function startUptimeAndPingLoop() {
  stopUptimeAndPingLoop();
  const start = Date.now();
  uptimeTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - start) / 1000);
    const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
    const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    el('hero-uptime').textContent = toPersianDigits(`${hh}:${mm}:${ss}`);
  }, 1000);

  const pingOnce = async () => {
    const res = await window.signalray.core.ping();
    if (res.ok) {
      state.lastPingMs = res.ms;
      setSignalQuality(res.ms);
    }
  };
  pingOnce(); // one health-check right after connecting, to populate the signal indicator

  // Repeated background pings are OFF by default — they cost bandwidth for no
  // real benefit in most cases. Only set up the interval if the user opted in
  // (Settings → «پینگ خودکار دوره‌ای»), and even then use a long interval.
  if (state.settings && state.settings.periodicHealthCheck) {
    const intervalMs = Math.max(15, state.settings.periodicHealthCheckIntervalSec || 30) * 1000;
    pingLoopTimer = setInterval(pingOnce, intervalMs);
  }
}
function stopUptimeAndPingLoop() {
  clearInterval(uptimeTimer);
  clearInterval(pingLoopTimer);
  uptimeTimer = null;
  pingLoopTimer = null;
}

// ---------- Light particle burst (visual "connection alive" feedback) ----------
const PARTICLE_COLORS = ['#5cffb0', '#3ec7e0', '#9a6dfb'];
let particleTimer = null;
function spawnParticle() {
  const layer = el('particle-layer');
  if (!layer) return;
  const angle = Math.random() * Math.PI * 2;
  const distance = 55 + Math.random() * 40;
  const x = Math.cos(angle) * distance;
  const y = Math.sin(angle) * distance;
  const size = 3 + Math.random() * 3;
  const duration = 1.2 + Math.random() * 0.9;
  const color = PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)];

  const p = document.createElement('span');
  p.className = 'light-particle';
  p.style.setProperty('--p-x', `${x}px`);
  p.style.setProperty('--p-y', `${y}px`);
  p.style.setProperty('--p-size', `${size}px`);
  p.style.setProperty('--p-duration', `${duration}s`);
  p.style.setProperty('--p-color', color);
  layer.appendChild(p);
  p.addEventListener('animationend', () => p.remove());
}
function startParticles() {
  stopParticles();
  particleTimer = setInterval(() => {
    spawnParticle();
    if (Math.random() > 0.5) spawnParticle();
  }, 220);
}
function stopParticles() {
  clearInterval(particleTimer);
  particleTimer = null;
  const layer = el('particle-layer');
  if (layer) layer.innerHTML = '';
}

// ---------- Traffic stats (real, from core stats API) ----------
function resetTrafficStats() {
  el('stat-upload').textContent = '۰';
  el('stat-upload-unit').textContent = 'KB/s';
  el('stat-download').textContent = '۰';
  el('stat-download-unit').textContent = 'KB/s';
}
window.signalray.core.onTraffic((t) => {
  const up = formatSpeed(t.uploadBps);
  el('stat-upload').textContent = up.value;
  el('stat-upload-unit').textContent = up.unit;
  const down = formatSpeed(t.downloadBps);
  el('stat-download').textContent = down.value;
  el('stat-download-unit').textContent = down.unit;
});

// ---------- Server IP (independent, never blocks connect) ----------
let ipFetchToken = 0;
async function fetchServerIp(profileId) {
  const token = ++ipFetchToken;
  el('server-ip-value').textContent = '...';
  const res = await window.signalray.core.resolveIp(profileId);
  if (token !== ipFetchToken) return; // a newer request superseded this one
  el('server-ip-value').textContent = res.ok ? res.ip : 'نامشخص';
}

// ---------- Connect / disconnect ----------
el('btn-toggle-connect').addEventListener('click', async () => {
  if (state.connection.status === 'connected' || state.connection.status === 'connecting') {
    applyStatusToUI({ status: 'connecting' });
    try {
      const status = await window.signalray.core.disconnect();
      applyStatusToUI(status);
    } catch (err) {
      showToast(err.message, 'error');
    }
    return;
  }

  if (state.settings && state.settings.autoSelectBest) {
    applyStatusToUI({ status: 'connecting' });
    showToast('در حال یافتن بهترین کانفیگ (بر اساس پینگ)…');
    try {
      const { bestId, bestMs } = await window.signalray.core.findBest();
      state.selectedProfileId = bestId;
      refreshAllProfileViews();
      const bestProfile = state.profiles.find((p) => p.id === bestId);
      showToast(`بهترین کانفیگ انتخاب شد: ${bestProfile ? bestProfile.remark : ''} (${toPersianDigits(bestMs)}ms)`, 'success');
    } catch (err) {
      applyStatusToUI({ status: 'error', error: err.message });
      return;
    }
  }

  if (!state.selectedProfileId) {
    applyStatusToUI({ status: 'disconnected' });
    showToast('ابتدا یک کانفیگ را انتخاب کنید', 'error');
    goToScreen('profiles');
    return;
  }
  try {
    const status = await window.signalray.core.connect(state.selectedProfileId);
    applyStatusToUI(status);
  } catch (err) {
    applyStatusToUI({ status: 'error', error: err.message });
  }
});

window.signalray.core.onStatus((payload) => applyStatusToUI(payload));
let logLineCount = 0;
window.signalray.core.onLog((line) => {
  const out = el('log-output');
  out.textContent += line + '\n';
  out.scrollTop = out.scrollHeight;
  logLineCount++;
  el('log-line-count').textContent = `${toPersianDigits(logLineCount)} خط`;
});
el('btn-clear-log').addEventListener('click', () => {
  el('log-output').textContent = '';
  logLineCount = 0;
  el('log-line-count').textContent = '۰ خط';
});
el('btn-copy-log').addEventListener('click', async () => {
  const text = el('log-output').textContent;
  if (!text.trim()) {
    showToast('گزارشی برای کپی وجود ندارد', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('گزارش در کلیپ‌بورد کپی شد', 'success');
  } catch (err) {
    showToast('کپی ناموفق بود', 'error');
  }
});

// ---------- Settings ----------
function updateGeoFieldVisibility() {
  const activeCoreEl = document.querySelector('input[name="active-core"]:checked');
  const isSingbox = activeCoreEl && activeCoreEl.value === 'singbox';
  el('geo-fields-xray').classList.toggle('hidden', !!isSingbox);
  el('geo-fields-singbox').classList.toggle('hidden', !isSingbox);
}
function updateMuxRowVisibility() {
  el('mux-concurrency-row').style.display = el('toggle-mux').checked ? 'flex' : 'none';
}

async function loadSettingsIntoForm() {
  const s = await window.signalray.settings.get();
  state.settings = s;
  el('path-xray').value = s.corePathXray || '';
  el('path-singbox').value = s.corePathSingbox || '';
  document.querySelectorAll('input[name="active-core"]').forEach((r) => (r.checked = r.value === s.activeCore));
  el('port-socks').value = s.socksPort;
  el('port-http').value = s.httpPort;
  el('toggle-system-proxy').checked = !!s.autoSystemProxy;
  el('toggle-bypass-lan').checked = !!s.bypassLAN;
  el('toggle-bypass-ir').checked = !!s.bypassIran;
  el('toggle-auto-select-best').checked = !!s.autoSelectBest;
  el('toggle-periodic-health').checked = !!s.periodicHealthCheck;
  el('toggle-live-stats').checked = s.showLiveStats !== false;
  el('toggle-dns-through-tunnel').checked = s.dnsThroughTunnel !== false;
  el('toggle-fragment').checked = !!s.enableFragment;
  el('toggle-mux').checked = !!s.enableMux;
  el('mux-concurrency').value = s.muxConcurrency || 8;
  el('toggle-tfo').checked = !!s.enableTcpFastOpen;
  el('select-domain-strategy').value = s.domainStrategy || 'IPIfNonMatch';
  el('select-fingerprint').value = s.defaultFingerprint || 'chrome';
  el('dns-servers').value = s.dnsServers || '';
  el('mtu-value').value = s.mtu || '';
  el('select-loglevel').value = s.logLevel;
  el('path-geoip-dat').value = s.geoipDatPath || '';
  el('path-geosite-dat').value = s.geositeDatPath || '';
  el('path-geoip-srs').value = s.singboxGeoipIrPath || '';
  el('font-scale-slider').value = s.fontScale || 1.1;
  applyFontScale(s.fontScale || 1.1);

  updateGeoFieldVisibility();
  updateMuxRowVisibility();
}

document.querySelectorAll('input[name="active-core"]').forEach((r) => r.addEventListener('change', updateGeoFieldVisibility));
el('toggle-mux').addEventListener('change', updateMuxRowVisibility);

el('btn-browse-xray').addEventListener('click', async () => {
  const p = await window.signalray.settings.browseCore('xray');
  if (p) el('path-xray').value = p;
});
el('btn-browse-singbox').addEventListener('click', async () => {
  const p = await window.signalray.settings.browseCore('singbox');
  if (p) el('path-singbox').value = p;
});
el('btn-browse-geoip').addEventListener('click', async () => {
  const p = await window.signalray.settings.browseGeoFile('geoipDatPath');
  if (p) el('path-geoip-dat').value = p;
});
el('btn-browse-geosite').addEventListener('click', async () => {
  const p = await window.signalray.settings.browseGeoFile('geositeDatPath');
  if (p) el('path-geosite-dat').value = p;
});
el('btn-browse-geoip-srs').addEventListener('click', async () => {
  const p = await window.signalray.settings.browseGeoFile('singboxGeoipIrPath');
  if (p) el('path-geoip-srs').value = p;
});

el('btn-update-geo').addEventListener('click', async () => {
  const activeCoreEl = document.querySelector('input[name="active-core"]:checked');
  const activeCore = activeCoreEl ? activeCoreEl.value : 'xray';
  const msg = el('geo-update-msg');
  msg.textContent = 'در حال دانلود…';
  goToScreen('logs');
  const result = await window.signalray.settings.updateGeo(activeCore);
  state.settings = result.settings;
  el('path-geoip-dat').value = state.settings.geoipDatPath || '';
  el('path-geosite-dat').value = state.settings.geositeDatPath || '';
  el('path-geoip-srs').value = state.settings.singboxGeoipIrPath || '';
  if (result.errors && result.errors.length) {
    msg.textContent = 'با خطا مواجه شد — گزارش را ببینید';
    showToast('برخی فایل‌ها دانلود نشدند', 'error');
  } else {
    msg.textContent = 'بروزرسانی شد ✓';
    showToast('فایل‌های Geo با موفقیت بروزرسانی شدند', 'success');
  }
  setTimeout(() => (msg.textContent = ''), 4000);
});

// ---------- MTU finder ----------
window.signalray.mtu.onProgress((p) => {
  el('mtu-status-msg').textContent = `در حال آزمایش اندازهٔ بسته: ${toPersianDigits(p.size)}…`;
});
el('btn-find-mtu').addEventListener('click', async () => {
  if (!state.selectedProfileId) {
    showToast('ابتدا یک کانفیگ را از تب کانفیگ‌ها انتخاب کنید', 'error');
    goToScreen('profiles');
    return;
  }
  const btn = el('btn-find-mtu');
  const msg = el('mtu-status-msg');
  btn.disabled = true;
  msg.textContent = 'در حال آغاز آزمایش…';
  try {
    const result = await window.signalray.mtu.find(state.selectedProfileId);
    if (result.ok) {
      el('mtu-value').value = result.mtu;
      msg.textContent = `MTU بهینه: ${toPersianDigits(result.mtu)} ✓`;
      showToast(`MTU بهینه پیدا شد: ${toPersianDigits(result.mtu)}`, 'success');
    } else {
      msg.textContent = result.error;
      showToast(result.error, 'error');
    }
  } finally {
    btn.disabled = false;
  }
});

el('btn-save-settings').addEventListener('click', async () => {
  const activeCoreEl = document.querySelector('input[name="active-core"]:checked');
  const partial = {
    corePathXray: el('path-xray').value.trim(),
    corePathSingbox: el('path-singbox').value.trim(),
    activeCore: activeCoreEl ? activeCoreEl.value : 'xray',
    socksPort: parseInt(el('port-socks').value, 10) || 10808,
    httpPort: parseInt(el('port-http').value, 10) || 10809,
    autoSystemProxy: el('toggle-system-proxy').checked,
    bypassLAN: el('toggle-bypass-lan').checked,
    bypassIran: el('toggle-bypass-ir').checked,
    autoSelectBest: el('toggle-auto-select-best').checked,
    periodicHealthCheck: el('toggle-periodic-health').checked,
    showLiveStats: el('toggle-live-stats').checked,
    dnsThroughTunnel: el('toggle-dns-through-tunnel').checked,
    enableFragment: el('toggle-fragment').checked,
    enableMux: el('toggle-mux').checked,
    muxConcurrency: parseInt(el('mux-concurrency').value, 10) || 8,
    enableTcpFastOpen: el('toggle-tfo').checked,
    domainStrategy: el('select-domain-strategy').value,
    defaultFingerprint: el('select-fingerprint').value,
    dnsServers: el('dns-servers').value.trim(),
    mtu: parseInt(el('mtu-value').value, 10) || 0,
    logLevel: el('select-loglevel').value,
    geoipDatPath: el('path-geoip-dat').value.trim(),
    geositeDatPath: el('path-geosite-dat').value.trim(),
    singboxGeoipIrPath: el('path-geoip-srs').value.trim()
  };
  state.settings = await window.signalray.settings.save(partial);

  const msg = el('settings-saved-msg');
  msg.textContent = 'ذخیره شد ✓ برای اعمال، اتصال را دوباره برقرار کنید';
  setTimeout(() => (msg.textContent = ''), 3000);
});

// ---------- Font scale ----------
function applyFontScale(scale) {
  document.documentElement.style.setProperty('--scale', scale);
}
el('font-scale-slider').addEventListener('input', (e) => applyFontScale(e.target.value));
el('font-scale-slider').addEventListener('change', async (e) => {
  state.settings = await window.signalray.settings.save({ fontScale: parseFloat(e.target.value) });
});
el('font-dec').addEventListener('click', async () => {
  const slider = el('font-scale-slider');
  slider.value = Math.max(parseFloat(slider.min), parseFloat(slider.value) - parseFloat(slider.step));
  applyFontScale(slider.value);
  state.settings = await window.signalray.settings.save({ fontScale: parseFloat(slider.value) });
});
el('font-inc').addEventListener('click', async () => {
  const slider = el('font-scale-slider');
  slider.value = Math.min(parseFloat(slider.max), parseFloat(slider.value) + parseFloat(slider.step));
  applyFontScale(slider.value);
  state.settings = await window.signalray.settings.save({ fontScale: parseFloat(slider.value) });
});

// ---------- Helpers ----------
function toPersianDigits(input) {
  const map = { 0: '۰', 1: '۱', 2: '۲', 3: '۳', 4: '۴', 5: '۵', 6: '۶', 7: '۷', 8: '۸', 9: '۹' };
  return String(input).replace(/[0-9]/g, (d) => map[d]);
}
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Init ----------
(async function init() {
  state.profiles = await window.signalray.profiles.list();
  state.subscriptions = await window.signalray.subscriptions.list();
  renderProfiles();
  renderSubscriptions();
  await loadSettingsIntoForm();
  const status = await window.signalray.core.status();
  applyStatusToUI(status);
})();
