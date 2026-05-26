// ─── SocketIO — polling first (wymagane na Render free tier) ──────────────
const socket = io({
    transports: ['polling', 'websocket'],
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
});

// ─── Stan aplikacji ────────────────────────────────────────────────────────
const State = {
    map: null,
    droneMarkers: {},
    missionLayer: new L.LayerGroup(),
    drawingLayer: new L.LayerGroup(),
    isDrawingMode: false,
    drawingMarkers: [],
    drawingPolyline: null,
    finalWaypoints: [],
    missionPolyline: null,
    selectedDroneId: null,
};

// ─── Connection status bar ─────────────────────────────────────────────────
const ConnBar = {
    el: null, dot: null, label: null,

    init() {
        this.el    = document.getElementById('conn-bar');
        this.dot   = document.getElementById('conn-dot');
        this.label = document.getElementById('conn-label');
    },

    set(state) {
        // state: 'connecting' | 'connected' | 'disconnected'
        this.el.className = `conn-bar conn-${state}`;
        const labels = { connecting: 'ŁĄCZENIE...', connected: 'ONLINE', disconnected: 'BRAK POŁĄCZENIA' };
        this.label.innerText = labels[state] ?? state;
    },
};

// ─── Toast notifications ───────────────────────────────────────────────────
const Toast = {
    container: null,

    init() { this.container = document.getElementById('toast-container'); },

    show(message, type = 'info', duration = 3500) {
        // type: 'info' | 'success' | 'warn' | 'error'
        const t = document.createElement('div');
        t.className = `toast toast-${type}`;
        t.innerText = message;
        this.container.appendChild(t);

        // Wejście
        requestAnimationFrame(() => t.classList.add('toast-visible'));

        setTimeout(() => {
            t.classList.remove('toast-visible');
            t.addEventListener('transitionend', () => t.remove(), { once: true });
        }, duration);
    },

    success: (msg) => Toast.show(msg, 'success'),
    warn:    (msg) => Toast.show(msg, 'warn'),
    error:   (msg) => Toast.show(msg, 'error'),
    info:    (msg) => Toast.show(msg, 'info'),
};

// ─── Ikony ─────────────────────────────────────────────────────────────────
const getDroneIconHtml = (color) => `
    <div class="drone-body" style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;transition:transform 0.1s linear;">
        <svg viewBox="0 0 24 24" fill="${color}" stroke="rgba(0,0,0,0.6)" stroke-width="1"
             style="width:100%;height:100%;filter:drop-shadow(0 0 2px ${color}) drop-shadow(0 2px 4px rgba(0,0,0,0.7));">
            <path d="M12 2L4.5 20.29C4.24 20.89 4.75 21.54 5.4 21.37L12 19.5L18.6 21.37C19.25 21.54 19.76 20.89 19.5 20.29L12 2Z"/>
        </svg>
    </div>`;

function createDroneIcon(color = '#00ff6a') {
    return L.divIcon({ className: 'custom-drone-wrapper', html: getDroneIconHtml(color), iconSize: [32, 32], iconAnchor: [16, 16] });
}

function createWaypointIcon(number) {
    return L.divIcon({
        className: 'waypoint-marker',
        html: `<div style="background:rgba(0,170,255,0.15);color:#00aaff;width:22px;height:22px;border-radius:50%;border:1px solid #00aaff;display:flex;align-items:center;justify-content:center;font-size:10px;font-family:'Share Tech Mono',monospace;font-weight:bold;box-shadow:0 0 8px rgba(0,170,255,0.4);">${number}</div>`,
        iconSize: [22, 22], iconAnchor: [11, 11],
    });
}

const editNodeIcon = L.divIcon({
    className: 'edit-node',
    html: '<div style="background:#ffb800;width:10px;height:10px;border-radius:50%;border:1px solid rgba(0,0,0,0.5);box-shadow:0 0 6px rgba(255,184,0,0.6);"></div>',
    iconSize: [10, 10], iconAnchor: [5, 5],
});

// ─── Inicjalizacja ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    ConnBar.init();
    Toast.init();

    State.map = L.map('map').setView([54.3520, 18.6466], 13); // Gdańsk
    L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png', {
        maxZoom: 19, attribution: '© Stadia Maps © OSM',
    }).addTo(State.map);
    State.missionLayer.addTo(State.map);
    State.drawingLayer.addTo(State.map);

    // sidebar toggle
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
    State.map.on('click', onMapClick);

    // SocketIO events
    socket.on('connect',    () => ConnBar.set('connected'));
    socket.on('disconnect', () => ConnBar.set('disconnected'));
    socket.on('connecting', () => ConnBar.set('connecting'));
    socket.on('reconnecting', () => ConnBar.set('connecting'));

    socket.on('telemetry_update', (drones) => {
        updateMap(drones);
        updateSidebar(drones);
        if (State.selectedDroneId) {
            const d = drones.find(x => x.drone_id === State.selectedDroneId);
            if (d) { updateHUD(d.roll, d.pitch, d.yaw); updateDronePanel(d); }
        }
    });
});

