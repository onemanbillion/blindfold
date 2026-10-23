# Deploying Blindfold

A deployment is four services: three keyholders and one auction house. The keyholders must reach each other on one TCP port each for the MPC session; the auction house must reach the keyholders over HTTP and the internet's lightwalletd servers over gRPC.

## Keyholder (`services/party`)

| Variable | Meaning |
| --- | --- |
| `PARTY_INDEX` | `0`, `1` or `2` |
| `COORDINATOR_TOKEN` | Shared secret for `/v1/prepare` and `/v1/close` |
| `DATA_DIR` | Persistent directory for shares (mount a volume) |
| `MPC_PORT` | Port for the MPC session, default `11365` |
| `PARTY_OPERATOR` | Name shown on `/v1/info` |

Expose the HTTP port publicly (browsers send shares to it directly). Expose `MPC_PORT` to the other two keyholders only.

## Auction house (`services/web`)

Build from the repository root with `services/web/Dockerfile`. The image compiles `zcash-devtool`, the view-only light client the watcher uses.

| Variable | Meaning |
| --- | --- |
| `COORDINATOR_TOKEN` | Same as the keyholders |
| `PARTY_URLS` | Public HTTPS URLs of the keyholders, comma separated, in index order |
| `PARTY_INTERNAL_URLS` | Optional private URLs the coordinator uses instead |
| `PARTY_MPC_PEERS` | `host:port` for each keyholder's MPC port, as the keyholders see each other |
| `DATA_DIR` | Persistent directory (auction database and view-only wallets) |
| `BLOCK_SECONDS` | Block interval for time estimates (75 now; 25 after NU7) |
| `REAL_AUCTIONS` | Set to `off` to allow sandbox auctions only |
| `ADMIN_TOKEN` | Optional; enables the operator self-test endpoint |

## Railway

The reference deployment runs on Railway:

1. Create four services from this repository. For each keyholder set the root directory to `services/party`; for the auction house set the Dockerfile path to `services/web/Dockerfile` with the repository root as the build context.
2. Attach a volume at `/data` to each service.
3. Give the keyholders private hostnames `party-0`, `party-1`, `party-2` and set `PARTY_MPC_PEERS=party-0.railway.internal:11365,party-1.railway.internal:11365,party-2.railway.internal:11365`.
4. Generate public domains for the keyholders and the auction house; put the keyholder domains in `PARTY_URLS`.

A single-account Railway project is convenient for a demo, but it gives the account owner access to all three keyholders. For real privacy, each keyholder should be deployed by a different person on their own account, with only `PARTY_URLS`, `PARTY_MPC_PEERS` and `COORDINATOR_TOKEN` shared.
