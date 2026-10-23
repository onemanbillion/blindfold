FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgmp-dev gcc && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
WORKDIR /app
COPY party.py mpc_close.py ./
ENV DATA_DIR=/data MPC_PORT=11365
# Bind on all IPv4 and IPv6 interfaces so peers can reach us over a private network.
CMD ["sh", "-c", "uvicorn party:app --host :: --port ${PORT:-8080}"]
