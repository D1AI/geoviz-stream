FROM python:3.11-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir aiokafka==0.10.0 asyncpg==0.29.0 ujson==5.10.0

COPY app.py /app/app.py

CMD ["python", "app.py"]