// ─── UI helpers ────────────────────────────────────────────────────────────
function toggleDensityControl(type) {
    document.getElementById('density-control').style.display = (type === 'lawnmower') ? 'block' : 'none';
}

// ─── Mission button state machine ──────────────────────────────────────────
const BtnState = {
    NEW:    { text: 'NOWA MISJA',      bg: 'rgba(0,255,106,0.1)',  border: '#00c44f', color: '#00ff6a' },
    CANCEL: { text: 'ANULUJ',          bg: 'rgba(255,184,0,0.15)', border: '#ffb800', color: '#ffb800' },
    UPLOAD: { text: 'WGRAJ MISJĘ',     bg: 'rgba(0,170,255,0.1)',  border: '#00aaff', color: '#00aaff' },
    UPDATE: { text: 'AKTUALIZUJ MISJĘ',bg: 'rgba(255,184,0,0.1)',  border: '#ffb800', color: '#ffb800' },
    SENT:   { text: 'WYSŁANO ✓',       bg: 'rgba(0,255,106,0.15)', border: '#00ff6a', color: '#00ff6a' },
};

function applyBtnState(state) {
    const btn = document.getElementById('mission-btn');
    btn.innerText         = state.text;
    btn.style.background  = state.bg;
    btn.style.borderColor = state.border;
    btn.style.color       = state.color;
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
        document.getElementById('mission-info').innerText = 'TRYB RYSOWANIA...';
        document.getElementById('clear-mission-btn').disabled = false;
        toggleDensityControl(document.getElementById('mission-type-select').value);
    } else {
        applyBtnState(BtnState.NEW);
        State.drawingLayer.clearLayers();
        document.getElementById('mission-info').innerText = 'GOTOWE.';
    }
}

// ─── Drawing ───────────────────────────────────────────────────────────────
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
        ? L.polygon(latlngs, { color: '#ffb800', dashArray: '5, 8', fillOpacity: 0.1, weight: 1.5 }).addTo(State.drawingLayer)
        : L.polyline(latlngs, { color: '#ffb800', dashArray: '5, 8', weight: 1.5 }).addTo(State.drawingLayer);
}

// ─── Path generation ───────────────────────────────────────────────────────
function generatePath() {
    if (State.drawingMarkers.length < 2) { Toast.warn('Min. 2 punkty!'); return; }

    const points = State.drawingMarkers.map(m => [m.getLatLng().lat, m.getLatLng().lng]);
    const type   = document.getElementById('mission-type-select').value;
    State.finalWaypoints = [];

    if (type === 'waypoints') {
        State.finalWaypoints = points;
    } else if (type === 'lawnmower') {
        if (points.length < 3) { Toast.warn('Min. 3 punkty dla lawnmower!'); return; }

        const turfPoly = turf.polygon([[...points, points[0]].map(p => [p[1], p[0]])]);
        const bbox     = turf.bbox(turfPoly);

        let dist = parseFloat(document.getElementById('scan-distance').value);
        if (isNaN(dist) || dist < 5) { dist = 5; document.getElementById('scan-distance').value = 5; }

        // Poprawny przelicznik dla szerokości i długości geograficznej
        const centerLat   = (bbox[1] + bbox[3]) / 2;
        const stepLat     = dist / 111132;                          // stopnie szerokości
        const stepLon     = dist / (111132 * Math.cos(centerLat * Math.PI / 180)); // stopnie długości — fix!

        if (stepLat <= 0.000001 || stepLon <= 0.000001) return;

        let toggle = false;
        for (let lat = bbox[1]; lat <= bbox[3]; lat += stepLat) {
            const rowPoints = [];
            for (let lon = bbox[0]; lon <= bbox[2]; lon += stepLon / 5) {
                if (turf.booleanPointInPolygon(turf.point([lon, lat]), turfPoly))
                    rowPoints.push([lat, lon]);
            }
            if (rowPoints.length > 1) {
                const segment = [rowPoints[0], rowPoints[rowPoints.length - 1]];
                if (toggle) segment.reverse();
                State.finalWaypoints.push(...segment);
                toggle = !toggle;
            } else if (rowPoints.length === 1) {
                State.finalWaypoints.push(rowPoints[0]);
            }
        }
        if (State.finalWaypoints.length === 0) State.finalWaypoints = points;
    }

    renderEditableMission();
    State.isDrawingMode = false;
    State.drawingLayer.clearLayers();
    applyBtnState(BtnState.UPLOAD);
    document.getElementById('mission-info').innerText = `TRASA: ${State.finalWaypoints.length} PKT.`;
}

