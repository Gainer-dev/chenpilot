import * as StellarSdk from "@stellar/stellar-sdk";
import {
  assertAuthNotExpired,
  prepareSignedTransaction,
} from "../../src/services/soroban/signingPrep";
import { AuthExpiredError } from "../../src/services/soroban/errors";
import type { SimulationSuccess } from "../../src/services/soroban/sdkAdapter";

const TEST_CONTRACT_ID = "CABC1234567890";

describe("Soroban Service invokeContract", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SOROBAN_RPC_URL_TESTNET;
    delete process.env.SOROBAN_RPC_URL_MAINNET;
  });

  it("uses default testnet RPC URL and passphrase", async () => {
    process.env.SOROBAN_RPC_URL_TESTNET = "https://rpc-testnet.example";
    const { invokeContract } =
      await import("../../src/services/sorobanService");

    await invokeContract({
      network: "testnet",
      contractId: TEST_CONTRACT_ID,
      method: "ping",
      args: [],
    });

    expect(StellarSdk.SorobanRpc.Server).toHaveBeenCalledWith(
      "https://rpc-testnet.example",
      expect.any(Object)
    );

    const builderArgs = (StellarSdk.TransactionBuilder as jest.Mock).mock
      .calls[0][1];
    expect(builderArgs.networkPassphrase).toBe(StellarSdk.Networks.TESTNET);
  });

  it("uses default mainnet RPC URL and passphrase", async () => {
    process.env.SOROBAN_RPC_URL_MAINNET = "https://rpc-mainnet.example";
    const { invokeContract } =
      await import("../../src/services/sorobanService");

    await invokeContract({
      network: "mainnet",
      contractId: TEST_CONTRACT_ID,
      method: "ping",
      args: [],
    });

    expect(StellarSdk.SorobanRpc.Server).toHaveBeenCalledWith(
      "https://rpc-mainnet.example",
      expect.any(Object)
    );

    const builderArgs = (StellarSdk.TransactionBuilder as jest.Mock).mock
      .calls[0][1];
    expect(builderArgs.networkPassphrase).toBe(StellarSdk.Networks.PUBLIC);
  });

  it("rejects missing contractId", async () => {
    const { invokeContract } =
      await import("../../src/services/sorobanService");

    await expect(
      invokeContract({
        network: "testnet",
        contractId: "",
        method: "ping",
      })
    ).rejects.toThrow("contractId");
  });

  it("rejects missing method", async () => {
    const { invokeContract } =
      await import("../../src/services/sorobanService");

    await expect(
      invokeContract({
        network: "testnet",
        contractId: TEST_CONTRACT_ID,
        method: "",
      })
    ).rejects.toThrow("method");
  });

  it("returns expected result shape", async () => {
    const { invokeContract } =
      await import("../../src/services/sorobanService");

    const result = await invokeContract({
      network: "testnet",
      contractId: TEST_CONTRACT_ID,
      method: "ping",
      args: [1, "two"],
    });

    expect(result).toEqual(
      expect.objectContaining({
        network: "testnet",
        contractId: TEST_CONTRACT_ID,
        method: "ping",
        result: "mock_scval",
      })
    );
    expect(result.raw).toBeDefined();
  });

  it("binds simulation result to originating invocation", async () => {
    const { invokeContract } =
      await import("../../src/services/sorobanService");

    const result = await invokeContract({
      network: "mainnet",
      contractId: TEST_CONTRACT_ID,
      method: "execute",
      args: [],
    });

    expect(result.raw).toBeDefined();
    expect((result.raw as any).invocation).toEqual(
      expect.objectContaining({
        contractId: TEST_CONTRACT_ID,
        method: "execute",
        network: "mainnet",
      })
    );
    expect((result.raw as any).invocation.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
    );
  });

  it("preserves invocation binding across multiple calls", async () => {
    const { invokeContract } =
      await import("../../src/services/sorobanService");

    const result1 = await invokeContract({
      network: "testnet",
      contractId: "CCONTRACT1",
      method: "method1",
    });

    const result2 = await invokeContract({
      network: "mainnet",
      contractId: "CCONTRACT2",
      method: "method2",
    });

    expect((result1.raw as any).invocation.contractId).toBe("CCONTRACT1");
    expect((result1.raw as any).invocation.method).toBe("method1");
    expect((result2.raw as any).invocation.contractId).toBe("CCONTRACT2");
    expect((result2.raw as any).invocation.method).toBe("method2");
  });
});

