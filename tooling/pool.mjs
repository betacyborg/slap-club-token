#!/usr/bin/env node
// The launch pool on Meteora DAMM v2, single-sided and scheduled: the deployer wallet puts the coin in, no SOL, the pool
// opens for trading at --activation (unix seconds; the club's LAUNCH_AT), fees start high and decay (a sniper tax), and the
// liquidity is locked for good at creation. One command, one signature, nothing custodial.
//
//   node pool.mjs create --mint <coin mint> --amount 900000000 --price 0.00000005 --activation 1790028000 [--lock] [--fee-start 5000 --fee-end 100 --fee-seconds 600]
//     --price is SOL per one whole coin. --activation 0 = open at once. --lock = permanent lock of the position (irreversible).
//   node pool.mjs quote --price 0.00000005 --supply 1000000000 --sol-usd 150     shows the market cap that price means
//   node pool.mjs show <pool address>                                             pool state as the explorers see it
//
// Same wallet and RPC rules as slap.mjs (WALLET, RPC_URL, --cluster devnet|mainnet).
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getMint } from "@solana/spl-token";
import { BaseFeeMode, CpAmm, MAX_SQRT_PRICE, getBaseFeeParams, getDynamicFeeParams, getSqrtPriceFromPrice, getPriceFromSqrtPrice } from "@meteora-ag/cp-amm-sdk";

const args = process.argv.slice(2); const flags = {}; const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) { const key = args[i].slice(2); const next = args[i + 1]; if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; } else flags[key] = true; }
  else positional.push(args[i]);
}
const cluster = flags.cluster ?? "devnet";
const rpc = process.env.RPC_URL ?? (cluster === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
const walletPath = process.env.WALLET ?? new URL(`./wallets/${cluster}.json`, import.meta.url).pathname;
const connection = new Connection(rpc, "confirmed");
const fail = message => { console.error(`pool: ${message}`); process.exit(1); };
const explorer = (kind, id) => `https://explorer.solana.com/${kind}/${id}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
async function loadWallet() { if (!existsSync(walletPath)) fail(`no wallet at ${walletPath}`); return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(walletPath, "utf8")))); }

const [command, sub] = positional;
switch (command) {
  case "quote": {
    const price = Number(flags.price), supply = Number(flags.supply ?? 1e9), solUsd = Number(flags["sol-usd"] ?? 0);
    if (!price) fail("quote --price <SOL per coin> [--supply 1000000000] [--sol-usd 150]");
    const capSol = price * supply;
    console.log(`price ${price} SOL/coin × supply ${supply.toLocaleString("en-US")} = market cap ${capSol.toLocaleString("en-US")} SOL${solUsd ? ` ≈ $${(capSol * solUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : ""}`);
    break;
  }
  case "create": {
    const mint = new PublicKey(flags.mint ?? fail("create needs --mint")); const amount = Number(flags.amount ?? fail("--amount (whole coins) missing"));
    const price = Number(flags.price ?? fail("--price (SOL per coin) missing")); const activation = Number(flags.activation ?? 0);
    const feeStart = Number(flags["fee-start"] ?? 5000), feeEnd = Number(flags["fee-end"] ?? 100), feeSeconds = Number(flags["fee-seconds"] ?? 600);
    const wallet = await loadWallet();
    const info = await connection.getAccountInfo(mint); if (!info) fail("no such mint");
    const coin = await getMint(connection, mint, "confirmed", info.owner);
    const cpAmm = new CpAmm(connection);
    // SOL is token B (the quote); the coin is token A. Price is quoted as B per A.
    const initSqrtPrice = getSqrtPriceFromPrice(String(price), coin.decimals, 9);
    const tokenAAmount = new BN(BigInt(Math.round(amount * 10 ** coin.decimals)).toString());
    // single-sided: the position starts at the current price and runs up to the top of the range, so no SOL is needed
    const sqrtMinPrice = initSqrtPrice, sqrtMaxPrice = MAX_SQRT_PRICE;
    const collectFeeMode = 1;                                                                 // fees collected in SOL only
    const liquidityDelta = cpAmm.preparePoolCreationSingleSide({ tokenAAmount, minSqrtPrice: sqrtMinPrice, maxSqrtPrice: sqrtMaxPrice, initSqrtPrice, collectFeeMode });
    // fee: starts at feeStart bps and decays exponentially to feeEnd bps over feeSeconds, then a small dynamic fee on volatility
    const baseFee = getBaseFeeParams({ baseFeeMode: BaseFeeMode.FeeTimeSchedulerExponential, feeTimeSchedulerParam: { startingFeeBps: feeStart, endingFeeBps: feeEnd, numberOfPeriod: Math.max(1, Math.min(feeSeconds, 120)), totalDuration: feeSeconds } });
    const poolFees = { baseFee, compoundingFeeBps: 0, padding: 0, dynamicFee: getDynamicFeeParams(feeEnd) };
    const positionNft = Keypair.generate();
    const { tx, pool, position } = await cpAmm.createCustomPool({
      payer: wallet.publicKey, creator: wallet.publicKey, positionNft: positionNft.publicKey,
      tokenAMint: mint, tokenBMint: NATIVE_MINT, tokenAAmount, tokenBAmount: new BN(0),
      sqrtMinPrice, sqrtMaxPrice, liquidityDelta, initSqrtPrice, poolFees, hasAlphaVault: false, collectFeeMode,
      activationType: 1, activationPoint: activation ? new BN(activation) : null,
      tokenAProgram: info.owner, tokenBProgram: TOKEN_PROGRAM_ID, isLockLiquidity: Boolean(flags.lock),
    });
    const signature = await sendAndConfirmTransaction(connection, tx, [wallet, positionNft]);
    console.log(`pool created: ${pool.toBase58()}\n  ${amount.toLocaleString("en-US")} coins in, 0 SOL, start price ${price} SOL/coin (${getPriceFromSqrtPrice(initSqrtPrice, coin.decimals, 9)})\n  trading opens: ${activation ? new Date(activation * 1000).toISOString() : "now"} · fee ${feeStart / 100}% → ${feeEnd / 100}% over ${feeSeconds} s · liquidity ${flags.lock ? "LOCKED FOR GOOD" : "not locked"}\n  position ${position.toBase58()}\n  ${explorer("address", pool.toBase58())}\n  tx ${explorer("tx", signature)}`);
    break;
  }
  case "show": {
    const pool = new PublicKey(sub ?? fail("show <pool>")); const cpAmm = new CpAmm(connection);
    const state = await cpAmm.fetchPoolState(pool);
    const aDecimals = (await getMint(connection, state.tokenAMint, "confirmed", (await connection.getAccountInfo(state.tokenAMint)).owner)).decimals;
    console.log(JSON.stringify({ pool: pool.toBase58(), tokenA: state.tokenAMint.toBase58(), tokenB: state.tokenBMint.toBase58(), price: getPriceFromSqrtPrice(state.sqrtPrice, aDecimals, 9), activationType: state.activationType, activationPoint: state.activationPoint?.toString(), permanentLockLiquidity: state.permanentLockLiquidity?.toString(), liquidity: state.liquidity?.toString(), explorer: explorer("address", pool.toBase58()) }, null, 1));
    break;
  }
  default: fail("commands: quote · create · show (see the top of this file)");
}