function renderEditableMission() {
    State.missionLayer.clearLayers();
    State.missionPolyline = L.polyline(State.finalWaypoints, { color: '#00aaff', weight: 2, opacity: 0.7, dashArray: '4, 6' }).addTo(State.missionLayer);
    State.finalWaypoints.forEach((coords, index) => {
        const marker = L.marker(coords, { icon: createWaypointIcon(index + 1), draggable: true }).addTo(State.missionLayer);
        marker.bindTooltip(`WP ${index + 1}`, { direction: 'top' });
        marker.on('drag', (e) => {
            State.finalWaypoints[index] = [e.target.getLatLng().lat, e.target.getLatLng().lng];
            State.missionPolyline.setLatLngs(State.finalWaypoints);
        });
        marker.on('dragend', () => applyBtnState(BtnState.UPDATE));
    });
}

// ─── API calls ─────────────────────────────────────────────────────────────
async function apiFetch(url, options = {}) {
    try {
        const res = await fetch(url, {
            headers: { 'Content-Type': 'application/json' },
            ...options,
        });
        if (res.status === 401) { location.reload(); return null; }
        if (res.status === 429) { Toast.warn('Za dużo żądań — zwolnij.'); return null; }
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            Toast.error(`Błąd ${res.status}: ${body.error ?? 'Nieznany błąd'}`);
            return null;
        }
        return await res.json();
    } catch (e) {
        Toast.error('Brak połączenia z serwerem.');
        console.error(e);
        return null;
    }
}

async function uploadMission() {
    if (!State.selectedDroneId) { Toast.warn('Wybierz drona!'); return; }
    const missionId = `m_${Date.now()}`;
    const payload   = {
        drones: {
            [State.selectedDroneId]: {
                mission_id: missionId,
                waypoints:  State.finalWaypoints,
                role:       document.getElementById('mission-type-select').value,
            },
        },
    };
    const res = await apiFetch('/api/mission/upload', { method: 'POST', body: JSON.stringify(payload) });
    if (res) {
        applyBtnState(BtnState.SENT);
        Toast.success('Misja wysłana!');
        setTimeout(() => applyBtnState(BtnState.UPDATE), 2000);
    }
}

async function clearMission() {
    toggleDrawingMode(false);
    State.missionLayer.clearLayers();
    State.finalWaypoints = [];
    if (State.selectedDroneId && confirm(`STOP misji dla ${State.selectedDroneId}?`)) {
        const res = await apiFetch('/api/mission/stop', {
            method: 'POST',
            body: JSON.stringify({ drones: [State.selectedDroneId] }),
        });
        if (res) Toast.info(`Misja zatrzymana dla ${State.selectedDroneId}.`);
    }
}

async function addDrone(id) {
    const res = await apiFetch('/api/drone/add', { method: 'POST', body: JSON.stringify({ drone_id: id }) });
    if (res) Toast.success(`Dron ${id} dodany do śledzonych.`);
}

async function deleteDrone(id) {
    if (!confirm(`Przenieść drona ${id} do wykrytych?`)) return;
    const res = await apiFetch('/api/drone/delete', { method: 'POST', body: JSON.stringify({ drone_id: id }) });
    if (res && State.selectedDroneId === id) {
        State.selectedDroneId = null;
        document.getElementById('gauges-container').classList.add('hidden');
        document.getElementById('drone-panel').classList.add('hidden');
        State.missionLayer.clearLayers();
        State.finalWaypoints = [];
        Toast.info(`Dron ${id} przeniesiony do wykrytych.`);
    }
}

