/**
 * APRS Tracker — frontend application logic
 * Handles API calls, map rendering, history, weather display, and settings.
 */

'use strict';

/* ── Constants ── */
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const DEFAULT_CENTER = [39.7392, -104.9903]; // Denver, CO
const DEFAULT_ZOOM = 8;

/* ── State ── */
const state = {
  callsigns: [],
  locationData: {},   // callsign -> parsed entry
  weatherData: {},    // callsign -> parsed wx entry
  historyData: {},    // callsign -> array of entries
  settings: loadSettings(),
  autoRefreshTimer: null,
};

/* ── DOM refs ── */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* ── Maps ── */
let mainMap = null;
let histMap = null;
const markers = {};         // callsign -> Leaflet marker
let histPolyline = null;
const histMarkers = [];

/* ── Settings persistence ── */
function loadSettings() {
  try {
    const raw = localStorage.getItem('aprs_settings');
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch (_) { /* ignore */ }
  return defaultSettings();
}

function defaultSettings() {
  return {
    autoRefresh: false,
    interval: 60,
    units: 'imperial',
    savedCallsigns: '',
  };
}

function saveSettings() {
  try {
    localStorage.setItem('aprs_settings', JSON.stringify(state.settings));
  } catch (_) { /* ignore */ }
}

/* ── Unit helpers ── */
function fmtSpeed(kph) {
  if (kph == null) return '—';
  if (state.settings.units === 'imperial') {
    return `${(kph * 0.621371).toFixed(1)} mph`;
  }
  return `${kph.toFixed(1)} km/h`;
}

function fmtTemp(c) {
  if (c == null) return '—';
  if (state.settings.units === 'imperial') {
    return `${((c * 9 / 5) + 32).toFixed(1)} °F`;
  }
  return `${c.toFixed(1)} °C`;
}

function fmtAlt(m) {
  if (m == null || m === 0) return '—';
  if (state.settings.units === 'imperial') {
    return `${(m * 3.28084).toFixed(0)} ft`;
  }
  return `${m.toFixed(0)} m`;
}

function fmtCoord(lat, lng) {
  return `${lat.toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? 'E' : 'W'}`;
}

function fmtTime(unix) {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function timeAgo(unix) {
  if (!unix) return '';
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/* ── Toast ── */
function showToast(msg, duration = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), duration);
}

/* ── Loading overlay ── */
function setLoading(on) {
  $('#loading').hidden = !on;
}

/* ── Map init ── */
function initMainMap() {
  if (mainMap) return;
  mainMap = L.map('map', { zoomControl: true, attributionControl: false })
    .setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(mainMap);
}

function initHistMap() {
  if (histMap) return;
  histMap = L.map('history-map', { zoomControl: false, attributionControl: false })
    .setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  L.tileLayer(TILE_URL, { maxZoom: 19 }).addTo(histMap);
}

function makeMarkerIcon(callsign) {
  const colors = ['#00c896', '#2fa8e0', '#e8a020', '#c070e0', '#e05050'];
  const idx = callsign.charCodeAt(0) % colors.length;
  return L.divIcon({
    className: '',
    html: `<div style="
      background:${colors[idx]};
      width:14px;height:14px;
      border-radius:50% 50% 50% 0;
      transform:rotate(-45deg);
      border:2px solid rgba(255,255,255,0.85);
      box-shadow:0 2px 8px rgba(0,0,0,0.6);
    "></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 14],
    popupAnchor: [0, -16],
  });
}

/* ── API calls ── */
async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchLocation(callsigns) {
  const qs = callsigns.join(',');
  return apiGet(`/api/location?callsigns=${encodeURIComponent(qs)}`);
}

async function fetchWeather(callsigns) {
  const qs = callsigns.join(',');
  return apiGet(`/api/weather?callsigns=${encodeURIComponent(qs)}`);
}

async function fetchHistory(callsign, limit = 20) {
  return apiGet(`/api/history?callsign=${encodeURIComponent(callsign)}&limit=${limit}`);
}

/* ── Popup HTML ── */
function buildPopupHtml(entry) {
  return `
    <div class="popup-callsign">${entry.callsign}</div>
    <div class="popup-row">Coords: <span>${fmtCoord(entry.lat, entry.lng)}</span></div>
    <div class="popup-row">Altitude: <span>${fmtAlt(entry.altitude)}</span></div>
    <div class="popup-row">Speed: <span>${fmtSpeed(entry.speed)}</span></div>
    <div class="popup-row">Course: <span>${entry.course ? entry.course + '°' : '—'}</span></div>
    <div class="popup-row">Last heard: <span>${timeAgo(entry.lasttime)}</span></div>
    ${entry.comment ? `<div class="popup-row" style="margin-top:4px;color:#8fa">"${entry.comment}"</div>` : ''}
  `;
}

/* ── Render station cards ── */
function renderStationCards() {
  const container = $('#station-cards');
  container.innerHTML = '';

  const entries = Object.values(state.locationData);
  if (!entries.length) return;

  entries.forEach(entry => {
    const card = document.createElement('div');
    card.className = 'station-card';
    card.dataset.callsign = entry.callsign;
    card.innerHTML = `
      <div class="card-header">
        <span class="card-callsign">${entry.callsign}</span>
        <span class="card-time">${timeAgo(entry.lasttime)}</span>
      </div>
      <div class="card-grid">
        <div class="card-field">Lat/Lng <span>${entry.lat.toFixed(4)}, ${entry.lng.toFixed(4)}</span></div>
        <div class="card-field">Alt <span>${fmtAlt(entry.altitude)}</span></div>
        <div class="card-field">Speed <span>${fmtSpeed(entry.speed)}</span></div>
        <div class="card-field">Course <span>${entry.course ? entry.course + '°' : '—'}</span></div>
      </div>
      ${entry.comment ? `<div class="card-comment">${entry.comment}</div>` : ''}
    `;
    card.addEventListener('click', () => {
      const m = markers[entry.callsign];
      if (m) {
        mainMap.flyTo(m.getLatLng(), 12, { duration: 0.8 });
        m.openPopup();
      }
    });
    container.appendChild(card);
  });
}

/* ── Update map markers ── */
function updateMapMarkers() {
  // Force Leaflet to recalculate container bounds — prevents width blowout on mobile
  if (mainMap) mainMap.invalidateSize({ pan: false });

  Object.values(state.locationData).forEach(entry => {
    const latlng = [entry.lat, entry.lng];
    if (markers[entry.callsign]) {
      markers[entry.callsign].setLatLng(latlng);
      markers[entry.callsign].setPopupContent(buildPopupHtml(entry));
    } else {
      markers[entry.callsign] = L.marker(latlng, { icon: makeMarkerIcon(entry.callsign) })
        .addTo(mainMap)
        .bindPopup(buildPopupHtml(entry));
    }
  });

  const latlngs = Object.values(state.locationData).map(e => [e.lat, e.lng]);
  if (latlngs.length === 1) {
    mainMap.flyTo(latlngs[0], DEFAULT_ZOOM, { duration: 1 });
  } else if (latlngs.length > 1) {
    mainMap.flyToBounds(L.latLngBounds(latlngs), { padding: [40, 40], duration: 1 });
  }
}

/* ── Render weather ── */
function renderWeather() {
  const container = $('#weather-cards');
  container.innerHTML = '';

  const entries = Object.values(state.weatherData);
  if (!entries.length) {
    container.innerHTML = '<div class="empty-state">No weather data for these callsigns.<br>Not all stations transmit weather telemetry.</div>';
    return;
  }

  entries.forEach(wx => {
    const card = document.createElement('div');
    card.className = 'wx-card';
    card.innerHTML = `
      <div class="wx-callsign">${wx.callsign}</div>
      <div class="wx-grid">
        ${wxMetric('Temp', fmtTemp(wx.temp), wx.temp != null && Math.abs(wx.temp) > 35 ? 'hi' : '')}
        ${wxMetric('Humidity', wx.humidity != null ? wx.humidity.toFixed(0) + ' %' : '—', 'accent')}
        ${wxMetric('Pressure', wx.pressure != null ? wx.pressure.toFixed(1) + ' hPa' : '—', '')}
        ${wxMetric('Wind speed', fmtSpeed(wx.wind_speed), '')}
        ${wxMetric('Wind gust', fmtSpeed(wx.wind_gust), 'hi')}
        ${wxMetric('Wind dir', wx.wind_direction != null ? wx.wind_direction.toFixed(0) + '°' : '—', '')}
        ${wxMetric('Rain 1h', wx.rain_1h != null ? wx.rain_1h.toFixed(1) + ' mm' : '—', '')}
        ${wxMetric('Rain 24h', wx.rain_24h != null ? wx.rain_24h.toFixed(1) + ' mm' : '—', '')}
      </div>
    `;
    container.appendChild(card);
  });
}

function wxMetric(label, value, cls = '') {
  const naClass = value === '—' ? ' na' : '';
  return `
    <div class="wx-metric">
      <div class="wx-label">${label}</div>
      <div class="wx-value ${cls}${naClass}">${value}</div>
    </div>
  `;
}

/* ── Render history ── */
function populateHistorySelect() {
  const sel = $('#history-callsign-select');
  sel.innerHTML = '';
  if (!state.callsigns.length) {
    sel.innerHTML = '<option value="">-- look up callsigns first --</option>';
    return;
  }
  state.callsigns.forEach(cs => {
    const opt = document.createElement('option');
    opt.value = cs;
    opt.textContent = cs;
    sel.appendChild(opt);
  });
}

function renderHistoryList(entries) {
  const list = $('#history-list');
  list.innerHTML = '';

  if (!entries || !entries.length) {
    list.innerHTML = '<div class="empty-state">No history packets found.</div>';
    return;
  }

  entries.forEach((entry, idx) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <div class="history-seq">#${entries.length - idx}</div>
      <div class="history-speed">${fmtSpeed(entry.speed)}</div>
      <div class="history-coords">${fmtCoord(entry.lat, entry.lng)}</div>
      <div class="history-time">${fmtTime(entry.time)} — ${timeAgo(entry.time)}</div>
    `;
    list.appendChild(item);
  });
}

function drawHistoryOnMap(entries) {
  if (!histMap) initHistMap();
  $('#history-map').style.display = 'block';
  setTimeout(() => histMap.invalidateSize(), 50);

  // Clear old
  if (histPolyline) { histMap.removeLayer(histPolyline); histPolyline = null; }
  histMarkers.forEach(m => histMap.removeLayer(m));
  histMarkers.length = 0;

  if (!entries.length) return;

  const latlngs = entries.map(e => [e.lat, e.lng]);
  histPolyline = L.polyline(latlngs, { color: '#2fa8e0', weight: 2, opacity: 0.7 }).addTo(histMap);

  latlngs.forEach((ll, i) => {
    const isLast = i === 0;
    const m = L.circleMarker(ll, {
      radius: isLast ? 7 : 4,
      fillColor: isLast ? '#00c896' : '#2fa8e0',
      color: '#fff',
      weight: 1.5,
      fillOpacity: 0.9,
    }).addTo(histMap);
    histMarkers.push(m);
  });

  histMap.fitBounds(histPolyline.getBounds(), { padding: [20, 20] });
}

/* ── Main lookup ── */
async function doLookup() {
  const raw = $('#input-callsigns').value.trim();
  if (!raw) {
    showToast('Enter at least one callsign.');
    return;
  }

  const callsigns = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!callsigns.length) return;

  state.callsigns = callsigns;
  setLoading(true);
  $('#search-hint').textContent = `Fetching data for ${callsigns.join(', ')}…`;

  try {
    const [locData, wxData] = await Promise.allSettled([
      fetchLocation(callsigns),
      fetchWeather(callsigns),
    ]);

    // Location
    if (locData.status === 'fulfilled' && locData.value.ok) {
      state.locationData = {};
      locData.value.entries.forEach(e => { state.locationData[e.callsign] = e; });
      updateMapMarkers();
      renderStationCards();
      const found = locData.value.entries.map(e => e.callsign);
      const notFound = callsigns.filter(cs => !found.includes(cs));
      if (notFound.length) {
        showToast(`No data: ${notFound.join(', ')}`);
      }
    } else if (locData.status === 'rejected') {
      showToast(`Location error: ${locData.reason.message}`);
    }

    // Weather
    if (wxData.status === 'fulfilled' && wxData.value.ok) {
      state.weatherData = {};
      wxData.value.entries.forEach(e => { state.weatherData[e.callsign] = e; });
      renderWeather();
    }

    populateHistorySelect();
    const count = Object.keys(state.locationData).length;
    $('#search-hint').textContent = count
      ? `${count} station${count > 1 ? 's' : ''} found — tap a card to pan map`
      : 'No stations found for those callsigns.';

    scheduleAutoRefresh();
  } catch (err) {
    showToast(`Error: ${err.message}`);
    $('#search-hint').textContent = `Error: ${err.message}`;
  } finally {
    setLoading(false);
  }
}

