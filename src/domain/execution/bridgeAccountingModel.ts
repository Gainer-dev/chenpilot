/**
 * In-Transit Bridge Accounting Model — Issue #858
 *
 * Defines how cross-chain bridge transfers should be accounted for in portfolio
 * valuation without double-counting holdings during the in-transit period.
 *
 * PROBLEM
 * ───────
 * When assets move across chains via a bridge:
 * 1. Source chain: Assets are locked/burned
 * 2. In-transit: Bridge validators coordinate proof
 * 3. Destination chain: Assets are minted/unlocked
 *
 * During the in-transit period, naive accounting would either:
 * - Double-count: Include in both source and destination portfolios
 * - Miss entirely: Exclude from both, showing temporary balance drop
 *
 * SOLUTION
 * ────────
 * This module defines bridge transfer states and accounting rules to ensure
 * assets are counted exactly once throughout the bridge lifecycle.
 *
 * ACCOUNTING RULES
 * ────────────────
 * 1. INITIATED: Counted in source chain (not yet locked)
 * 2. LOCKED: Counted as in-transit bridge holding (removed from source)
 * 3. PROOF_GENERATED: Counted as in-transit bridge holding
 * 4. VALIDATORS_SIGNED: Counted as in-transit bridge holding
 * 5. MINTED: Counted in destination chain (removed from in-transit)
 * 6. FAILED: Returned to source chain accounting
 *
 * Conservation invariant: 
 *   totalPortfolioValue = sourceChainHoldings + destinationChainHoldings + inTransitBridgeHoldings
 */

/**
 * Bridge transfer lifecycle states.
 * 
 * These states align with the cross-chain bridge implementation in
 * packages/sdk/examples/cross-chain-bridge.ts
 */
export enum BridgeTransferState {
  /** Transfer initiated but source chain transaction not yet confirmed */
  INITIATED = "initiated",
  /** Source chain lock/burn transaction confirmed */
  LOCKED = "locked",
  /** Bridge proof generated and validated */
  PROOF_GENERATED = "proof_generated",
  /** Required validator signatures collected */
  VALIDATORS_SIGNED = "validators_signed",
  /** Destination chain mint/unlock transaction confirmed */
  MINTED = "minted",
  /** Transfer failed and should be unwound */
  FAILED = "failed",
}

/**
 * Where an asset should be counted in portfolio accounting based on
 * its bridge transfer state.
 */
export enum AccountingLocation {
  /** Asset remains in source chain portfolio */
  SOURCE_CHAIN = "source_chain",
  /** Asset is in-transit, counted separately to avoid double-counting */
  IN_TRANSIT = "in_transit",
  /** Asset has arrived in destination chain portfolio */
  DESTINATION_CHAIN = "destination_chain",
  /** Asset should be returned to source chain (failed transfer) */
  SOURCE_CHAIN_RETURNED = "source_chain_returned",
}

/**
 * Maps bridge transfer state to the correct accounting location.
 * 
 * This mapping prevents double-counting by ensuring each state corresponds
 * to exactly one portfolio location.
 */
export const BRIDGE_STATE_ACCOUNTING_RULES: Record<
  BridgeTransferState,
  AccountingLocation
> = {
  [BridgeTransferState.INITIATED]: AccountingLocation.SOURCE_CHAIN,
  [BridgeTransferState.LOCKED]: AccountingLocation.IN_TRANSIT,
  [BridgeTransferState.PROOF_GENERATED]: AccountingLocation.IN_TRANSIT,
  [BridgeTransferState.VALIDATORS_SIGNED]: AccountingLocation.IN_TRANSIT,
  [BridgeTransferState.MINTED]: AccountingLocation.DESTINATION_CHAIN,
  [BridgeTransferState.FAILED]: AccountingLocation.SOURCE_CHAIN_RETURNED,
};

/**
 * A single cross-chain bridge transfer with accounting metadata.
 */
