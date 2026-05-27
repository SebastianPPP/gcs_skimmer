// SocketIO 
const socket = io({
    transports: ['polling', 'websocket'],
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
});

// App state 
const State = {
    map: null,
    droneMarkers: {},       
    droneData: {},           
    droneLastSeen: {},        
    droneInactiveAt: {},    
    followMode: false,      
    missionLayer: new L.LayerGroup(),
    drawingLayer: new L.LayerGroup(),
    isDrawingMode: false,
    drawingMarkers: [],
    drawingPolyline: null,
    finalWaypoints: [],
    missionPolyline: null,
    selectedDroneId: null,
};

// Connection pill 
const ConnBar = {
    el: null, label: null,
    init() {
        this.el    = document.getElementById('conn-pill');
        this.label = document.getElementById('conn-label');
    },
    set(state) {
        if (!this.el) return;
        this.el.className = `pill pill-${state === 'connected' ? 'ok' : state === 'disconnected' ? 'err' : 'warn'}`;
        const labels = { connecting: 'CONNECTING', connected: 'ONLINE', disconnected: 'OFFLINE' };
        this.label.innerText = labels[state] ?? state;
    },
};

// Toast 
const Toast = {
    container: null,
    init() { this.container = document.getElementById('toast-container'); },
    show(msg, type = 'info', dur = 3500) {
        const t = document.createElement('div');
        t.className = `toast toast-${type}`;
        t.innerText = msg;
        this.container.appendChild(t);
        requestAnimationFrame(() => t.classList.add('toast-visible'));
        setTimeout(() => {
            t.classList.remove('toast-visible');
            t.addEventListener('transitionend', () => t.remove(), { once: true });
        }, dur);
    },
    success: (m) => Toast.show(m, 'success'),
    warn:    (m) => Toast.show(m, 'warn'),
    error:   (m) => Toast.show(m, 'error'),
    info:    (m) => Toast.show(m, 'info'),
};

function signalColor(droneId) {
    const last = State.droneLastSeen[droneId];
    if (!last) return '#4ade80';
    const age = (Date.now() - last) / 1000;
    if (age < 10)  return '#4ade80';   
    if (age < 30)  return '#fbbf24';    
    return '#f87171';                   
}

// Icons
function getDroneIconHtml(color, selected = false) {
    const ring = selected
        ? `<div style="position:absolute;inset:-5px;border-radius:50%;border:2px solid ${color};opacity:0.5;animation:pulse-ring 1.5s ease-out infinite;"></div>`
        : '';
    return `
    <div style="position:relative;width:36px;height:36px;display:flex;align-items:center;justify-content:center;">
        ${ring}
        <div class="drone-body" style="width:28px;height:28px;display:flex;align-items:center;justify-content:center;transition:transform 0.1s linear;">
            <svg viewBox="0 0 24 24" fill="${color}" stroke="rgba(0,0,0,0.5)" stroke-width="0.8"
                 style="width:100%;height:100%;filter:drop-shadow(0 0 3px ${color}88) drop-shadow(0 2px 4px rgba(0,0,0,0.8));">
                <path d="M12 2L4.5 20.29C4.24 20.89 4.75 21.54 5.4 21.37L12 19.5L18.6 21.37C19.25 21.54 19.76 20.89 19.5 20.29L12 2Z"/>
            </svg>
        </div>
        <div class="signal-dot" style="position:absolute;bottom:0;right:0;width:8px;height:8px;border-radius:50%;background:${color};border:1.5px solid rgba(0,0,0,0.6);box-shadow:0 0 4px ${color};"></div>
    </div>`;
}

function createDroneIcon(droneId, selected = false) {
    const color = signalColor(droneId);
    return L.divIcon({
        className: 'custom-drone-wrapper',
        html: getDroneIconHtml(color, selected),
        iconSize: [36, 36],
        iconAnchor: [18, 18],
    });
}

