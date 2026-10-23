FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgmp-dev gcc && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
WORKDIR /app
COPY party.py mpc_close.py ./
ENV DATA_DIR=/data MPC_PORT=11365
# The HTTP API listens on IPv4. The MPC session (mpc_close.py) listens on every
# interface, IPv4 and IPv6, so peers can reach it over a private network.
CMD ["sh", "-c", "uvicorn party:app --host 0.0.0.0 --port ${PORT:-8080}"]