/* ── Auto-refresh ── */
function scheduleAutoRefresh() {
  if (state.autoRefreshTimer) clearTimeout(state.autoRefreshTimer);
  if (!state.settings.autoRefresh || !state.callsigns.length) return;
  state.autoRefreshTimer = setTimeout(async () => {
    await doLookup();
  }, state.settings.interval * 1000);
}

/* ── Tabs ── */
function switchTab(name) {
  $$('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
    t.setAttribute('aria-selected', t.dataset.tab === name ? 'true' : 'false');
  });
  $$('.tab-pane').forEach(p => {
    p.classList.toggle('active', p.id === `tab-${name}`);
  });

  if (name === 'map') {
    setTimeout(() => mainMap && mainMap.invalidateSize(), 50);
  }
}

/* ── Settings UI ── */
function openSettings() {
  const drawer = $('#settings-drawer');
  const overlay = $('#settings-overlay');

  $('#setting-autorefresh').checked = state.settings.autoRefresh;
  $('#setting-interval').value = state.settings.interval;
  $('#setting-units').value = state.settings.units;
  $('#setting-saved').value = state.settings.savedCallsigns;

  drawer.hidden = false;
  overlay.hidden = false;
}

function closeSettings() {
  $('#settings-drawer').hidden = true;
  $('#settings-overlay').hidden = true;
}

