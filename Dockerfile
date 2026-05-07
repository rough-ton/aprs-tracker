# ── Build stage ──────────────────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /build

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt


# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM python:3.12-slim

LABEL org.opencontainers.image.title="aprs-tracker"
LABEL org.opencontainers.image.description="APRS station tracker via aprs.fi"
LABEL org.opencontainers.image.source="https://github.com/YOUR_USERNAME/aprs-tracker"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=5050 \
    HOME=/home/aprs

# Non-root user with a real home directory so Gunicorn's master process
# can write its control socket without hitting /nonexistent
RUN addgroup --system aprs \
    && adduser --system --ingroup aprs --home /home/aprs aprs \
    && mkdir -p /home/aprs \
    && chown aprs:aprs /home/aprs

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy application source
COPY --chown=aprs:aprs app.py .
COPY --chown=aprs:aprs templates/ templates/
COPY --chown=aprs:aprs static/ static/

USER aprs

EXPOSE 5000

CMD ["gunicorn", \
     "--bind", "0.0.0.0:5050", \
     "--workers", "2", \
     "--timeout", "30", \
     "--worker-tmp-dir", "/tmp", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "app:app"]
