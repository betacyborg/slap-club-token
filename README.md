# SLAP CLUB token tooling

The open part of [slapclub.fun](https://slapclub.fun): everything that touches the chain.
The game client itself is closed source; the token is not.

- **Game:** slap five egos in your browser. Free, no wallet, no download.
- **Token:** `$SLAP` on Solana (Token-2022). Contract address is published only by
  [@slapclubfun](https://x.com/slapclubfun) and on slapclub.fun. Never trust one from a DM.
- **Builder:** [@beta_cyborg](https://x.com/beta_cyborg).

## What is in here

| File | What it does |
|---|---|
| `tooling/slap.mjs` | Creates the mint (Token-2022 with on-chain metadata), mints the whole supply, revokes the mint authority and freezes the metadata. Also burn / send / info. |
| `tooling/pool.mjs` | Creates the launch pool on Meteora DAMM v2: single-sided (coins in, no SOL), trading opens at a fixed timestamp, fees start high and decay for the first minutes (a sniper tax), liquidity is **permanently locked** at creation. |
| `LAUNCH.md` | The launch record: addresses, transactions and the numbers, filled in at launch time. |

No third party ever holds a key. The scripts sign with a local keypair that never leaves the machine.

## Run it yourself

```bash
cd tooling && npm install
node slap.mjs wallet new
node slap.mjs create --cluster mainnet --name "YOUR COIN" --symbol COIN --uri https://example.com/token.json --decimals 6 --supply 1000000000 --revoke
node pool.mjs create --cluster mainnet --mint <mint> --amount 900000000 --price 0.00000005 --activation <unix seconds> --lock
```

`RPC_URL` picks the RPC endpoint (mainnet needs a real one). Read the top of each file for every flag.

## Rules the code follows

- The contract address is a build-time constant on the site, never fetched from an API.
- Nobody depicted in the game endorses anything. The token is a meme with no promise of any return.
- Liquidity in the launch pool cannot be withdrawn by anyone, ever. Trading fees from the locked position remain claimable by the pool creator, which is how the club is funded.

MIT licensed. Use it for your own launch if you like; keep the egos.