function applySettings() {
  state.settings.autoRefresh = $('#setting-autorefresh').checked;
  state.settings.interval = parseInt($('#setting-interval').value, 10) || 60;
  state.settings.units = $('#setting-units').value;
  state.settings.savedCallsigns = $('#setting-saved').value.trim();
  saveSettings();
  closeSettings();
  renderStationCards();
  renderWeather();
  scheduleAutoRefresh();
  showToast('Settings saved.');
}

/* ── Boot ── */
function init() {
  setLoading(false); // ensure overlay is hidden on fresh page load
  initMainMap();

  // Tab switching
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Lookup
  $('#btn-lookup').addEventListener('click', doLookup);
  $('#input-callsigns').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLookup();
  });

  // History load
  $('#btn-load-history').addEventListener('click', async () => {
    const cs = $('#history-callsign-select').value;
    if (!cs) { showToast('Select a callsign first.'); return; }
    setLoading(true);
    try {
      const data = await fetchHistory(cs, 25);
      if (data.ok) {
        state.historyData[cs] = data.entries;
        renderHistoryList(data.entries);
        drawHistoryOnMap(data.entries);
      } else {
        showToast('No history data returned.');
      }
    } catch (err) {
      showToast(`History error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  });

  // Settings
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-close-settings').addEventListener('click', closeSettings);
  $('#settings-overlay').addEventListener('click', closeSettings);
  $('#btn-save-settings').addEventListener('click', applySettings);

  // Load saved callsigns on startup
  if (state.settings.savedCallsigns) {
    $('#input-callsigns').value = state.settings.savedCallsigns;
    doLookup();
  }
}

document.addEventListener('DOMContentLoaded', init);