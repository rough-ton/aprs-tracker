/**
 * APRS Tracker — frontend application logic
 * Handles API calls, map rendering, history, weather display, and settings.
 */

'use strict';

/* ── Constants ── */
const DEFAULT_CENTER = [40.4074185,-105.1433749]; // Loveland, CO
const DEFAULT_ZOOM = 14;

/**
 * Available map tile layers.
 * Satellite uses ESRI World Imagery (free, no key required).
 * Topo uses ESRI World Topo Map.
 * OSM Standard and CartoDB Voyager require no key.
 */
const TILE_LAYERS = {
  osm: {
    label: 'Streets',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attr: 'Tiles &copy; Esri &mdash; Source: Esri, USGS, NOAA',
    maxZoom: 19,
  },
  topo: {
    label: 'Topo',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attr: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ, TomTom',
    maxZoom: 19,
  },
  voyager: {
    label: 'Voyager',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19,
  },
};

/* ── State ── */
const state = {
  callsigns: [],
  locationData: {},   // callsign -> parsed entry
  weatherData: {},    // callsign -> parsed wx entry
  historyData: {},    // callsign -> array of entries
  settings: loadSettings(),
  autoRefreshTimer: null,
  activeLayer: null,  // current Leaflet tile layer on mainMap
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
    mapLayer: 'osm',
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
  setMapLayer(state.settings.mapLayer || 'osm');
  // Defer size calculation until after the DOM has fully painted
  setTimeout(() => mainMap.invalidateSize({ pan: false }), 100);
}

/**
 * Switch the main map tile layer.
 * @param {string} layerKey - Key from TILE_LAYERS
 */
function setMapLayer(layerKey) {
  const def = TILE_LAYERS[layerKey] || TILE_LAYERS.osm;
  if (state.activeLayer) mainMap.removeLayer(state.activeLayer);
  state.activeLayer = L.tileLayer(def.url, {
    attribution: def.attr,
    maxZoom: def.maxZoom,
  }).addTo(mainMap);
  state.settings.mapLayer = layerKey;
  saveSettings();
  // Update active button state
  $$('.layer-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layer === layerKey);
  });
}

function initHistMap() {
  if (histMap) return;
  histMap = L.map('history-map', { zoomControl: false, attributionControl: false })
    .setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  const def = TILE_LAYERS[state.settings.mapLayer || 'osm'] || TILE_LAYERS.osm;
  L.tileLayer(def.url, { maxZoom: def.maxZoom }).addTo(histMap);
}

/* ── APRS Symbol rendering ──
 * Maps APRS symbol characters to Font Awesome icons + colors.
 * This avoids CORS issues with external sprite sheets while still
 * conveying meaningful station type information.
 */

/**
 * Map common APRS primary table symbol chars to FA icon + color.
 * Covers the most common station types seen on the air.
 * @type {Record<string, {icon: string, color: string, label: string}>}
 */
const APRS_SYMBOL_MAP = {
  // Vehicles
  '>': { icon: 'fa-car',            color: '#0ea5e9', label: 'Car'         },
  'k': { icon: 'fa-truck',          color: '#0ea5e9', label: 'Truck'       },
  'u': { icon: 'fa-truck-pickup',   color: '#0ea5e9', label: 'Truck'       },
  'U': { icon: 'fa-bus',            color: '#6366f1', label: 'Bus'         },
  '^': { icon: 'fa-plane',          color: '#6366f1', label: 'Aircraft'    },
  "'": { icon: 'fa-plane',         color: '#8b5cf6', label: 'Aircraft'    },
  'X': { icon: 'fa-helicopter',     color: '#8b5cf6', label: 'Helicopter'  },
  'v': { icon: 'fa-van-shuttle',    color: '#0ea5e9', label: 'Van'         },
  // People / portable
  '[': { icon: 'fa-person-walking', color: '#10b981', label: 'Portable'    },
  'Y': { icon: 'fa-sailboat',       color: '#0ea5e9', label: 'Boat'        },
  // Infrastructure
  '#': { icon: 'fa-tower-cell',     color: '#f59e0b', label: 'Digipeater'  },
  'I': { icon: 'fa-tower-cell',     color: '#f59e0b', label: 'Igate'       },
  'r': { icon: 'fa-tower-broadcast',color: '#f59e0b', label: 'Repeater'    },
  // Fixed / home
  '-': { icon: 'fa-house',          color: '#10b981', label: 'House'       },
  '_': { icon: 'fa-cloud-sun-rain', color: '#6366f1', label: 'WX Station'  },
  // Emergency
  '!': { icon: 'fa-triangle-exclamation', color: '#ef4444', label: 'Emergency' },
  // Misc
  '/': { icon: 'fa-flag',           color: '#94a3b8', label: 'Flag'        },
  'p': { icon: 'fa-paw',            color: '#10b981', label: 'Pet'         },
  'b': { icon: 'fa-bicycle',        color: '#10b981', label: 'Bike'        },
  's': { icon: 'fa-sailboat',       color: '#0ea5e9', label: 'Ship'        },
};

/** Default icon for unmapped symbols */
const APRS_DEFAULT_ICON = { icon: 'fa-location-dot', color: '#0ea5e9', label: 'Station' };

/**
 * Build a per-callsign accent color for unknown symbols.
 * @param {string} callsign
 * @returns {string} hex color
 */
function callsignColor(callsign) {
  const palette = ['#0ea5e9', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444'];
  return palette[callsign.charCodeAt(0) % palette.length];
}

/**
 * Build a Leaflet divIcon with a Font Awesome icon representing
 * the APRS symbol type, plus the callsign label beneath it.
 * @param {string} callsign
 * @param {string} symbol - APRS symbol character
 * @param {string} symbolTable - APRS symbol table ('/' or '\\')
 * @returns {L.DivIcon}
 */
function makeMarkerIcon(callsign, symbol, symbolTable) {
  const def = (symbol && APRS_SYMBOL_MAP[symbol]) || APRS_DEFAULT_ICON;
  const color = def === APRS_DEFAULT_ICON ? callsignColor(callsign) : def.color;

  const iconHtml = `
    <div class="aprs-marker-inner">
      <div class="aprs-icon-wrap" style="background:${color}">
        <i class="fa-solid ${def.icon}"></i>
      </div>
      <span class="aprs-label">${callsign}</span>
    </div>`;

  return L.divIcon({
    className: 'aprs-marker-wrap',
    html: iconHtml,
    iconSize: [70, 44],
    iconAnchor: [35, 22],
    popupAnchor: [0, -24],
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
      markers[entry.callsign].setIcon(makeMarkerIcon(entry.callsign, entry.symbol, entry.symbol_table));
      markers[entry.callsign].setPopupContent(buildPopupHtml(entry));
    } else {
      markers[entry.callsign] = L.marker(latlng, { icon: makeMarkerIcon(entry.callsign, entry.symbol, entry.symbol_table) })
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

  // Map layer switcher
  $$('.layer-btn').forEach(btn => {
    btn.addEventListener('click', () => setMapLayer(btn.dataset.layer));
  });
  // Set initial active state
  $$('.layer-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layer === (state.settings.mapLayer || 'osm'));
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