// ─── Map update ────────────────────────────────────────────────────────────
function updateMap(drones) {
    const currentIds = new Set(drones.map(d => d.drone_id));

    // Usuń markery dronów których już nie ma
    for (const id in State.droneMarkers) {
        if (!currentIds.has(id)) {
            State.map.removeLayer(State.droneMarkers[id]);
            delete State.droneMarkers[id];
        }
    }

    drones.forEach(d => {
        if (State.droneMarkers[d.drone_id]) {
            const marker = State.droneMarkers[d.drone_id];
            marker.setLatLng([d.lat, d.lon]);
            const body = marker.getElement()?.querySelector('.drone-body');
            if (body) body.style.transform = `rotate(${d.yaw}deg)`;
            marker.setOpacity(d.is_tracked ? 1.0 : 0.6);
            if (marker.isPopupOpen()) {
                marker.setPopupContent(`<b>${d.drone_id}</b><br>Misja: ${d.mission_display || '-'}<br>Rola: ${d.server_assigned_role || '-'}<br>Bat: ${d.battery}%`);
            }
        } else {
            const m = L.marker([d.lat, d.lon], { icon: createDroneIcon(d.is_tracked ? '#00ff6a' : '#4a6655') }).addTo(State.map);
            m.on('click', () => selectDrone(d.drone_id));
            m.bindPopup(`<b>${d.drone_id}</b>`);
            m.setOpacity(d.is_tracked ? 1.0 : 0.5);
            State.droneMarkers[d.drone_id] = m;
        }
    });
}

// ─── Drone selection ───────────────────────────────────────────────────────
function selectDrone(id) {
    State.selectedDroneId = id;
    document.getElementById('gauges-container').classList.remove('hidden');
    document.getElementById('drone-panel').classList.remove('hidden');
    document.getElementById('panel-drone-id').innerText = id;
    if (State.droneMarkers[id]) {
        State.map.flyTo(State.droneMarkers[id].getLatLng(), 18, { animate: true, duration: 1.5 });
    }
}

function closeDronePanel() {
    document.getElementById('drone-panel').classList.add('hidden');
    document.getElementById('gauges-container').classList.add('hidden');
    State.selectedDroneId = null;
}

// ─── Sidebar ───────────────────────────────────────────────────────────────
function updateSidebar(drones) {
    const containers = {
        active:   document.getElementById('active-list'),
        inactive: document.getElementById('inactive-list'),
        detected: document.getElementById('detected-list'),
    };

    const incomingIds = new Set(drones.map(d => d.drone_id));
    document.querySelectorAll('.item').forEach(el => {
        if (!incomingIds.has(el.id.replace('item-', ''))) el.remove();
    });

    drones.forEach(d => {
        const listType        = d.is_tracked ? (d.online ? 'active' : 'inactive') : 'detected';
        const targetContainer = containers[listType];
        let el                = document.getElementById(`item-${d.drone_id}`);

        if (el && el.parentElement !== targetContainer) targetContainer.appendChild(el);

        if (!el) {
            el = document.createElement('div');
            el.id      = `item-${d.drone_id}`;
            el.onclick = () => selectDrone(d.drone_id);
            targetContainer.appendChild(el);
            el.innerHTML = `
                <div class="item-content">
                    <div style="flex-grow:1;">
                        <div style="display:flex;justify-content:space-between;align-items:center;">
                            <span class="d-id"></span>
                            <span class="stat-dot"></span>
                        </div>
                        <div class="d-meta">
                            <div>MSN <span class="d-mission">—</span></div>
                            <div>ROLA <span class="d-role">—</span></div>
                            <div>BAT <span class="d-bat">—</span></div>
                        </div>
                    </div>
                    <button class="list-btn action-btn"></button>
                </div>`;

            el.querySelector('.action-btn').onclick = (e) => {
                e.stopPropagation();
                (el.dataset.tracked === 'true') ? deleteDrone(d.drone_id) : addDrone(d.drone_id);
            };
        }

        el.dataset.tracked = d.is_tracked;
        el.className       = `item ${listType} ${d.drone_id === State.selectedDroneId ? 'selected' : ''}`;

        el.querySelector('.d-id').innerText          = d.drone_id;
        el.querySelector('.stat-dot').style.backgroundColor = d.online ? '#00ff6a' : '#ff3c3c';
        el.querySelector('.d-mission').innerText     = d.mission_display || 'brak';
        el.querySelector('.d-role').innerText        = d.server_assigned_role || 'brak';

        const batSpan        = el.querySelector('.d-bat');
        batSpan.innerText    = `${d.battery}%`;
        batSpan.style.color  = d.battery < 20 ? '#ff3c3c' : d.battery < 40 ? '#ffb800' : '#00ff6a';

        const btn = el.querySelector('.action-btn');
        if (d.is_tracked) {
            btn.innerText  = '🗑️'; btn.title = 'Przenieś do wykrytych';
            btn.className  = 'list-btn btn-delete action-btn';
        } else {
            btn.innerText  = '➕'; btn.title = 'Dodaj drona';
            btn.className  = 'list-btn btn-add action-btn';
        }
    });

    [containers.active, containers.inactive, containers.detected].forEach(handleEmptyMessage);
}

