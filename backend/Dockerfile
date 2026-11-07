FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.lock ./
RUN pip install --no-cache-dir "pip>=26.2,<27" && pip install --no-cache-dir -r requirements.lock
COPY pyproject.toml ./
COPY app ./app
COPY voice ./voice
RUN pip install --no-cache-dir --no-deps . && useradd --create-home app && mkdir -p /data && chown app:app /data
USER app
EXPOSE 8000
CMD ["uvicorn", "app.agent_service:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
