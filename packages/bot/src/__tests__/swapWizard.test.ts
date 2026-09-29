import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { SwapWizard } from "../swapWizard";
import {
  BotWorkflowManager,
  WorkflowState,
} from "../services/workflowService";
import { CallbackAction, packCallback } from "../callbackUtils";

interface PersistedSession {
  id: string;
  userId: string;
  platform: string;
  sessionType: string;
  step: number;
  sessionData: Record<string, unknown>;
  expiresAt: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Not Found",
    json: async () => body,
  } as Response;
}

function installSessionApi(): Map<string, PersistedSession> {
  const sessions = new Map<string, PersistedSession>();
  let nextId = 1;

  jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.pathname.endsWith("/check-risk")) {
      return response({ allowed: true });
    }

    if (url.pathname === "/api/bot/session" && method === "GET") {
      const session = Array.from(sessions.values()).find(
        (candidate) =>
          candidate.isActive &&
          candidate.userId === url.searchParams.get("userId") &&
          candidate.platform === url.searchParams.get("platform") &&
          candidate.sessionType === url.searchParams.get("sessionType")
      );

      if (!session || !session.isActive) {
        return response({ success: false }, 404);
      }
      if (Date.parse(session.expiresAt) <= Date.now()) {
        session.isActive = false;
        return response({ success: false }, 404);
      }
      return response({ success: true, session });
    }

    if (url.pathname === "/api/bot/session" && method === "POST") {
      const data = JSON.parse(String(init?.body)) as Omit<
        PersistedSession,
        "id" | "isActive" | "createdAt" | "updatedAt" | "expiresAt"
      > & { expiresAt?: string };
      const now = new Date().toISOString();
      const session: PersistedSession = {
        ...data,
        id: `session-${nextId++}`,
        expiresAt:
          data.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.id, session);
      return response({ success: true, session });
    }

    const sessionMatch = url.pathname.match(/^\/api\/bot\/session\/([^/]+)$/);
    if (sessionMatch && method === "PUT") {
      const session = sessions.get(sessionMatch[1]);
      if (!session) return response({ success: false }, 404);
      Object.assign(session, JSON.parse(String(init?.body)), {
        updatedAt: new Date().toISOString(),
      });
      return response({ success: true, session });
    }

    return response({ success: false }, 404);
  });

  return sessions;
}