export interface BridgeTransferRecord {
  /** Unique identifier for this bridge transfer */
  transferId: string;
  /** Bridge operation ID (links to bridge system) */
  bridgeOperationId: string;
  /** Source chain identifier */
  sourceChain: string;
  /** Destination chain identifier */
  destinationChain: string;
  /** Asset being transferred */
  assetCode: string;
  /** Asset issuer (if applicable, empty for native assets) */
  assetIssuer: string;
  /** Amount being transferred (decimal string) */
  amount: string;
  /** Current state of the bridge transfer */
  state: BridgeTransferState;
  /** Source chain transaction hash (lock/burn) */
  sourceTransactionHash: string | null;
  /** Destination chain transaction hash (mint/unlock) */
  destinationTransactionHash: string | null;
  /** Bridge proof data (null until generated) */
  bridgeProof: string | null;
  /** Number of validator signatures collected */
  validatorSignatureCount: number;
  /** When the transfer was initiated */
  initiatedAt: number; // Unix timestamp ms
  /** When the transfer reached current state */
  stateUpdatedAt: number; // Unix timestamp ms
  /** When the transfer completed (MINTED) or failed */
  completedAt: number | null; // Unix timestamp ms
}

/**
 * Portfolio holdings partitioned by accounting location to prevent
 * double-counting during cross-chain transfers.
 */
export interface PartitionedPortfolioHoldings {
  /** User/account identifier */
  accountId: string;
  /** Holdings in source chains (not in transit) */
  sourceChainHoldings: AssetHolding[];
  /** Holdings currently in-transit via bridge */
  inTransitHoldings: AssetHolding[];
  /** Holdings in destination chains (arrived via bridge) */
  destinationChainHoldings: AssetHolding[];
  /** Total across all locations (should never double-count) */
  totalHoldings: AssetHolding[];
  /** ISO timestamp of this snapshot */
  snapshotAt: string;
}

/**
 * A single asset holding with chain context.
 */
export interface AssetHolding {
  /** Asset code */
  assetCode: string;
  /** Asset issuer (empty for native) */
  assetIssuer: string;
  /** Chain where this holding resides */
  chain: string;
  /** Amount held (decimal string) */
  amount: string;
  /** Numeric amount for calculations */
  numericAmount: number;
  /** Estimated value in reporting currency (null if unpriceable) */
  valueInCurrency: number | null;
  /** Currency used for valuation */
  currency: string;
  /** Accounting location (source/in-transit/destination) */
  accountingLocation: AccountingLocation;
  /** Associated bridge transfer ID (if in-transit) */
  bridgeTransferId: string | null;
}

/**
 * Categorize a bridge transfer into its accounting location based on
 * current state.
 *
 * @param transfer - Bridge transfer record
 * @returns The accounting location where this asset should be counted
 */
export function getAccountingLocation(
  transfer: BridgeTransferRecord,
): AccountingLocation {
  return BRIDGE_STATE_ACCOUNTING_RULES[transfer.state];
}

/**
 * Compute partitioned portfolio holdings from raw chain balances and
 * active bridge transfers.
 *
 * This is the core function that prevents double-counting by:
 * 1. Starting with all on-chain balances
 * 2. Subtracting amounts currently in-transit
 * 3. Categorizing in-transit amounts separately
 * 4. Ensuring total = source + in-transit + destination (no overlap)
 *
 * @param accountId - User account identifier
 * @param sourceChainBalances - Current balances on source chains
 * @param destinationChainBalances - Current balances on destination chains
 * @param activeBridgeTransfers - All active (non-completed) bridge transfers
 * @param currency - Currency for valuation (default "USD")
 * @returns Partitioned holdings with accounting locations
 */