function handleEmptyMessage(container) {
    const hasItems = container.querySelectorAll('.item').length > 0;
    let msg        = container.querySelector('.empty-msg');
    if (!hasItems && !msg) {
        msg = document.createElement('div');
        msg.className  = 'empty-msg';
        msg.innerHTML  = '<em>Brak</em>';
        msg.style.cssText = 'padding:10px;color:#888;';
        container.appendChild(msg);
    } else if (hasItems && msg) {
        msg.remove();
    }
}

// ─── Drone panel ───────────────────────────────────────────────────────────
function updateDronePanel(d) {
    const bat = d.battery ?? null;
    if (bat !== null) {
        document.getElementById('sv-battery').innerText = bat;
        const card  = document.getElementById('sensor-battery');
        const badge = card.querySelector('.sensor-badge');
        if (bat < 20) {
            card.className   = 'sensor-card warning';
            badge.className  = 'sensor-badge badge-warn';
            badge.innerText  = 'LOW';
        } else {
            card.className   = 'sensor-card available';
            badge.className  = 'sensor-badge badge-ok';
            badge.innerText  = 'OK';
        }
    }

    if (d.alt  != null) document.getElementById('sv-alt').innerText = Math.round(d.alt);
    if (d.yaw  != null) document.getElementById('sv-hdg').innerText = Math.round(d.yaw);

    const missionVal = d.mission_display || '—';
    const roleVal    = d.server_assigned_role || '—';
    document.getElementById('sv-mission').innerText = missionVal;
    document.getElementById('sv-role').innerText    = roleVal.toUpperCase();

    const mCard  = document.getElementById('sensor-mission');
    const mBadge = document.getElementById('sb-mission');
    const active = missionVal !== '—' && missionVal !== 'brak';
    mCard.className  = active ? 'sensor-card available' : 'sensor-card unavailable';
    mBadge.className = active ? 'sensor-badge badge-ok' : 'sensor-badge badge-na';
    mBadge.innerText = active ? 'ACT' : '—';

    // Kamera (MJPEG stream)
    const camUrl      = d.cam_url || null;
    const statusLabel = document.getElementById('cam-status-label');
    const dot         = document.querySelector('.cam-status-dot');
    const placeholder = document.getElementById('cam-placeholder');
    const video       = document.getElementById('cam-video');
    let camImg        = document.getElementById('cam-img');

    if (d.has_camera && camUrl) {
        statusLabel.innerText     = 'LIVE';
        dot.style.background      = '#00ff6a';
        dot.style.boxShadow       = '0 0 6px #00ff6a';
        placeholder.style.display = 'none';
        video.style.display       = 'none';

        if (!camImg) {
            camImg = document.createElement('img');
            camImg.id            = 'cam-img';
            camImg.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;position:absolute;top:0;left:0;';
            document.getElementById('camera-feed').insertBefore(camImg, document.querySelector('.camera-overlay'));
        }
        if (camImg.dataset.droneId !== d.drone_id) {
            camImg.src             = camUrl;
            camImg.dataset.droneId = d.drone_id;
            camImg.style.display   = 'block';
            camImg.onerror = () => {
                statusLabel.innerText     = 'NO SIGNAL';
                dot.style.background      = '#ff3c3c';
                dot.style.boxShadow       = '';
                placeholder.style.display = '';
                camImg.style.display      = 'none';
            };
        }
    } else {
        statusLabel.innerText     = 'NO SIGNAL';
        dot.style.background      = '#ff3c3c';
        dot.style.boxShadow       = '';
        placeholder.style.display = '';
        if (camImg) camImg.style.display = 'none';
    }
}

// ─── HUD ───────────────────────────────────────────────────────────────────
function updateHUD(roll, pitch, yaw) {
    const h   = document.getElementById('horizon-gradient');
    const cp  = Math.max(-60, Math.min(60, pitch));
    h.style.transform = `rotate(${-roll}deg) translateY(${cp * 2.5}px)`;
    document.getElementById('hud-roll-pitch').innerText  = `R:${Math.round(roll)} P:${Math.round(pitch)}`;
    document.getElementById('compass-needle-el').style.transform = `translateX(-50%) rotate(${-yaw}deg)`;
    document.getElementById('hud-yaw').innerText         = `HDG:${Math.round(yaw)}`;
}