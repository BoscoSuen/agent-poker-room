# PokerSkill prompt sidecar (lbn187/PokerSkill, CC BY-NC 4.0). Exposes POST /prompt -> {system_prompt, user_prompt}.
FROM python:3.9-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG POKERSKILL_REF=main
RUN git clone --depth 1 https://github.com/lbn187/PokerSkill.git /app && pip install --no-cache-dir -e /app
COPY server.py /srv/server.py
EXPOSE 8321
ENTRYPOINT ["python", "/srv/server.py"]