export function computePartitionedHoldings(
  accountId: string,
  sourceChainBalances: { chain: string; assetCode: string; assetIssuer: string; amount: string }[],
  destinationChainBalances: { chain: string; assetCode: string; assetIssuer: string; amount: string }[],
  activeBridgeTransfers: BridgeTransferRecord[],
  currency: string = "USD",
): PartitionedPortfolioHoldings {
  const sourceHoldings: AssetHolding[] = [];
  const inTransitHoldings: AssetHolding[] = [];
  const destinationHoldings: AssetHolding[] = [];

  // Process active bridge transfers to extract in-transit amounts
  const inTransitByKey = new Map<string, { amount: number; transfers: BridgeTransferRecord[] }>();

  for (const transfer of activeBridgeTransfers) {
    const location = getAccountingLocation(transfer);
    
    if (location === AccountingLocation.IN_TRANSIT) {
      const key = `${transfer.sourceChain}:${transfer.assetCode}:${transfer.assetIssuer}`;
      const existing = inTransitByKey.get(key) ?? { amount: 0, transfers: [] };
      existing.amount += parseFloat(transfer.amount);
      existing.transfers.push(transfer);
      inTransitByKey.set(key, existing);
    }
  }

  // Process source chain balances (subtract in-transit amounts)
  const sourceByKey = new Map<string, number>();
  for (const balance of sourceChainBalances) {
    const key = `${balance.chain}:${balance.assetCode}:${balance.assetIssuer}`;
    const onChainAmount = parseFloat(balance.amount);
    const inTransitData = inTransitByKey.get(key);
    const inTransitAmount = inTransitData?.amount ?? 0;
    
    // Source chain accounting: on-chain balance minus in-transit
    const availableAmount = Math.max(0, onChainAmount - inTransitAmount);
    
    if (availableAmount > 0) {
      sourceHoldings.push({
        assetCode: balance.assetCode,
        assetIssuer: balance.assetIssuer,
        chain: balance.chain,
        amount: availableAmount.toFixed(7),
        numericAmount: availableAmount,
        valueInCurrency: null, // Pricing happens at higher layer
        currency,
        accountingLocation: AccountingLocation.SOURCE_CHAIN,
        bridgeTransferId: null,
      });
      sourceByKey.set(key, availableAmount);
    }
  }

  // Add in-transit holdings as separate category
  for (const [key, data] of inTransitByKey.entries()) {
    const [chain, assetCode, assetIssuer] = key.split(":");
    inTransitHoldings.push({
      assetCode,
      assetIssuer,
      chain, // Source chain (where it was locked)
      amount: data.amount.toFixed(7),
      numericAmount: data.amount,
      valueInCurrency: null,
      currency,
      accountingLocation: AccountingLocation.IN_TRANSIT,
      bridgeTransferId: data.transfers.map(t => t.transferId).join(","),
    });
  }

  // Process destination chain balances (no subtraction needed, already arrived)
  for (const balance of destinationChainBalances) {
    const amount = parseFloat(balance.amount);
    if (amount > 0) {
      destinationHoldings.push({
        assetCode: balance.assetCode,
        assetIssuer: balance.assetIssuer,
        chain: balance.chain,
        amount: balance.amount,
        numericAmount: amount,
        valueInCurrency: null,
        currency,
        accountingLocation: AccountingLocation.DESTINATION_CHAIN,
        bridgeTransferId: null,
      });
    }
  }

  // Aggregate totals by asset (across all locations)
  const totalByAsset = new Map<string, number>();
  const aggregateHoldings = (holdings: AssetHolding[]) => {
    for (const holding of holdings) {
      const key = `${holding.assetCode}:${holding.assetIssuer}`;
      const existing = totalByAsset.get(key) ?? 0;
      totalByAsset.set(key, existing + holding.numericAmount);
    }
  };

  aggregateHoldings(sourceHoldings);
  aggregateHoldings(inTransitHoldings);
  aggregateHoldings(destinationHoldings);

  const totalHoldings: AssetHolding[] = Array.from(totalByAsset.entries()).map(
    ([key, amount]) => {
      const [assetCode, assetIssuer] = key.split(":");
      return {
        assetCode,
        assetIssuer,
        chain: "aggregated",
        amount: amount.toFixed(7),
        numericAmount: amount,
        valueInCurrency: null,
        currency,
        accountingLocation: AccountingLocation.SOURCE_CHAIN, // Placeholder for aggregated
        bridgeTransferId: null,
      };
    },
  );

  return {
    accountId,
    sourceChainHoldings: sourceHoldings,
    inTransitHoldings,
    destinationChainHoldings: destinationHoldings,
    totalHoldings,
    snapshotAt: new Date().toISOString(),
  };
}

