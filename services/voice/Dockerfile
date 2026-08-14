FROM python:3.12.12-slim-bookworm AS build
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
COPY services/voice/pyproject.toml ./
COPY services/voice/src ./src
RUN python -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir --upgrade pip==26.0.1 && /opt/venv/bin/pip install --no-cache-dir '.[speech]'

FROM python:3.12.12-slim-bookworm AS runtime
ENV PATH=/opt/venv/bin:$PATH
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app
RUN groupadd --system --gid 10001 aura && useradd --system --uid 10001 --gid aura aura
COPY --from=build --chown=aura:aura /opt/venv /opt/venv
USER aura
EXPOSE 8002
HEALTHCHECK --interval=15s --timeout=3s --start-period=120s --retries=10 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8002/ready', timeout=2)"
CMD ["aura-voice"]

