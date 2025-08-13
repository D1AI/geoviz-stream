FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app
RUN pip install --no-cache-dir websockets aiokafka orjson
COPY app.py .
CMD ["python", "-u", "app.py"]