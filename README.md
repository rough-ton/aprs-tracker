# APRS Tracker

A mobile-friendly Flask web app for tracking APRS stations via the aprs.fi API.

## Features

- **Map view** — Live station positions on a dark Leaflet map (CARTO Dark tiles)
- **Packet history** — Last 25 position packets shown on a mini-map + timeline list
- **Weather telemetry** — Temperature, pressure, humidity, wind, rain for WX stations
- **Settings** — Auto-refresh, metric/imperial units, saved callsigns
- **Mobile-first** — Responsive, safe-area-aware, touch-friendly

## Requirements

- Python 3.10+
- An [aprs.fi API key](https://aprs.fi/account/) (free account required)

## Setup

```bash
# Clone / unzip the project
cd aprs-tracker

# Create a virtual environment
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Configure your API key
cp .env.example .env
# Edit .env and set APRS_FI_API_KEY=<your key>

# Run (development)
export $(cat .env | xargs)
python app.py

# Or with gunicorn (production)
gunicorn -w 2 -b 0.0.0.0:5050 app:app
```

App will be available at `http://localhost:5050`.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | SPA index |
| GET | `/api/location?callsigns=CS1,CS2` | Current position data |
| GET | `/api/weather?callsigns=CS1,CS2` | Weather telemetry |
| GET | `/api/history?callsign=CS&limit=20` | Historical packets |
| GET | `/api/health` | Health check |

## Project Structure

```
aprs_tracker/
├── app.py                  # Flask app, API routes, aprs.fi integration
├── requirements.txt
├── .env.example
├── templates/
│   └── index.html          # Single-page app shell
└── static/
    ├── css/style.css       # Dark terminal-inspired theme
    └── js/app.js           # Map, history, weather, settings logic
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APRS_FI_API_KEY` | *(required)* | Your aprs.fi API key |
| `PORT` | `5050` | Port to listen on |
| `FLASK_DEBUG` | `0` | Set to `1` for debug mode |

## Notes

- aprs.fi free accounts are rate-limited; avoid polling faster than 60s
- Not all callsigns transmit weather telemetry — weather tab will say so
- History uses the `tail` parameter of the aprs.fi API (up to 100 packets)
