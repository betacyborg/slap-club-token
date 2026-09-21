#!/usr/bin/env node
// One-command token operations for the club, signed by a local deployer wallet: no third party ever holds a key.
//
//   node slap.mjs wallet new                       makes wallets/<cluster>.json (never printed) and shows its address
//   node slap.mjs wallet balance                   SOL balance of the deployer wallet
//   node slap.mjs airdrop 1                        devnet only: asks the faucet for SOL
//   node slap.mjs create --name "SLAP CLUB" --symbol SLAP --uri https://slapclub.fun/token/slap.json \
//                        --decimals 6 --supply 1000000000 [--to <address>] [--revoke]
//                                                  Token-2022 mint with on-chain metadata, freeze authority none from birth,
//                                                  the whole supply minted to --to (default: the deployer); --revoke then
//                                                  gives up the mint authority and freezes the metadata (nothing can change)
//   node slap.mjs revoke <mint>                    the same two steps later, if --revoke was not used
//   node slap.mjs burn <mint> <amount>             burns that many tokens (LP tokens of a pool, or the coin itself) from the wallet
//   node slap.mjs send <mint> <amount> <address>   moves tokens to another wallet
//   node slap.mjs info <mint>                      supply, authorities, metadata, as the explorers will see them
//
// Cluster: --cluster devnet|mainnet (default devnet). RPC: RPC_URL env var, else the public endpoint of the cluster
// (mainnet needs a real RPC key, e.g. Helius, in RPC_URL). Wallet: WALLET env var, else wallets/<cluster>.json.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  AuthorityType, ExtensionType, LENGTH_SIZE, TOKEN_2022_PROGRAM_ID, TYPE_SIZE, createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction, createInitializeMetadataPointerInstruction, createInitializeMintInstruction, createMintToCheckedInstruction,
  createSetAuthorityInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, getMint, getMintLen, getTokenMetadata,
} from "@solana/spl-token";
import { createInitializeInstruction, createUpdateAuthorityInstruction, pack } from "@solana/spl-token-metadata";

const args = process.argv.slice(2);
const flags = {}; const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) { const key = args[i].slice(2); const next = args[i + 1]; if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; } else flags[key] = true; }
  else positional.push(args[i]);
}
const cluster = flags.cluster ?? "devnet";
if (!["devnet", "mainnet"].includes(cluster)) fail(`unknown cluster ${cluster}`);
const rpc = process.env.RPC_URL ?? (cluster === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
const walletPath = process.env.WALLET ?? new URL(`./wallets/${cluster}.json`, import.meta.url).pathname;
const explorer = (kind, id) => `https://explorer.solana.com/${kind}/${id}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
const connection = new Connection(rpc, "confirmed");

function fail(message) { console.error(`slap: ${message}`); process.exit(1); }
async function loadWallet() {
  if (!existsSync(walletPath)) fail(`no wallet at ${walletPath}; run: node slap.mjs wallet new --cluster ${cluster}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(walletPath, "utf8"))));
}
const units = (amount, decimals) => BigInt(Math.round(Number(amount) * 10 ** decimals));   // whole tokens -> base units
const human = (raw, decimals) => (Number(raw) / 10 ** decimals).toLocaleString("en-US");

