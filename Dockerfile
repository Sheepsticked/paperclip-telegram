# The app files only; every target starts from here.
FROM node:22-bookworm-slim AS app
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY scripts/transcribe.py ./scripts/transcribe.py

# Node only, no Python.
FROM app AS bot
USER node
ENTRYPOINT ["node", "/app/bin/paperclip-telegram.js"]

# The bot plus local speech-to-text: a Python venv with the Whisper model, so it works offline.
FROM bot AS voice
ARG WHISPER_MODEL=small
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/install-voice.sh /tmp/install-voice.sh
RUN PIP_NO_CACHE_DIR=1 VOICE_DIR=/opt/voice WHISPER_MODEL="$WHISPER_MODEL" bash /tmp/install-voice.sh \
    && chmod -R a+rX /opt/voice \
    && rm /tmp/install-voice.sh
USER node

# The last stage, so a plain `docker build .` gives the bot image even with the classic builder.
FROM bot AS default