describe("Soroban signingPrep auth expiry", () => {
  // Shape of a simulation result carrying Soroban auth entries. The
  // expiration ledger lives under credentials.sorobanAuthorization.
  const simWith = (auth: unknown[]): SimulationSuccess => ({
    result: { auth },
  });

  const xdrEntry = (expirationLedgerSeq: unknown): unknown => ({
    credentials: { sorobanAuthorization: { expirationLedgerSeq } },
  });

  it("rejects an authorization entry that expired before the current ledger", () => {
    expect(() => assertAuthNotExpired(simWith([xdrEntry(90)]), 100)).toThrow(
      AuthExpiredError
    );
  });

  it("reports the expired ledger and the current ledger in the message", () => {
    expect(() => assertAuthNotExpired(simWith([xdrEntry(90)]), 100)).toThrow(
      /90 < current ledger 100/
    );
  });

  it("rejects when any one of several entries has expired", () => {
    const sim = simWith([xdrEntry(500), xdrEntry(42), xdrEntry(400)]);
    expect(() => assertAuthNotExpired(sim, 100)).toThrow(AuthExpiredError);
  });

  it("accepts entries that expire on or after the current ledger", () => {
    const sim = simWith([xdrEntry(100), xdrEntry(250)]);
    expect(() => assertAuthNotExpired(sim, 100)).not.toThrow();
  });

  it("reads the expiration from the SDK AuthorizationEntry wrapper", () => {
    const entry = { getExpirationLedgerSeq: () => 10 };
    expect(() => assertAuthNotExpired(simWith([entry]), 100)).toThrow(
      AuthExpiredError
    );
  });

  it("unwraps XDR Int32, bigint, and string expirations", () => {
    const int32 = { toNumber: () => 10 };
    expect(() => assertAuthNotExpired(simWith([xdrEntry(int32)]), 100)).toThrow(
      AuthExpiredError
    );
    expect(() =>
      assertAuthNotExpired(simWith([xdrEntry(BigInt(10))]), 100)
    ).toThrow(AuthExpiredError);
    expect(() => assertAuthNotExpired(simWith([xdrEntry("10")]), 100)).toThrow(
      AuthExpiredError
    );
  });

  it("ignores entries without a readable expiration", () => {
    const sim = simWith([
      {},
      { credentials: {} },
      { credentials: { sorobanAuthorization: {} } },
      xdrEntry(undefined),
    ]);
    expect(() => assertAuthNotExpired(sim, 100)).not.toThrow();
  });

  it("skips the check when the current ledger is unknown", () => {
    const sim = simWith([xdrEntry(1)]);
    expect(() => assertAuthNotExpired(sim, 0)).not.toThrow();
    expect(() => assertAuthNotExpired(sim, Number.NaN)).not.toThrow();
  });

  it("is a no-op when the simulation carries no auth entries", () => {
    expect(() => assertAuthNotExpired({ result: {} }, 100)).not.toThrow();
    expect(() =>
      assertAuthNotExpired({ result: { auth: [] } }, 100)
    ).not.toThrow();
  });

  it("throws an AuthExpiredError carrying the AUTH_EXPIRED code", () => {
    try {
      assertAuthNotExpired(simWith([xdrEntry(90)]), 100);
      throw new Error("expected assertAuthNotExpired to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthExpiredError);
      expect((err as AuthExpiredError).code).toBe("AUTH_EXPIRED");
    }
  });

  describe("prepareSignedTransaction", () => {
    const unsignedTx = { type: "mock_tx" } as unknown as StellarSdk.Transaction;
    const context = {
      network: "testnet" as const,
      secretKey: "SABC...MOCKSECRET",
    };

    // The shared stellar mock has no assembleTransaction; install one locally
    // so this describe can assert whether assembly was ever reached.
    const assembleTransaction = jest.fn(() => ({
      sign: jest.fn(),
      toEnvelope: () => ({ toXDR: () => "base64_xdr" }),
    }));

    beforeAll(() => {
      (StellarSdk.SorobanRpc as unknown as Record<string, unknown>)[
        "assembleTransaction"
      ] = assembleTransaction;
    });

    beforeEach(() => {
      assembleTransaction.mockClear();
    });

    it("does not sign when an authorization entry has expired", () => {
      expect(() =>
        prepareSignedTransaction(unsignedTx, simWith([xdrEntry(90)]), {
          ...context,
          currentLedgerSeq: 100,
        })
      ).toThrow(AuthExpiredError);

      expect(assembleTransaction).not.toHaveBeenCalled();
    });

    it("signs when auth entries are still valid", () => {
      const result = prepareSignedTransaction(
        unsignedTx,
        simWith([xdrEntry(250)]),
        { ...context, currentLedgerSeq: 100 }
      );

      expect(assembleTransaction).toHaveBeenCalled();
      expect(result.signedXdr).toBe("base64_xdr");
    });

    it("preserves existing behavior when no current ledger is supplied", () => {
      const result = prepareSignedTransaction(
        unsignedTx,
        simWith([xdrEntry(90)]),
        context
      );

      expect(assembleTransaction).toHaveBeenCalled();
      expect(result.signedXdr).toBe("base64_xdr");
    });
  });
});
