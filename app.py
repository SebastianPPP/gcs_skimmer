from gevent import monkey
monkey.patch_all()

import os
import time
import logging
from datetime import datetime, timezone
from functools import wraps

from flask import Flask, request, jsonify, render_template, Response
from flask_socketio import SocketIO
from flask_sqlalchemy import SQLAlchemy
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy import text

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("gcs")

# ---------------------------------------------------------------------------
# App + config
# ---------------------------------------------------------------------------
app = Flask(__name__)

# --- wymagane env vars (brak → crash przy starcie, nie cichy default) ---
def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"Brakuje zmiennej środowiskowej: {name}. "
            "Ustaw ją przed uruchomieniem serwera."
        )
    return value

app.config["SECRET_KEY"]        = _require_env("SECRET_KEY")
app.config["SQLALCHEMY_DATABASE_URI"] = _require_env("DATABASE_URL")
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
    "pool_pre_ping": True,       # weryfikuj połączenie przed użyciem
    "pool_recycle": 300,         # odśwież co 5 minut
    "pool_size": 5,
    "max_overflow": 10,
}
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["PROPAGATE_EXCEPTIONS"] = True

ADMIN_USER    = _require_env("ADMIN_USER")
ADMIN_PASS    = _require_env("ADMIN_PASS")
DRONE_API_KEY = _require_env("DRONE_API_KEY")

# ---------------------------------------------------------------------------
# Extensions
# ---------------------------------------------------------------------------
db = SQLAlchemy(app)

socketio = SocketIO(
    app,
    cors_allowed_origins=os.environ.get("CORS_ORIGINS", "*"),
    async_mode="gevent",
    ping_timeout=20,
    ping_interval=10,
    allow_upgrades=True,
    logger=False,
    engineio_logger=False,
)

limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=[],          # limity tylko tam gdzie chcemy
    storage_uri=os.environ.get("REDIS_URL", "memory://"),
)

# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------
class Drone(db.Model):
    __tablename__ = "drones"

    drone_id        = db.Column(db.String(64),  primary_key=True)
    assigned_role   = db.Column(db.String(64),  nullable=False, default="None")
    current_mission = db.Column(JSONB,          nullable=True)
    telemetry       = db.Column(JSONB,          nullable=True)
    is_tracked      = db.Column(db.Boolean,     nullable=False, default=False)
    last_seen       = db.Column(db.Float,       nullable=False, default=0.0)
    created_at      = db.Column(db.DateTime(timezone=True),
                                nullable=False,
                                default=lambda: datetime.now(timezone.utc))
    updated_at      = db.Column(db.DateTime(timezone=True),
                                nullable=False,
                                default=lambda: datetime.now(timezone.utc),
                                onupdate=lambda: datetime.now(timezone.utc))

    def is_online(self) -> bool:
        return (time.time() - self.last_seen) < 15

    def to_snapshot(self) -> dict | None:
        """Zwraca słownik gotowy do wysłania przez WebSocket."""
        if not self.telemetry:
            return None

        snap = dict(self.telemetry)

        role = self.assigned_role
        snap["server_assigned_role"] = "brak" if role == "None" else role

        mission = self.current_mission
        target_wp = snap.get("target_wp", 0)

        if mission:
            if target_wp == 999:
                wp_display = "KONIEC"
            elif target_wp > 0:
                wp_display = str(target_wp)
            else:
                wp_display = "-"
            snap["mission_display"] = f"{mission['id']} / {wp_display}"
        else:
            snap["mission_display"] = "brak"

        snap["online"]     = self.is_online()
        snap["is_tracked"] = self.is_tracked
        return snap

# ---------------------------------------------------------------------------
# Emit throttle
#
# Zamiast emitować synchronicznie przy każdym POST /api/telemetry,
# używamy dirty-flag + background loop @ 5 Hz.
# ---------------------------------------------------------------------------
_dirty = False

def mark_dirty():
    global _dirty
    _dirty = True

def _emit_loop():
    """Background task: emituje snapshot co 200 ms jeśli coś się zmieniło."""
    while True:
        socketio.sleep(0.2)
        global _dirty
        if not _dirty:
            continue
        _dirty = False
        try:
            with app.app_context():
                _push_snapshot()
        except Exception:
            logging.getLogger("gcs").exception("Błąd w emit loop")

def _push_snapshot():
    drones = Drone.query.all()
    snapshots = [s for d in drones if (s := d.to_snapshot()) is not None]
    socketio.emit("telemetry_update", snapshots)

# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
def _check_admin(username: str, password: str) -> bool:
    return username == ADMIN_USER and password == ADMIN_PASS

def requires_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.authorization
        if not auth or not _check_admin(auth.username, auth.password):
            return Response(
                "Błędne dane logowania.\n", 401,
                {"WWW-Authenticate": 'Basic realm="GCS Login"'},
            )
        return f(*args, **kwargs)
    return decorated