/**
 * Conservation invariant: Verify that total holdings equal the sum of
 * source + in-transit + destination with no double-counting.
 *
 * @param holdings - Partitioned portfolio holdings
 * @returns true if conservation holds (no double-counting detected)
 */
export function verifyConservationInvariant(
  holdings: PartitionedPortfolioHoldings,
): { holds: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Build expected totals from partitions
  const expectedByAsset = new Map<string, number>();
  
  const addToExpected = (holdings: AssetHolding[]) => {
    for (const h of holdings) {
      const key = `${h.assetCode}:${h.assetIssuer}`;
      const existing = expectedByAsset.get(key) ?? 0;
      expectedByAsset.set(key, existing + h.numericAmount);
    }
  };
  
  addToExpected(holdings.sourceChainHoldings);
  addToExpected(holdings.inTransitHoldings);
  addToExpected(holdings.destinationChainHoldings);
  
  // Compare with reported totals
  const actualByAsset = new Map<string, number>();
  for (const h of holdings.totalHoldings) {
    const key = `${h.assetCode}:${h.assetIssuer}`;
    actualByAsset.set(key, h.numericAmount);
  }
  
  // Check each asset
  for (const [key, expectedAmount] of expectedByAsset.entries()) {
    const actualAmount = actualByAsset.get(key) ?? 0;
    const delta = Math.abs(expectedAmount - actualAmount);
    
    if (delta > 0.0000001) { // Sub-stroop tolerance
      errors.push(
        `Conservation violated for ${key}: ` +
        `expected ${expectedAmount.toFixed(7)}, got ${actualAmount.toFixed(7)} ` +
        `(delta: ${delta.toFixed(7)})`
      );
    }
  }
  
  // Check for assets in actual but not in expected
  for (const key of actualByAsset.keys()) {
    if (!expectedByAsset.has(key)) {
      errors.push(`Asset ${key} in total but not in any partition`);
    }
  }
  
  return {
    holds: errors.length === 0,
    errors,
  };
}

/**
 * Detect potential double-counting scenarios where the same asset amount
 * appears in multiple accounting locations.
 *
 * This is a defensive check — if properly implemented, the partitioning
 * logic should prevent this. But we check anyway.
 *
 * @param holdings - Partitioned portfolio holdings
 * @returns Array of potential double-counting issues (empty if clean)
 */
export function detectDoubleCountingRisks(
  holdings: PartitionedPortfolioHoldings,
): string[] {
  const risks: string[] = [];
  
  // Check 1: No asset should appear in both source and destination for same chain
  const sourceKeys = new Set(
    holdings.sourceChainHoldings.map(
      h => `${h.chain}:${h.assetCode}:${h.assetIssuer}`
    )
  );
  const destKeys = new Set(
    holdings.destinationChainHoldings.map(
      h => `${h.chain}:${h.assetCode}:${h.assetIssuer}`
    )
  );
  
  for (const key of sourceKeys) {
    if (destKeys.has(key)) {
      risks.push(
        `Potential double-count: ${key} appears in both source and destination`
      );
    }
  }
  
  // Check 2: In-transit amounts should have corresponding bridge transfers
  for (const h of holdings.inTransitHoldings) {
    if (!h.bridgeTransferId) {
      risks.push(
        `In-transit holding ${h.assetCode} on ${h.chain} missing bridge transfer ID`
      );
    }
  }
  
  return risks;
}
