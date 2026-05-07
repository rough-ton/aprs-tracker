"""
APRS Tracker - Flask web application for displaying APRS data via aprs.fi API.
"""

import os
import logging
from functools import lru_cache
from typing import Any

import requests
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

APRS_FI_BASE_URL = "https://api.aprs.fi/api/get"
APRS_FI_API_KEY = os.environ.get("APRS_FI_API_KEY", "")
REQUEST_TIMEOUT = 10


def build_aprs_params(callsigns: list[str], what: str = "loc") -> dict[str, str]:
    """Build query parameters for the aprs.fi API.

    Args:
        callsigns: List of amateur radio callsigns to query.
        what: Data type to fetch. One of 'loc', 'wx', 'msg'.

    Returns:
        Dictionary of query parameters for the API request.
    """
    return {
        "name": ",".join(callsigns),
        "what": what,
        "apikey": APRS_FI_API_KEY,
        "format": "json",
    }


def fetch_aprs_data(callsigns: list[str], what: str = "loc") -> dict[str, Any]:
    """Fetch data from the aprs.fi API.

    Args:
        callsigns: List of callsigns to query.
        what: Data type: 'loc' for position, 'wx' for weather.

    Returns:
        Parsed JSON response from the API.

    Raises:
        ValueError: If the API key is not configured.
        requests.HTTPError: If the API returns a non-2xx status.
        requests.RequestException: On network or timeout errors.
    """
    if not APRS_FI_API_KEY:
        raise ValueError("APRS_FI_API_KEY environment variable is not set.")

    params = build_aprs_params(callsigns, what)
    logger.info(f"Fetching APRS '{what}' data for: {callsigns}")

    response = requests.get(APRS_FI_BASE_URL, params=params, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()

    data = response.json()
    if data.get("result") == "fail":
        raise ValueError(f"aprs.fi API error: {data.get('description', 'Unknown error')}")

    return data


def parse_location_entry(entry: dict[str, Any]) -> dict[str, Any]:
    """Normalize a single location entry from the aprs.fi API response.

    Args:
        entry: Raw entry dict from the aprs.fi 'loc' response.

    Returns:
        Normalized dict with consistent field names and types.
    """
    return {
        "callsign": entry.get("name", ""),
        "lat": float(entry.get("lat", 0)),
        "lng": float(entry.get("lng", 0)),
        "altitude": float(entry.get("altitude", 0)),
        "speed": float(entry.get("speed", 0)),
        "course": float(entry.get("course", 0)),
        "symbol": entry.get("symbol", ""),
        "comment": entry.get("comment", ""),
        "path": entry.get("path", ""),
        "srccall": entry.get("srccall", ""),
        "dstcall": entry.get("dstcall", ""),
        "lasttime": int(entry.get("lasttime", 0)),
        "time": int(entry.get("time", 0)),
    }


def parse_wx_entry(entry: dict[str, Any]) -> dict[str, Any]:
    """Normalize a single weather entry from the aprs.fi API response.

    Args:
        entry: Raw entry dict from the aprs.fi 'wx' response.

    Returns:
        Normalized dict with consistent weather field names and types.
    """
    def safe_float(val: Any, default: float = 0.0) -> float | None:
        """Convert value to float, returning None if not present."""
        if val is None or val == "":
            return None
        try:
            return float(val)
        except (ValueError, TypeError):
            return default

    return {
        "callsign": entry.get("name", ""),
        "lasttime": int(entry.get("lasttime", 0)),
        "temp": safe_float(entry.get("temp")),
        "pressure": safe_float(entry.get("pressure")),
        "humidity": safe_float(entry.get("humidity")),
        "wind_direction": safe_float(entry.get("wind_direction")),
        "wind_speed": safe_float(entry.get("wind_speed")),
        "wind_gust": safe_float(entry.get("wind_gust")),
        "rain_1h": safe_float(entry.get("rain_1h")),
        "rain_24h": safe_float(entry.get("rain_24h")),
        "rain_mn": safe_float(entry.get("rain_mn")),
        "luminosity": safe_float(entry.get("luminosity")),
    }


@app.route("/")
def index() -> str:
    """Render the main single-page application.

    Returns:
        Rendered HTML template.
    """
    return render_template("index.html")


@app.route("/api/location")
def api_location() -> tuple[Any, int]:
    """Return current position data for one or more callsigns.

    Query Parameters:
        callsigns: Comma-separated list of callsigns (required).

    Returns:
        JSON response with location data or error message.
    """
    raw = request.args.get("callsigns", "").strip()
    if not raw:
        return jsonify({"error": "Missing 'callsigns' query parameter."}), 400

    callsigns = [cs.strip().upper() for cs in raw.split(",") if cs.strip()]
    if not callsigns:
        return jsonify({"error": "No valid callsigns provided."}), 400

    try:
        data = fetch_aprs_data(callsigns, what="loc")
        entries = [parse_location_entry(e) for e in data.get("entries", [])]
        return jsonify({"ok": True, "count": len(entries), "entries": entries})
    except ValueError as exc:
        logger.warning(f"Location fetch config error: {exc}")
        return jsonify({"error": str(exc)}), 400
    except requests.HTTPError as exc:
        logger.error(f"aprs.fi HTTP error: {exc}")
        return jsonify({"error": f"Upstream API error: {exc.response.status_code}"}), 502
    except requests.RequestException as exc:
        logger.error(f"Network error fetching location: {exc}")
        return jsonify({"error": "Network error contacting aprs.fi."}), 503


@app.route("/api/weather")
def api_weather() -> tuple[Any, int]:
    """Return weather telemetry for one or more callsigns.

    Query Parameters:
        callsigns: Comma-separated list of callsigns (required).

    Returns:
        JSON response with weather data or error message.
    """
    raw = request.args.get("callsigns", "").strip()
    if not raw:
        return jsonify({"error": "Missing 'callsigns' query parameter."}), 400

    callsigns = [cs.strip().upper() for cs in raw.split(",") if cs.strip()]
    if not callsigns:
        return jsonify({"error": "No valid callsigns provided."}), 400

    try:
        data = fetch_aprs_data(callsigns, what="wx")
        entries = [parse_wx_entry(e) for e in data.get("entries", [])]
        return jsonify({"ok": True, "count": len(entries), "entries": entries})
    except ValueError as exc:
        logger.warning(f"Weather fetch config error: {exc}")
        return jsonify({"error": str(exc)}), 400
    except requests.HTTPError as exc:
        logger.error(f"aprs.fi HTTP error: {exc}")
        return jsonify({"error": f"Upstream API error: {exc.response.status_code}"}), 502
    except requests.RequestException as exc:
        logger.error(f"Network error fetching weather: {exc}")
        return jsonify({"error": "Network error contacting aprs.fi."}), 503


@app.route("/api/history")
def api_history() -> tuple[Any, int]:
    """Return packet history (last positions) for a single callsign.

    Query Parameters:
        callsign: Single callsign to query (required).
        limit: Max number of historical entries to return (default 20, max 100).

    Returns:
        JSON response with history entries or error message.
    """
    callsign = request.args.get("callsign", "").strip().upper()
    if not callsign:
        return jsonify({"error": "Missing 'callsign' query parameter."}), 400

    try:
        limit = min(int(request.args.get("limit", 20)), 100)
    except ValueError:
        return jsonify({"error": "'limit' must be an integer."}), 400

    if not APRS_FI_API_KEY:
        return jsonify({"error": "APRS_FI_API_KEY environment variable is not set."}), 400

    params = {
        "name": callsign,
        "what": "loc",
        "apikey": APRS_FI_API_KEY,
        "format": "json",
        "tail": str(limit),
    }

    try:
        logger.info(f"Fetching history for {callsign}, limit={limit}")
        response = requests.get(APRS_FI_BASE_URL, params=params, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        data = response.json()
        if data.get("result") == "fail":
            raise ValueError(f"aprs.fi error: {data.get('description', 'Unknown')}")
        entries = [parse_location_entry(e) for e in data.get("entries", [])]
        return jsonify({"ok": True, "callsign": callsign, "count": len(entries), "entries": entries})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except requests.HTTPError as exc:
        return jsonify({"error": f"Upstream API error: {exc.response.status_code}"}), 502
    except requests.RequestException as exc:
        return jsonify({"error": "Network error contacting aprs.fi."}), 503


@app.route("/api/health")
def health() -> tuple[Any, int]:
    """Simple health check endpoint.

    Returns:
        JSON status response.
    """
    return jsonify({"status": "ok", "api_key_configured": bool(APRS_FI_API_KEY)})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)