const [command, sub, ...rest] = positional;
switch (command) {
  case "wallet": {
    if (sub === "new") {
      if (existsSync(walletPath) && !flags.force) fail(`${walletPath} exists; add --force to overwrite (the old key would be lost)`);
      const keypair = Keypair.generate();
      await mkdir(new URL("./wallets/", import.meta.url), { recursive: true });
      await writeFile(walletPath, JSON.stringify(Array.from(keypair.secretKey))); await chmod(walletPath, 0o600);
      console.log(`deployer wallet (${cluster}): ${keypair.publicKey.toBase58()}\nkey file: ${walletPath} (keep it on this machine; fund this address with SOL for fees)`);
    } else if (sub === "balance") {
      const wallet = await loadWallet(); const lamports = await connection.getBalance(wallet.publicKey);
      console.log(`${wallet.publicKey.toBase58()}: ${lamports / LAMPORTS_PER_SOL} SOL (${cluster})`);
    } else fail("wallet new | wallet balance");
    break;
  }
  case "airdrop": {
    if (cluster !== "devnet") fail("airdrops exist on devnet only");
    const wallet = await loadWallet(); const sol = Number(sub ?? 1);
    const signature = await connection.requestAirdrop(wallet.publicKey, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(signature, "confirmed");
    console.log(`airdropped ${sol} SOL to ${wallet.publicKey.toBase58()}: ${explorer("tx", signature)}`);
    break;
  }
  case "create": {
    const { name, symbol, uri } = flags; const decimals = Number(flags.decimals ?? 6); const supply = flags.supply;
    if (!name || !symbol || !uri || !supply) fail("create needs --name --symbol --uri --supply [--decimals 6] [--to <address>] [--revoke]");
    if (symbol.length > 10) fail("symbol: at most 10 characters");
    const wallet = await loadWallet(); const mint = Keypair.generate();
    const recipient = flags.to ? new PublicKey(flags.to) : wallet.publicKey;
    const metadata = { mint: mint.publicKey, name, symbol, uri, additionalMetadata: [] };
    const mintLen = getMintLen([ExtensionType.MetadataPointer]);
    const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metadataLen);
    const ata = getAssociatedTokenAddressSync(mint.publicKey, recipient, false, TOKEN_2022_PROGRAM_ID);
    const tx = new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: mint.publicKey, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
      createInitializeMetadataPointerInstruction(mint.publicKey, wallet.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint.publicKey, decimals, wallet.publicKey, null, TOKEN_2022_PROGRAM_ID),        // freeze authority: none, from birth
      createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, mint: mint.publicKey, metadata: mint.publicKey, name, symbol, uri, mintAuthority: wallet.publicKey, updateAuthority: wallet.publicKey }),
      createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata, recipient, mint.publicKey, TOKEN_2022_PROGRAM_ID),
      createMintToCheckedInstruction(mint.publicKey, ata, wallet.publicKey, units(supply, decimals), decimals, [], TOKEN_2022_PROGRAM_ID),
    );
    if (flags.revoke) tx.add(
      createSetAuthorityInstruction(mint.publicKey, wallet.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
      createUpdateAuthorityInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint.publicKey, oldAuthority: wallet.publicKey, newAuthority: null }),
    );
    const signature = await sendAndConfirmTransaction(connection, tx, [wallet, mint]);
    console.log(`token created: ${mint.publicKey.toBase58()}\n  ${name} (${symbol}), ${Number(supply).toLocaleString("en-US")} minted to ${recipient.toBase58()}, decimals ${decimals}\n  freeze authority: none · mint authority: ${flags.revoke ? "revoked" : "still the deployer (run revoke)"} · metadata: ${flags.revoke ? "frozen" : "still editable"}\n  ${explorer("address", mint.publicKey.toBase58())}\n  tx ${explorer("tx", signature)}`);
    break;
  }
  case "revoke": {
    const mint = new PublicKey(sub ?? fail("revoke <mint>")); const wallet = await loadWallet();
    const tx = new Transaction().add(
      createSetAuthorityInstruction(mint, wallet.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
      createUpdateAuthorityInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, oldAuthority: wallet.publicKey, newAuthority: null }),
    );
    const signature = await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.log(`mint authority revoked and metadata frozen for ${mint.toBase58()}: ${explorer("tx", signature)}`);
    break;
  }
  case "burn":
  case "send": {
    const mint = new PublicKey(sub ?? fail(`${command} <mint> <amount>${command === "send" ? " <address>" : ""}`)); const amount = rest[0] ?? fail("amount missing");
    const wallet = await loadWallet();
    // works for the coin and for any SPL token the wallet holds, LP tokens of a Raydium pool included: the program is read from the mint
    const info = await connection.getAccountInfo(mint); if (!info) fail("no such mint");
    const program = info.owner; const state = await getMint(connection, mint, "confirmed", program);
    const from = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, program);
    const tx = new Transaction();
    if (command === "burn") tx.add(createBurnCheckedInstruction(from, mint, wallet.publicKey, units(amount, state.decimals), state.decimals, [], program));
    else {
      const to = new PublicKey(rest[1] ?? fail("send <mint> <amount> <address>")); const toAta = getAssociatedTokenAddressSync(mint, to, false, program);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, toAta, to, mint, program), createTransferCheckedInstruction(from, mint, toAta, wallet.publicKey, units(amount, state.decimals), state.decimals, [], program));
    }
    const signature = await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.log(`${command === "burn" ? "burned" : "sent"} ${Number(amount).toLocaleString("en-US")} of ${mint.toBase58()}: ${explorer("tx", signature)}`);
    break;
  }
  case "info": {
    const mint = new PublicKey(sub ?? fail("info <mint>")); const info = await connection.getAccountInfo(mint); if (!info) fail("no such mint");
    const state = await getMint(connection, mint, "confirmed", info.owner);
    let meta = null; try { meta = await getTokenMetadata(connection, mint, "confirmed", info.owner); } catch { /* classic token without the extension */ }
    console.log(JSON.stringify({ mint: mint.toBase58(), program: info.owner.equals(TOKEN_2022_PROGRAM_ID) ? "Token-2022" : "Token", decimals: state.decimals, supply: human(state.supply, state.decimals),
      mintAuthority: state.mintAuthority?.toBase58() ?? "none (revoked)", freezeAuthority: state.freezeAuthority?.toBase58() ?? "none",
      metadata: meta ? { name: meta.name, symbol: meta.symbol, uri: meta.uri, updateAuthority: meta.updateAuthority?.toBase58() ?? "none (frozen)" } : null, explorer: explorer("address", mint.toBase58()) }, null, 1));
    break;
  }
  default: fail("commands: wallet new|balance · airdrop · create · revoke · burn · send · info (see the top of this file)");
}
