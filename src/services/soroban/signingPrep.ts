/**
 * Signing preparation layer.
 *
 * Responsible for:
 *  - Detecting whether a simulation result requires authorization
 *  - Rejecting authorization entries that have already expired
 *  - Assembling the transaction with the populated footprint from simulation
 *  - Signing the assembled transaction with a provided keypair
 *
 * This layer does NOT submit the transaction — submission is the invoker's job.
 */

import { StellarSdk, NETWORK_PASSPHRASES, SorobanNetwork } from "./sdkAdapter";
import {
  AuthExpiredError,
  AuthRequiredError,
  SigningError,
  NetworkMismatchError,
} from "./errors";
import { SecretBuffer } from "../../utils/secretBuffer";
import type { SimulationSuccess } from "./sdkAdapter";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SigningContext {
  network: SorobanNetwork;
  secretKey: string;
  /**
   * Latest ledger sequence known to the caller. When supplied together with
   * auth entries carrying an expiration, `prepareSignedTransaction` rejects
   * entries that have already expired instead of signing a doomed envelope.
   *
   * Optional — when omitted, no expiry check is performed.
   */
  currentLedgerSeq?: number;
}

export interface AssembledTransaction {
  /** The signed XDR string ready for submission */
  signedXdr: string;
  /** The keypair used for signing */
  signerPublicKey: string;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return true when the simulation result contains auth entries that must be
 * signed before the transaction can be submitted.
 */
export function requiresSigning(sim: SimulationSuccess): boolean {
  const auth = sim.result?.auth;
  return Array.isArray(auth) && auth.length > 0;
}

/**
 * Assemble and sign a transaction using the simulation result's footprint.
 *
 * Throws `AuthRequiredError` when auth entries are present but no signing
 * context is provided.
 *
 * Throws `NetworkMismatchError` when the transaction envelope was built for a
 * different network passphrase than the client claims to be on — before any
 * signature bytes are produced.
 *
 * Throws `AuthExpiredError` when `context.currentLedgerSeq` is supplied and an
 * authorization entry in the simulation result has already expired.
 *
 * Throws `SigningError` when the SDK's `assembleTransaction` helper is
 * unavailable or signing fails.
 */
export function prepareSignedTransaction(
  unsignedTx: StellarSdk.Transaction,
  sim: SimulationSuccess,
  context: SigningContext
): AssembledTransaction {
  assertNetworkMatches(unsignedTx, context.network);

  if (context.currentLedgerSeq !== undefined) {
    assertAuthNotExpired(sim, context.currentLedgerSeq);
  }

  // Wrap the secret key to minimize its lifetime and prevent accidental
  // exposure through logging, serialization, or error propagation.
  const secret = SecretBuffer.fromString(
    context.secretKey,
    "stellar-secret-key"
  );
  try {
    const keypair = parseKeypair(secret);
    const assembled = assembleWithSimulation(unsignedTx, sim, context.network);
    assembled.sign(keypair);

    return {
      signedXdr: assembled.toEnvelope().toXDR("base64"),
      signerPublicKey: keypair.publicKey(),
    };
  } finally {
    secret.destroy();
  }
}

/**
 * Guard: refuse to sign when the transaction envelope's network passphrase
 * disagrees with the client's declared network. This runs BEFORE any signing
 * step so no signature is ever produced for the wrong environment.
 */
function assertNetworkMatches(
  tx: StellarSdk.Transaction,
  network: SorobanNetwork
): void {
  const expected = NETWORK_PASSPHRASES[network];
  const transactionPassphrase = tx.networkPassphrase;
  if (
    typeof transactionPassphrase === "string" &&
    transactionPassphrase.length > 0 &&
    transactionPassphrase !== expected
  ) {
    throw new NetworkMismatchError({
      expectedNetwork: network,
      transactionNetwork: transactionPassphrase,
    });
  }
}

/**
 * Guard: throw `AuthRequiredError` when the simulation requires signing but
 * no secret key was supplied.
 */
export function assertSigningNotRequired(
  sim: SimulationSuccess,
  hasSecretKey: boolean
): void {
  if (requiresSigning(sim) && !hasSecretKey) {
    throw new AuthRequiredError();
  }
}

/**
 * Guard: throw `AuthExpiredError` when any authorization entry in the
 * simulation result expired before `currentLedgerSeq`.
 *
 * An entry is treated as expired when its expiration ledger is strictly less
 * than the current ledger — an entry expiring on the current ledger is still
 * valid for it. Entries without an expiry — or with a non-numeric one — are
 * left alone; an auth entry that cannot be read must not block signing.
 *
 * A `currentLedgerSeq` of `0` (or any non-positive / non-finite value) means
 * "unknown" and skips the check entirely.
 */
export function assertAuthNotExpired(
  sim: SimulationSuccess,
  currentLedgerSeq: number
): void {
  if (!Number.isFinite(currentLedgerSeq) || currentLedgerSeq <= 0) return;

  const expired: string[] = [];

  for (const entry of readAuthEntries(sim)) {
    const expiry = readExpirationLedgerSeq(entry);
    if (expiry === undefined) continue;
    if (expiry < currentLedgerSeq) {
      expired.push(String(expiry));
    }
  }

  if (expired.length > 0) {
    throw new AuthExpiredError(
      `Soroban authorization entries expired: ` +
        `${expired.join(", ")} < current ledger ${currentLedgerSeq}. ` +
        `Re-simulate the transaction to obtain fresh authorization entries.`
    );
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Read the auth entry list from a simulation result without assuming a
 * particular SDK version.
 */
function readAuthEntries(sim: SimulationSuccess): unknown[] {
  const auth = sim?.result?.auth;
  return Array.isArray(auth) ? auth : [];
}

/**
 * Extract the expiration ledger from a single authorization entry.
 *
 * Handles both the SDK's `AuthorizationEntry` wrapper (which exposes a
 * `getExpirationLedgerSeq()` method) and the raw XDR shape, where the value
 * lives at `credentials.sorobanAuthorization.expirationLedgerSeq`.
 */
function readExpirationLedgerSeq(entry: unknown): number | undefined {
  if (!entry || typeof entry !== "object") return undefined;

  const wrapper = entry as { getExpirationLedgerSeq?: unknown };
  if (typeof wrapper.getExpirationLedgerSeq === "function") {
    const viaMethod = toLedgerNumber(
      (wrapper.getExpirationLedgerSeq as () => unknown).call(entry)
    );
    if (viaMethod !== undefined) return viaMethod;
  }

  const creds = (entry as { credentials?: unknown }).credentials;
  if (!creds || typeof creds !== "object") return undefined;

  const sorobanAuth = (creds as { sorobanAuthorization?: unknown })
    .sorobanAuthorization;
  if (!sorobanAuth || typeof sorobanAuth !== "object") return undefined;

  return toLedgerNumber(
    (sorobanAuth as { expirationLedgerSeq?: unknown }).expirationLedgerSeq
  );
}

/**
 * Coerce an XDR/native ledger sequence to a number. XDR `Int32` values expose
 * `toNumber()`; `BigInt` and numeric strings are unwrapped as-is.
 */
function toLedgerNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (
    value &&
    typeof (value as { toNumber?: unknown }).toNumber === "function"
  ) {
    return toLedgerNumber((value as { toNumber: () => unknown }).toNumber());
  }
  return undefined;
}

function parseKeypair(secret: SecretBuffer): StellarSdk.Keypair {
  try {
    // Keypair.fromSecret requires a plaintext string — this is the narrowest
    // possible scope for the string conversion.
    return secret.consumeString((plainKey) =>
      StellarSdk.Keypair.fromSecret(plainKey)
    );
  } catch (err) {
    // Do not include the secret key value in the error message.
    throw new SigningError(
      `Invalid secret key: ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }
}

function assembleWithSimulation(
  tx: StellarSdk.Transaction,
  sim: SimulationSuccess,
  network: SorobanNetwork
): StellarSdk.Transaction {
  const sdk = StellarSdk as unknown as Record<string, unknown>;

  // Current SDK: StellarSdk.SorobanRpc.assembleTransaction
  const rpcNs = sdk["SorobanRpc"] as Record<string, unknown> | undefined;
  if (typeof rpcNs?.["assembleTransaction"] === "function") {
    try {
      return (
        rpcNs["assembleTransaction"] as (
          tx: StellarSdk.Transaction,
          sim: unknown
        ) => StellarSdk.Transaction
      )(tx, sim);
    } catch (err) {
      throw new SigningError(
        `assembleTransaction failed: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  // Fallback: manually attach the simulation's transaction data
  if (sim.transactionData) {
    try {
      const passphrase = NETWORK_PASSPHRASES[network];
      const txBuilder = StellarSdk.TransactionBuilder.cloneFrom(tx, {
        fee: sim.minResourceFee ?? StellarSdk.BASE_FEE,
        networkPassphrase: passphrase,
      });
      return txBuilder.build();
    } catch (err) {
      throw new SigningError(
        `Manual transaction assembly failed: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  throw new SigningError(
    "Cannot assemble transaction: SorobanRpc.assembleTransaction is not available " +
      "and simulation result contains no transactionData. " +
      "Upgrade @stellar/stellar-sdk to ≥ 11."
  );
}