function createWaypointIcon(number) {
    return L.divIcon({
        className: 'waypoint-marker',
        html: `<div style="background:rgba(96,165,250,0.15);color:#60a5fa;width:22px;height:22px;border-radius:50%;border:1px solid #60a5fa;display:flex;align-items:center;justify-content:center;font-size:10px;font-family:'JetBrains Mono',monospace;font-weight:500;">${number}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
    });
}

const editNodeIcon = L.divIcon({
    className: 'edit-node',
    html: '<div style="background:#fbbf24;width:10px;height:10px;border-radius:50%;border:1.5px solid rgba(0,0,0,0.5);box-shadow:0 0 5px rgba(251,191,36,0.7);"></div>',
    iconSize: [10, 10],
    iconAnchor: [5, 5],
});

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    ConnBar.init();
    Toast.init();

    State.map = L.map('map').setView([54.3520, 18.6466], 13);
    L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        attribution: '© Stadia Maps © OSM',
    }).addTo(State.map);
    State.missionLayer.addTo(State.map);
    State.drawingLayer.addTo(State.map);

    document.getElementById('sidebar-toggle').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('sidebar-open');
    });
    document.getElementById('mission-btn').addEventListener('click', handleMainButton);
    document.getElementById('generate-path-btn').addEventListener('click', generatePath);
    document.getElementById('clear-mission-btn').addEventListener('click', clearMission);
    document.getElementById('mission-type-select').addEventListener('change', (e) => {
        updateDrawingVisuals();
        toggleDensityControl(e.target.value);
    });
    document.getElementById('panel-close-btn').addEventListener('click', closeDronePanel);
    document.getElementById('follow-btn').addEventListener('click', toggleFollow);
    State.map.on('click', onMapClick);

    
    State.map.on('dragstart', () => {
        if (State.followMode) {
            State.followMode = false;
            updateFollowBtn();
        }
    });

    
    socket.on('connect',      () => ConnBar.set('connected'));
    socket.on('disconnect',   () => ConnBar.set('disconnected'));
    socket.on('reconnecting', () => ConnBar.set('connecting'));

    socket.on('telemetry_update', (drones) => {
        const now = Date.now();
        drones.forEach(d => {
            State.droneData[d.drone_id]    = d;
            State.droneLastSeen[d.drone_id] = now;
        });
        updateMap(drones);
        updateSidebar(drones);
        if (State.selectedDroneId) {
            const d = drones.find(x => x.drone_id === State.selectedDroneId);
            if (d) {
                updateDronePanel(d);
                updateHUD(d.roll, d.pitch, d.yaw);
                if (State.followMode && State.droneMarkers[State.selectedDroneId]) {
                    State.map.panTo(State.droneMarkers[State.selectedDroneId].getLatLng(), { animate: true, duration: 0.3 });
                }
            }
        }
    });

    setInterval(tickSignals, 1000);
});

// Signal tick 
function tickSignals() {
    const now = Date.now();

    for (const id in State.droneLastSeen) {
        const age = (now - State.droneLastSeen[id]) / 1000;

        if (State.droneMarkers[id]) {
            const selected = id === State.selectedDroneId;
            State.droneMarkers[id].setIcon(createDroneIcon(id, selected));
        }

        if (age > 30 && !State.droneInactiveAt[id]) {
            State.droneInactiveAt[id] = now;
        }

        if (State.droneInactiveAt[id]) {
            const inactiveAge = (now - State.droneInactiveAt[id]) / 1000;
            if (inactiveAge > 60) {
                removeDrone(id);
            }
        }
    }
}

function removeDrone(id) {
    if (State.droneMarkers[id]) {
        State.map.removeLayer(State.droneMarkers[id]);
        delete State.droneMarkers[id];
    }
    delete State.droneData[id];
    delete State.droneLastSeen[id];
    delete State.droneInactiveAt[id];

    document.querySelector(`.drone-item[data-drone-id="${id}"]`)?.remove();

    if (State.selectedDroneId === id) closeDronePanel();
    Toast.warn(`Dron ${id} is lost - no signal.`);
}

// Follow mode  
function toggleFollow() {
    State.followMode = !State.followMode;
    updateFollowBtn();
    if (State.followMode) Toast.info('Follow mode ON.');
}

function updateFollowBtn() {
    const btn = document.getElementById('follow-btn');
    if (!btn) return;
    if (State.followMode) {
        btn.classList.add('btn-accent');
        btn.classList.remove('btn-ghost');
        btn.innerText = '⊙ Following';
    } else {
        btn.classList.remove('btn-accent');
        btn.classList.add('btn-ghost');
        btn.innerText = '⊙ Follow drone';
    }
}

// Sidebar mission controls 
function toggleDensityControl(type) {
    document.getElementById('density-control').style.display = type === 'lawnmower' ? 'block' : 'none';
}

// Mission button state machine 
const BtnState = {
    NEW:    { text: 'New mission',      cls: 'btn btn-primary' },
    CANCEL: { text: 'Cancel',          cls: 'btn btn-ghost'   },
    UPLOAD: { text: 'Upload mission',     cls: 'btn btn-accent'  },
    UPDATE: { text: 'Update mission',cls: 'btn btn-accent'  },
    SENT:   { text: 'Sent ✓',       cls: 'btn btn-primary' },
};

function applyBtnState(state) {
    const btn = document.getElementById('mission-btn');
    btn.innerText  = state.text;
    btn.className  = state.cls;
}

function handleMainButton() {
    if (State.finalWaypoints.length > 0 && !State.isDrawingMode) uploadMission();
    else if (State.isDrawingMode) toggleDrawingMode(false);
    else toggleDrawingMode(true);
}

function toggleDrawingMode(enable) {
    State.isDrawingMode = enable;
    if (enable) {
        State.drawingMarkers = [];
        State.drawingLayer.clearLayers();
        State.missionLayer.clearLayers();
        State.finalWaypoints = [];
        applyBtnState(BtnState.CANCEL);
        document.getElementById('mission-info').innerText = 'Click on the map...';
        document.getElementById('clear-mission-btn').disabled = false;
        toggleDensityControl(document.getElementById('mission-type-select').value);
    } else {
        applyBtnState(BtnState.NEW);
        State.drawingLayer.clearLayers();
        document.getElementById('mission-info').innerText = '';
    }
}

// Drawing
function onMapClick(e) {
    if (!State.isDrawingMode) return;
    const marker = L.marker(e.latlng, { draggable: true, icon: editNodeIcon }).addTo(State.drawingLayer);
    State.drawingMarkers.push(marker);
    marker.on('drag', updateDrawingVisuals);
    updateDrawingVisuals();
}

function updateDrawingVisuals() {
    if (State.drawingMarkers.length === 0) return;
    const latlngs = State.drawingMarkers.map(m => m.getLatLng());
    if (State.drawingPolyline) State.drawingLayer.removeLayer(State.drawingPolyline);
    const type = document.getElementById('mission-type-select').value;
    State.drawingPolyline = (type === 'lawnmower' && latlngs.length > 2)
        ? L.polygon(latlngs, { color: '#fbbf24', dashArray: '5,8', fillOpacity: 0.08, weight: 1.5 }).addTo(State.drawingLayer)
        : L.polyline(latlngs, { color: '#fbbf24', dashArray: '5,8', weight: 1.5 }).addTo(State.drawingLayer);
}

// Path generation 
function generatePath() {
    if (State.drawingMarkers.length < 2) { Toast.warn('Min. 2 points!'); return; }
    const points = State.drawingMarkers.map(m => [m.getLatLng().lat, m.getLatLng().lng]);
    const type   = document.getElementById('mission-type-select').value;
    State.finalWaypoints = [];

    if (type === 'waypoints') {
        State.finalWaypoints = points;
    } else {
        if (points.length < 3) { Toast.warn('Min. 3 points for lawnmower!'); return; }
        const turfPoly  = turf.polygon([[...points, points[0]]].map(p => [p[1], p[0]]));
        const bbox      = turf.bbox(turfPoly);
        let dist = parseFloat(document.getElementById('scan-distance').value);
        if (isNaN(dist) || dist < 5) dist = 5;
        const centerLat = (bbox[1] + bbox[3]) / 2;
        const stepLat   = dist / 111132;
        const stepLon   = dist / (111132 * Math.cos(centerLat * Math.PI / 180));
        let toggle = false;
        for (let lat = bbox[1]; lat <= bbox[3]; lat += stepLat) {
            const row = [];
            for (let lon = bbox[0]; lon <= bbox[2]; lon += stepLon / 5) {
                if (turf.booleanPointInPolygon(turf.point([lon, lat]), turfPoly)) row.push([lat, lon]);
            }
            if (row.length > 1) {
                const seg = [row[0], row[row.length - 1]];
                if (toggle) seg.reverse();
                State.finalWaypoints.push(...seg);
                toggle = !toggle;
            } else if (row.length === 1) {
                State.finalWaypoints.push(row[0]);
            }
        }
        if (State.finalWaypoints.length === 0) State.finalWaypoints = points;
    }

    renderEditableMission();
    State.isDrawingMode = false;
    State.drawingLayer.clearLayers();
    applyBtnState(BtnState.UPLOAD);
    document.getElementById('mission-info').innerText = `${State.finalWaypoints.length} points.`;
}

function renderEditableMission() {
    State.missionLayer.clearLayers();
    State.missionPolyline = L.polyline(State.finalWaypoints, { color: '#60a5fa', weight: 2, opacity: 0.7, dashArray: '4,6' }).addTo(State.missionLayer);
    State.finalWaypoints.forEach((coords, i) => {
        const marker = L.marker(coords, { icon: createWaypointIcon(i + 1), draggable: true }).addTo(State.missionLayer);
        marker.on('drag', (e) => {
            State.finalWaypoints[i] = [e.target.getLatLng().lat, e.target.getLatLng().lng];
            State.missionPolyline.setLatLngs(State.finalWaypoints);
        });
        marker.on('dragend', () => applyBtnState(BtnState.UPDATE));
    });
}

// API calls 
async function apiFetch(url, options = {}) {
    try {
        const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
        if (res.status === 401) { location.reload(); return null; }
        if (res.status === 429) { Toast.warn('Rate limit — slow down.'); return null; }
        if (!res.ok) {
            const b = await res.json().catch(() => ({}));
            Toast.error(`Error ${res.status}: ${b.error ?? 'Unknown'}`);
            return null;
        }
        return await res.json();
    } catch {
        Toast.error('No connection to the server.');
        return null;
    }
}

async function uploadMission() {
    if (!State.selectedDroneId) { Toast.warn('Select a drone!'); return; }
    const payload = {
        drones: {
            [State.selectedDroneId]: {
                mission_id: `m_${Date.now()}`,
                waypoints:  State.finalWaypoints,
                role:       document.getElementById('mission-type-select').value,
            },
        },
    };
    const res = await apiFetch('/api/mission/upload', { method: 'POST', body: JSON.stringify(payload) });
    if (res) {
        applyBtnState(BtnState.SENT);
        Toast.success('Mission uploaded!');
        setTimeout(() => applyBtnState(BtnState.UPDATE), 2000);
    }
}

async function clearMission() {
    toggleDrawingMode(false);
    State.missionLayer.clearLayers();
    State.finalWaypoints = [];
    document.getElementById('clear-mission-btn').disabled = true;
    if (State.selectedDroneId && confirm(`STOP mission for ${State.selectedDroneId}?`)) {
        const res = await apiFetch('/api/mission/stop', {
            method: 'POST',
            body: JSON.stringify({ drones: [State.selectedDroneId] }),
        });
        if (res) Toast.info(`Mission stopped.`);
    }
}

async function addDrone(id) {
    const res = await apiFetch('/api/drone/add', { method: 'POST', body: JSON.stringify({ drone_id: id }) });
    if (res) Toast.success(`Drone ${id} added.`);
}

async function deleteDrone(id) {
    if (!confirm(`Delete drone ${id} from tracked?`)) return;
    const res = await apiFetch('/api/drone/delete', { method: 'POST', body: JSON.stringify({ drone_id: id }) });
    if (res && State.selectedDroneId === id) {
        State.selectedDroneId = null;
        document.getElementById('drone-panel').classList.add('hidden');
        State.missionLayer.clearLayers();
        State.finalWaypoints = [];
        Toast.info(`Drone ${id} deleted from tracked.`);
    }
}

// Map update 
function updateMap(drones) {
    const currentIds = new Set(drones.map(d => d.drone_id));
    for (const id in State.droneMarkers) {
        if (!currentIds.has(id)) {
            State.map.removeLayer(State.droneMarkers[id]);
            delete State.droneMarkers[id];
        }
    }
    drones.forEach(d => {
        const selected = d.drone_id === State.selectedDroneId;
        if (State.droneMarkers[d.drone_id]) {
            const marker = State.droneMarkers[d.drone_id];
            marker.setLatLng([d.lat, d.lon]);
            marker.setIcon(createDroneIcon(d.drone_id, selected));
            const body = marker.getElement()?.querySelector('.drone-body');
            if (body) body.style.transform = `rotate(${d.yaw}deg)`;
        } else {
            const m = L.marker([d.lat, d.lon], { icon: createDroneIcon(d.drone_id, selected) }).addTo(State.map);
            m.on('click', () => selectDrone(d.drone_id));
            State.droneMarkers[d.drone_id] = m;
        }
    });
}

// Drone selection 
function selectDrone(id) {
    State.selectedDroneId = id;
    State.followMode = true;
    document.getElementById('drone-panel').classList.remove('hidden');
    document.getElementById('panel-drone-id').innerText = id;
    updateFollowBtn();

    // immediate fill of the panel if we have data
    const d = State.droneData[id];
    if (d) { updateDronePanel(d); updateHUD(d.roll, d.pitch, d.yaw); }

    if (State.droneMarkers[id]) {
        State.map.flyTo(State.droneMarkers[id].getLatLng(), 17, { animate: true, duration: 1.0 });
    }

    document.querySelectorAll('.drone-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.droneId === id);
    });

    for (const mid in State.droneMarkers) {
        State.droneMarkers[mid].setIcon(createDroneIcon(mid, mid === id));
    }
}

function closeDronePanel() {
    document.getElementById('drone-panel').classList.add('hidden');
    const prev = State.selectedDroneId;
    State.selectedDroneId = null;
    State.followMode = false;
    updateFollowBtn();
    document.querySelectorAll('.drone-item').forEach(el => el.classList.remove('selected'));
    if (prev && State.droneMarkers[prev]) {
        State.droneMarkers[prev].setIcon(createDroneIcon(prev, false));
    }
}

// Sidebar 
function updateSidebar(drones) {
    const containers = {
        active:   document.getElementById('active-list'),
        inactive: document.getElementById('inactive-list'),
        detected: document.getElementById('detected-list'),
    };

    const incomingIds = new Set(drones.map(d => d.drone_id));
    document.querySelectorAll('.drone-item').forEach(el => {
        if (!incomingIds.has(el.dataset.droneId)) el.remove();
    });

    drones.forEach(d => {
        const age      = (Date.now() - (State.droneLastSeen[d.drone_id] || 0)) / 1000;
        const listType = d.is_tracked ? (age < 30 ? 'active' : 'inactive') : 'detected';
        const target   = containers[listType];
        let el         = document.querySelector(`.drone-item[data-drone-id="${d.drone_id}"]`);

        if (el && el.parentElement !== target) target.appendChild(el);

        if (!el) {
            el = document.createElement('div');
            el.className       = 'drone-item';
            el.dataset.droneId = d.drone_id;
            target.appendChild(el);
            el.addEventListener('click', () => selectDrone(d.drone_id));
        }

        el.dataset.tracked = d.is_tracked;
        el.classList.toggle('selected', d.drone_id === State.selectedDroneId);

        const color = signalColor(d.drone_id);
        const batColor = d.battery < 20 ? '#f87171' : d.battery < 40 ? '#fbbf24' : '#4ade80';

        el.innerHTML = `
            <div class="di-left">
                <span class="di-dot" style="background:${color};box-shadow:0 0 4px ${color}88;"></span>
                <div class="di-info">
                    <span class="di-id">${d.drone_id}</span>
                    <span class="di-meta">
                        BAT <span style="color:${batColor};font-weight:500">${d.battery ?? '—'}%</span>
                        &nbsp;·&nbsp;ALT ${d.alt != null ? Math.round(d.alt) + 'm' : '—'}
                        &nbsp;·&nbsp;HDG ${d.yaw != null ? Math.round(d.yaw) + '°' : '—'}
                    </span>
                    <span class="di-meta">${d.mission_display && d.mission_display !== 'brak' ? '📍 ' + d.mission_display : 'No mission'}</span>
                </div>
            </div>
            <button class="di-action" title="${d.is_tracked ? 'Remove from tracked' : 'Add'}" data-id="${d.drone_id}" data-tracked="${d.is_tracked}">
                ${d.is_tracked ? '✕' : '+'}
            </button>`;

        el.querySelector('.di-action').addEventListener('click', (e) => {
            e.stopPropagation();
            const tracked = e.currentTarget.dataset.tracked === 'true';
            tracked ? deleteDrone(d.drone_id) : addDrone(d.drone_id);
        });
    });

    [containers.active, containers.inactive, containers.detected].forEach(handleEmptyMessage);
}

function handleEmptyMessage(container) {
    const hasItems = container.querySelectorAll('.drone-item').length > 0;
    let msg = container.querySelector('.empty-msg');
    if (!hasItems && !msg) {
        msg = document.createElement('div');
        msg.className = 'empty-msg';
        msg.innerText = 'Brak';
        container.appendChild(msg);
    } else if (hasItems && msg) {
        msg.remove();
    }
}

// Drone panel 
function updateDronePanel(d) {
    // signal strength 
    const age   = Math.round((Date.now() - (State.droneLastSeen[d.drone_id] || Date.now())) / 1000);
    const color = signalColor(d.drone_id);
    const sigEl = document.getElementById('panel-signal');
    if (sigEl) {
        sigEl.style.background  = color;
        sigEl.style.boxShadow   = `0 0 6px ${color}`;
        sigEl.title             = `Last signal: ${age}s ago`;
    }
    const ageEl = document.getElementById('panel-age');
    if (ageEl) ageEl.innerText = age < 3 ? 'LIVE' : `${age}s ago`;

    // battery
    if (d.battery != null) {
        document.getElementById('sv-battery').innerText = d.battery;
        const badge = document.getElementById('sb-battery');
        if (badge) {
            badge.className = `sc-badge ${d.battery < 20 ? 'sc-badge-warn' : 'sc-badge-ok'}`;
            badge.innerText = d.battery < 20 ? 'LOW' : 'OK';
        }
    }

    if (d.alt   != null) document.getElementById('sv-alt').innerText  = Math.round(d.alt);
    if (d.yaw   != null) document.getElementById('sv-hdg').innerText  = Math.round(d.yaw);
    if (d.lat   != null) document.getElementById('sv-lat').innerText  = d.lat.toFixed(5);
    if (d.lon   != null) document.getElementById('sv-lon').innerText  = d.lon.toFixed(5);
    if (d.roll  != null) document.getElementById('sv-roll').innerText = d.roll.toFixed(1);
    if (d.pitch != null) document.getElementById('sv-pitch').innerText = d.pitch.toFixed(1);

    // mission and role
    const mVal  = d.mission_display || '—';
    const rVal  = d.server_assigned_role || '—';
    document.getElementById('sv-mission').innerText = mVal;
    document.getElementById('sv-role').innerText    = rVal.toUpperCase();
    const mBadge = document.getElementById('sb-mission');
    if (mBadge) {
        const active = mVal !== '—' && mVal !== 'no mission';
        mBadge.className = `sc-badge ${active ? 'sc-badge-ok' : 'sc-badge-na'}`;
        mBadge.innerText = active ? 'ACT' : '—';
    }
}

// HUD 
function updateHUD(roll, pitch, yaw) {
    const h  = document.getElementById('horizon-gradient');
    const cp = Math.max(-60, Math.min(60, pitch));
    h.style.transform = `rotate(${-roll}deg) translateY(${cp * 2.5}px)`;
    document.getElementById('hud-roll-pitch').innerText = `R:${Math.round(roll)} P:${Math.round(pitch)}`;
    document.getElementById('compass-needle-el').style.transform = `translateX(-50%) translateY(-100%) rotate(${-yaw}deg)`;
    document.getElementById('hud-yaw').innerText = `HDG:${Math.round(yaw)}°`;
}