def requires_drone_token(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get("X-Drone-Token")
        if token != DRONE_API_KEY:
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated

# ---------------------------------------------------------------------------
# Routes — UI
# ---------------------------------------------------------------------------
@app.route("/")
@requires_auth
def index():
    return render_template("index.html")

# ---------------------------------------------------------------------------
# Routes — Drone API
# ---------------------------------------------------------------------------
@app.route("/api/telemetry", methods=["POST"])
@requires_drone_token
@limiter.limit("120/minute")        # max 2 req/s na drona przy 1 IP
def receive_telemetry():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid JSON"}), 400

    drone_id = data.get("drone_id")
    if not drone_id:
        return jsonify({"error": "Missing drone_id"}), 400

    try:
        safe_wp = int(data.get("target_wp", 0))
    except (TypeError, ValueError):
        safe_wp = 0

    drone = db.session.get(Drone, drone_id)
    if drone is None:
        drone = Drone(drone_id=drone_id)
        db.session.add(drone)

    drone.telemetry = {
        "drone_id": drone_id,
        "lat":      data.get("lat"),
        "lon":      data.get("lon"),
        "alt":      data.get("alt", 0),
        "battery":  data.get("battery", 0),
        "roll":     data.get("roll", 0),
        "pitch":    data.get("pitch", 0),
        "yaw":      data.get("yaw", 0),
        "target_wp": safe_wp,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    drone.last_seen = time.time()

    db.session.commit()
    mark_dirty()

    return jsonify({
        "role":    drone.assigned_role,
        "mission": drone.current_mission,
    }), 200

# ---------------------------------------------------------------------------
# Routes — Admin API
# ---------------------------------------------------------------------------
@app.route("/api/drones", methods=["GET"])
@requires_auth                      # było publiczne — teraz wymaga loginu
def get_all_drones():
    drones = Drone.query.all()
    snapshots = [s for d in drones if (s := d.to_snapshot()) is not None]
    return jsonify(snapshots), 200

@app.route("/api/init_state", methods=["GET"])
@requires_auth
def get_init_state():
    with app.app_context():
        _push_snapshot()
    return jsonify({"status": "ok"})

@app.route("/api/drone/add", methods=["POST"])
@requires_auth
def add_drone():
    data = request.get_json(silent=True) or {}
    drone_id = data.get("drone_id")

    drone = db.session.get(Drone, drone_id)
    if drone is None:
        return jsonify({"error": "Not found"}), 404

    drone.is_tracked = True
    db.session.commit()
    mark_dirty()
    return jsonify({"status": "ADDED"})

@app.route("/api/drone/delete", methods=["POST"])
@requires_auth
def delete_drone():
    data = request.get_json(silent=True) or {}
    drone_id = data.get("drone_id")

    drone = db.session.get(Drone, drone_id)
    if drone is None:
        return jsonify({"error": "Not found"}), 404

    drone.is_tracked      = False
    drone.current_mission = None
    drone.assigned_role   = "None"
    db.session.commit()
    mark_dirty()
    return jsonify({"status": "UNTRACKED"})

@app.route("/api/mission/upload", methods=["POST"])
@requires_auth
def upload_mission():
    data = request.get_json(silent=True) or {}
    drones_payload = data.get("drones", {})

    for drone_id, mission_config in drones_payload.items():
        drone = db.session.get(Drone, drone_id)
        if drone is None:
            drone = Drone(drone_id=drone_id)
            db.session.add(drone)

        drone.is_tracked      = True
        drone.current_mission = {
            "id":        mission_config.get("mission_id"),
            "waypoints": mission_config.get("waypoints"),
        }
        if "role" in mission_config:
            drone.assigned_role = mission_config["role"]

    db.session.commit()
    mark_dirty()
    return jsonify({"status": "STORED"})

@app.route("/api/mission/stop", methods=["POST"])
@requires_auth
def stop_mission():
    data = request.get_json(silent=True) or {}
    target_ids = data.get("drones", [])

    query = Drone.query
    if target_ids:
        query = query.filter(Drone.drone_id.in_(target_ids))

    for drone in query.all():
        drone.current_mission = None
        drone.assigned_role   = "None"

    db.session.commit()
    mark_dirty()
    return jsonify({"status": "STOPPED"})

# ---------------------------------------------------------------------------
# Health check (bez auth — dla load balancerów / Docker healthcheck)
# ---------------------------------------------------------------------------
@app.route("/health")
def health():
    try:
        db.session.execute(text("SELECT 1"))
        return jsonify({"status": "ok", "db": "up"}), 200
    except Exception as e:
        logging.getLogger("gcs").error("Health check failed: %s", e)
        return jsonify({"status": "error", "db": "down"}), 503

# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------
@app.errorhandler(429)
def ratelimit_handler(e):
    return jsonify({"error": "Too Many Requests", "detail": str(e.description)}), 429

@app.errorhandler(500)
def internal_error(e):
    db.session.rollback()
    logging.getLogger("gcs").exception("Internal server error")
    return jsonify({"error": "Internal Server Error"}), 500

# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------
def create_tables():
    with app.app_context():
        db.create_all()
        logging.getLogger("gcs").info("Tabele gotowe.")

if __name__ == "__main__":
    create_tables()
    socketio.start_background_task(_emit_loop)
    socketio.run(
        app,
        host="0.0.0.0",
        port=5000,
        debug=os.environ.get("FLASK_DEBUG", "0") == "1",
        allow_unsafe_werkzeug=True,
    )
else:
    create_tables()
    socketio.start_background_task(_emit_loop)