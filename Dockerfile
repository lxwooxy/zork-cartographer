# --- build dfrotz (the text-only Frotz interpreter) from source ---
FROM python:3.12-slim AS frotz
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch 2.54 https://gitlab.com/DavidGriffith/frotz.git /src \
 && make -C /src dumb \
 && strip /src/dfrotz

# --- app ---
FROM python:3.12-slim
COPY --from=frotz /src/dfrotz /usr/local/bin/dfrotz
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY game ./game
COPY server ./server
COPY web ./web
ENV ZORK_DATA=/data/world.json \
    PORT=8080 \
    PYTHONUNBUFFERED=1
WORKDIR /app/server
EXPOSE 8080
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