describe("SwapWizard", () => {
  let wizard: SwapWizard;

  beforeEach(() => {
    wizard = new SwapWizard();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("start()", () => {
    it("should return initial step and inline buttons", () => {
      const res = wizard.start("user1", "telegram");
      expect(res.nextStep).toBe(1);
      expect(res.message).toMatch(/Which asset do you want to \*\*sell\*\*/);
      expect(res.buttons).toBeDefined();
      expect(res.buttons![0].length).toBeGreaterThan(1);
    });
  });

  describe("processInput() - typed callback transitions", () => {
    it("should process SELECT_FROM_ASSET callback", async () => {
      const state: WorkflowState = {
        workflowId: "test",
        userId: "user1",
        platform: "telegram",
        type: "swap_wizard",
        step: 1,
        data: {},
        isComplete: false,
      };

      const input = packCallback(CallbackAction.SELECT_FROM_ASSET, {
        a: "XLM",
      });
      const res = await wizard.processInput(state, input);

      expect(res.nextStep).toBe(2);
      expect(res.data?.fromAsset).toBe("XLM");
      expect(res.buttons).toBeDefined();
      expect(res.message).toMatch(/Selling \*\*XLM\*\*/);
    });

    it("should process SELECT_TO_ASSET callback", async () => {
      const state: WorkflowState = {
        workflowId: "test",
        userId: "user1",
        platform: "telegram",
        type: "swap_wizard",
        step: 2,
        data: { fromAsset: "XLM" },
        isComplete: false,
      };

      const input = packCallback(CallbackAction.SELECT_TO_ASSET, { a: "USDC" });
      const res = await wizard.processInput(state, input);

      expect(res.nextStep).toBe(3);
      expect(res.data?.toAsset).toBe("USDC");
      expect(res.message).toMatch(/How much/);
      expect(res.buttons).toBeUndefined(); // text input step
    });

    it("should process CONFIRM_SWAP callback", async () => {
      const state: WorkflowState = {
        workflowId: "test",
        userId: "user1",
        platform: "telegram",
        type: "swap_wizard",
        step: 4,
        data: { fromAsset: "XLM", toAsset: "USDC", amount: "100" },
        isComplete: false,
      };

      const input = packCallback(CallbackAction.CONFIRM_SWAP);
      const res = await wizard.processInput(state, input);

      expect(res.isComplete).toBe(true);
      expect(res.message).toMatch(/Swap executed/);
    });
  });

  describe("processInput() - text fallback transitions", () => {
    it("should process valid text input for asset selection", async () => {
      const state: WorkflowState = {
        workflowId: "test",
        userId: "user1",
        platform: "telegram",
        type: "swap_wizard",
        step: 1,
        data: {},
        isComplete: false,
      };

      const res = await wizard.processInput(state, "xlm");

      expect(res.nextStep).toBe(2);
      expect(res.data?.fromAsset).toBe("XLM");
    });

    it("should reject invalid text input for asset selection", async () => {
      const state: WorkflowState = {
        workflowId: "test",
        userId: "user1",
        platform: "telegram",
        type: "swap_wizard",
        step: 1,
        data: {},
        isComplete: false,
      };

      const res = await wizard.processInput(state, "unknown_asset");

      expect(res.nextStep).toBeUndefined(); // Stays on same step
      expect(res.message).toMatch(/Unknown asset/);
      expect(res.buttons).toBeDefined();
    });

    it("should process valid text input for amount", async () => {
      const state: WorkflowState = {
        workflowId: "test",
        userId: "user1",
        platform: "telegram",
        type: "swap_wizard",
        step: 3,
        data: { fromAsset: "XLM", toAsset: "USDC" },
        isComplete: false,
      };

      const res = await wizard.processInput(state, "50.5");

      expect(res.nextStep).toBe(4);
      expect(res.data?.amount).toBe("50.5");
      expect(res.buttons).toBeDefined();
    });
  });

  describe("processInput() - invalid / unexpected actions", () => {
    it("should safely handle unknown callback actions", async () => {
      const state: WorkflowState = {
        workflowId: "test",
        userId: "user1",
        platform: "telegram",
        type: "swap_wizard",
        step: 2,
        data: {},
        isComplete: false,
      };

      // Create a typed callback with a valid action code that isn't handled here
      const input = packCallback(CallbackAction.SET_THRESHOLD);
      const res = await wizard.processInput(state, input);

      expect(res.message).toMatch(/Unknown action/);
    });
  });

  describe("persisted session recovery", () => {
    it("resumes the persisted wizard step after recreating process state", async () => {
      const sessions = installSessionApi();
      const firstProcess = new BotWorkflowManager("http://bot-api.test");
      firstProcess.registerWorkflow(new SwapWizard());

      const started = await firstProcess.startWorkflow(
        "user1",
        "telegram",
        "swap_wizard"
      );
      expect(started.nextStep).toBe(1);

      const selectedSource = await firstProcess.handleInput(
        "user1",
        "telegram",
        "xlm"
      );
      expect(selectedSource?.nextStep).toBe(2);
      expect(Array.from(sessions.values())[0]).toMatchObject({
        step: 2,
        sessionData: { fromAsset: "XLM" },
        isActive: true,
      });

      const restartedProcess = new BotWorkflowManager("http://bot-api.test");
      restartedProcess.registerWorkflow(new SwapWizard());
      const resumed = await restartedProcess.handleInput(
        "user1",
        "telegram",
        "USDC"
      );

      expect(resumed?.nextStep).toBe(3);
      expect(resumed?.data).toMatchObject({
        fromAsset: "XLM",
        toAsset: "USDC",
      });
      expect(Array.from(sessions.values())[0]).toMatchObject({
        step: 3,
        sessionData: { fromAsset: "XLM", toAsset: "USDC" },
      });
    });

    it("rejects inactive and expired sessions after restart", async () => {
      const sessions = installSessionApi();
      const now = new Date().toISOString();
      const inactiveSession: PersistedSession = {
        id: "inactive-session",
        userId: "user1",
        platform: "telegram",
        sessionType: "swap_wizard",
        step: 2,
        sessionData: { fromAsset: "XLM" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        isActive: false,
        createdAt: now,
        updatedAt: now,
      };
      const expiredSession: PersistedSession = {
        ...inactiveSession,
        id: "expired-session",
        isActive: true,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      };
      sessions.set(inactiveSession.id, inactiveSession);
      sessions.set(expiredSession.id, expiredSession);

      const restartedProcess = new BotWorkflowManager("http://bot-api.test");
      restartedProcess.registerWorkflow(new SwapWizard());
      const result = await restartedProcess.handleInput(
        "user1",
        "telegram",
        "USDC"
      );

      expect(result).toBeNull();
      expect(expiredSession.isActive).toBe(false);
      expect(inactiveSession.isActive).toBe(false);
    });

    it("rejects workflow callbacks from another user, message, or session", async () => {
      const sessions = installSessionApi();
      const manager = new BotWorkflowManager("http://bot-api.test");
      manager.registerWorkflow(new SwapWizard());
      await manager.startWorkflow("user1", "telegram", "swap_wizard");

      const origin = manager.bindWorkflowMessage(
        "user1",
        "telegram",
        "message-1"
      )!;
      const callback = packCallback(CallbackAction.SELECT_FROM_ASSET, {
        a: "XLM",
      });

      const wrongMessage = await manager.handleInput(
        "user1",
        "telegram",
        callback,
        "message-2"
      );
      expect(wrongMessage?.message).toMatch(/does not belong/);

      const wrongOwner = await manager.handleInput(
        "user2",
        "telegram",
        callback,
        origin.messageId
      );
      expect(wrongOwner).toBeNull();

      const wrongWorkflow = await manager.handleInput(
        "user1",
        "telegram",
        callback,
        "old-workflow-message"
      );
      expect(wrongWorkflow?.message).toMatch(/does not belong/);
      expect(Array.from(sessions.values())[0].step).toBe(1);

      const accepted = await manager.handleInput(
        "user1",
        "telegram",
        callback,
        origin.messageId
      );
      expect(accepted?.nextStep).toBe(2);
      expect(accepted?.data?.fromAsset).toBe("XLM");
    });
  });
});
