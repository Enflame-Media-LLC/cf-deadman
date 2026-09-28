import { ref } from "vue";

export type CheckInMethod = "session" | "session_totp" | "api_key" | "api_key_totp";
export type SwitchStatus = {
  ownerId: string;
  activeRevisionId: string | null;
  cycleId: string;
  cycleStartedAt: string;
  armed: boolean;
  paused: boolean;
  nextDueAt: string | null;
  rounds: { id: string; dueAt: string; manualRearm: boolean; armed: boolean }[];
};
export type CheckInPolicy = { methods: CheckInMethod[]; hasSeparateTotp: boolean; setupUri?: string };
export type CheckInOutcome = { cycleId: string; nextDueAt: string | null };
export type KeyMetadata = { id: string; created_at: string; expires_at: string | null; revoked_at: string | null };
export type History = {
  revisions: { id: string; version: number; definition_json: string; created_at: string }[];
  runs: { id: string; cycle_id: string; round_id: string; status: string; due_at: string; started_at: string | null; finished_at: string | null }[];
  actionRuns: { id: string; round_run_id: string; action_id: string; kind: string; status: string; reason: string | null; claimed_at: string | null; finished_at: string | null }[];
  checkIns: { id: string; cycle_id: string; method: string; key_id: string | null; session_id: string | null; accepted_at: string }[];
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createSwitchClient(fetcher: Fetcher = fetch) {
  const status = ref<SwitchStatus | null>(null);

  async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetcher(url, { credentials: "same-origin", ...init });
    const result = await response.json().catch(() => null) as T | { message?: string; error?: string } | null;
    if (!response.ok) {
      const detail = result && typeof result === "object" && ("message" in result || "error" in result)
        ? ("message" in result ? result.message : result.error) : undefined;
      throw new Error(detail || `Request failed (${response.status})`);
    }
    return result as T;
  }

  const jsonPost = <T>(url: string, body: unknown) => request<T>(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const jsonPut = <T>(url: string, body: unknown) => request<T>(url, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  return {
    status,
    setupStatus: () => request<{ claimed: boolean }>("/api/setup/status"),
    claimOwner: (input: { setupSecret: string; email: string; password: string }) =>
      jsonPost<{ ownerId: string }>("/api/setup", input),
    signIn: (email: string, password: string) =>
      jsonPost<{ twoFactorRedirect?: boolean; user?: { twoFactorEnabled?: boolean } }>("/api/auth/sign-in/email", { email, password }),
    session: () => request<{ user?: { twoFactorEnabled?: boolean } } | null>("/api/auth/get-session"),
    signOut: () => jsonPost<{ success: boolean }>("/api/auth/sign-out", {}),
    completeTotp: (code: string) => jsonPost<{ status: boolean }>("/api/auth/two-factor/verify-totp", { code, trustDevice: false }),
    enableTotp: (password: string) => jsonPost<{ totpURI: string; backupCodes?: string[] }>("/api/auth/two-factor/enable", { password }),
    async loadStatus() {
      status.value = await request<SwitchStatus>("/api/switch");
      return status.value;
    },
    async checkIn(code?: string): Promise<CheckInOutcome> {
      const outcome = await request<CheckInOutcome>("/api/check-ins", {
        method: "POST", headers: code ? { "x-checkin-totp": code } : {},
      });
      await this.loadStatus();
      return outcome;
    },
    getPolicy: () => request<CheckInPolicy>("/api/check-in-policy"),
    savePolicy: (methods: CheckInMethod[], regenerateTotp = false) =>
      jsonPut<CheckInPolicy>("/api/check-in-policy", { methods, regenerateTotp }),
    listKeys: () => request<{ keys: KeyMetadata[] }>("/api/check-in-keys"),
    issueKey: (name: string, expiresInSeconds?: number) =>
      jsonPost<{ id: string; key: string }>("/api/check-in-keys", { name, expiresInSeconds }),
    revokeKey: (id: string) => request<{ revoked: boolean }>(`/api/check-in-keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
    getHistory: () => request<History>("/api/switch/history"),
    pause: (paused: boolean) => jsonPut<{ paused: boolean }>("/api/switch/paused", { paused }),
  };
}

export const api = createSwitchClient();
