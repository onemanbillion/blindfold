"""Blindfold computing party.

One of three independent servers. It receives one share bundle per bid straight
from bidders' browsers, and at the auction's close it runs the MPC session with the
other two parties. A single party never learns any bid: its shares are uniformly
random numbers.

Environment:
  PARTY_INDEX         0, 1 or 2
  COORDINATOR_TOKEN   shared secret the coordinator uses for /prepare and /close
  DATA_DIR            where shares are kept (default ./data)
  MPC_PORT            port this party listens on for the MPC session (default 11365)
  PORT                HTTP port (default 8080)
"""

import asyncio
import hashlib
import json
import os
import secrets
import sqlite3
import sys
import time
from contextlib import closing
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

VERSION = "BF1"
BITS = 52
P = 79228162514264337593543950319  # MPyC SecInt(64) field
INDEX = int(os.environ.get("PARTY_INDEX", "0"))
TOKEN = os.environ.get("COORDINATOR_TOKEN", "")
DATA = Path(os.environ.get("DATA_DIR", "./data"))
MPC_PORT = int(os.environ.get("MPC_PORT", "11365"))
OPERATOR = os.environ.get("PARTY_OPERATOR", "Blindfold demo operator")
DATA.mkdir(parents=True, exist_ok=True)
DB = DATA / f"party{INDEX}.db"
HERE = Path(__file__).parent


def db():
    conn = sqlite3.connect(DB)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS shares (auction TEXT, bid TEXT, commitment TEXT, bits TEXT,"
        " created REAL, PRIMARY KEY (auction, bid))"
    )
    conn.execute("CREATE TABLE IF NOT EXISTS frozen (auction TEXT PRIMARY KEY, at REAL)")
    return conn


def commitment(auction, bid, party, bits):
    msg = f"{VERSION}|share|{auction}|{bid}|{party}|{','.join(bits)}"
    return hashlib.sha256(msg.encode()).hexdigest()[:24]


def check_auth(authorization):
    if not TOKEN or authorization != f"Bearer {TOKEN}":
        raise HTTPException(401, "coordinator token required")


app = FastAPI(title=f"Blindfold party {INDEX}")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])


class SharePacket(BaseModel):
    auctionId: str = Field(pattern=r"^[a-z0-9]{6,32}$")
    bidId: str = Field(pattern=r"^[0-9a-f]{16}$")
    party: int
    bits: list[str]
    commitment: str = Field(pattern=r"^[0-9a-f]{24}$")


class BidRef(BaseModel):
    bidId: str
    commitment: str


class Prepare(BaseModel):
    auctionId: str
    bids: list[BidRef]


class Close(BaseModel):
    auctionId: str
    bidIds: list[str]
    minBid: str
    checkSeed: int
    peers: list[str]  # host:port for parties 0, 1, 2


@app.get("/")
@app.get("/v1/info")
def info():
    return {"service": "blindfold-party", "version": VERSION, "party": INDEX, "field": str(P),
            "bits": BITS, "operator": OPERATOR}


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/v1/shares")
def receive_share(p: SharePacket):
    if p.party != INDEX:
        raise HTTPException(400, f"this is party {INDEX}, not party {p.party}")
    if len(p.bits) != BITS or not all(s.isdigit() and int(s) < P for s in p.bits):
        raise HTTPException(400, "malformed shares")
    if commitment(p.auctionId, p.bidId, INDEX, p.bits) != p.commitment:
        raise HTTPException(400, "shares do not match their commitment")
    with closing(db()) as conn, conn:
        if conn.execute("SELECT 1 FROM frozen WHERE auction=?", (p.auctionId,)).fetchone():
            raise HTTPException(409, "bidding has closed for this auction")
        conn.execute("INSERT OR REPLACE INTO shares VALUES (?,?,?,?,?)",
                     (p.auctionId, p.bidId, p.commitment, json.dumps(p.bits), time.time()))
    return {"ok": True, "party": INDEX, "bidId": p.bidId}


@app.post("/v1/prepare")
def prepare(req: Prepare, authorization: str = Header(default="")):
    """Freeze the auction and report which anchored bids this party holds valid shares for."""
    check_auth(authorization)
    with closing(db()) as conn, conn:
        conn.execute("INSERT OR IGNORE INTO frozen VALUES (?,?)", (req.auctionId, time.time()))
        rows = dict(conn.execute("SELECT bid, commitment FROM shares WHERE auction=?",
                                 (req.auctionId,)).fetchall())
    have = [b.bidId for b in req.bids if rows.get(b.bidId) == b.commitment]
    return {"party": INDEX, "have": have}


@app.post("/v1/close")
async def close(req: Close, authorization: str = Header(default="")):
    """Run this party's side of the MPC session. All three parties must be called together."""
    check_auth(authorization)
    if len(req.peers) != 3:
        raise HTTPException(400, "three peers required")
    with closing(db()) as conn:
        rows = dict(conn.execute("SELECT bid, bits FROM shares WHERE auction=?", (req.auctionId,)).fetchall())
    missing = [b for b in req.bidIds if b not in rows]
    if missing:
        raise HTTPException(409, f"missing shares for {missing}")
    job = {"bids": [{"bidId": b, "bits": json.loads(rows[b])} for b in req.bidIds],
           "minBid": req.minBid, "checkSeed": req.checkSeed}
    jobs = DATA / "jobs"
    jobs.mkdir(exist_ok=True)
    job_path = jobs / f"{req.auctionId}-{secrets.token_hex(4)}.json"
    job_path.write_text(json.dumps(job))
    out_path = Path(str(job_path) + ".out")
    args = [sys.executable, str(HERE / "mpc_close.py"), "-I", str(INDEX)]
    for peer in req.peers:
        args += ["-P", peer]
    env = {**os.environ, "BF_JOB": str(job_path), "BF_OUT": str(out_path)}
    proc = await asyncio.create_subprocess_exec(*args, env=env, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=240)
    except asyncio.TimeoutError:
        proc.kill()
        raise HTTPException(504, "MPC session timed out (are all three parties reachable?)")
    finally:
        job_path.unlink(missing_ok=True)  # shares stay in the database; the job copy goes
    if proc.returncode != 0 or not out_path.exists():
        raise HTTPException(500, "MPC session failed: " + out.decode()[-800:])
    result = json.loads(out_path.read_text())
    out_path.unlink(missing_ok=True)
    return {"party": INDEX, **result}
