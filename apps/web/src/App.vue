<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, type CheckInMethod, type CheckInPolicy, type History, type KeyMetadata } from "./api";
import { Button } from "@/components/ui/button";
import Dashboard from "./pages/Dashboard.vue";
import EnrollTotp from "./pages/EnrollTotp.vue";
import HistoryPage from "./pages/History.vue";
import Policy from "./pages/Policy.vue";
import Setup from "./pages/Setup.vue";
import SignIn from "./pages/SignIn.vue";

type Screen = "loading" | "setup" | "signin" | "signin-totp" | "enroll" | "owner";
type Tab = "dashboard" | "policy" | "history";
const screen = ref<Screen>("loading");
const tab = ref<Tab>("dashboard");
const busy = ref(false);
const error = ref("");
const notice = ref("");
const signInPassword = ref("");
const enrollUri = ref("");
const backupCodes = ref<string[]>([]);
const adminCode = ref("");
const issuedKey = ref("");
const policy = ref<CheckInPolicy>({ methods: ["session"], hasSeparateTotp: false });
const keys = ref<KeyMetadata[]>([]);
const history = ref<History>({ revisions: [], runs: [], actionRuns: [], checkIns: [] });
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function attempt(action: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  try { await action(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "Request failed"; }
  finally { busy.value = false; }
}

async function refreshOwnerData() {
  await api.loadStatus();
  const [savedPolicy, savedKeys, savedHistory] = await Promise.all([
    api.getPolicy(), api.listKeys(), api.getHistory(),
  ]);
  policy.value = savedPolicy;
  keys.value = savedKeys.keys;
  history.value = savedHistory;
}

async function enterOwner() {
  await api.loadStatus();
  const session = await api.session();
  if (!session?.user?.twoFactorEnabled) {
    screen.value = "enroll";
    return;
  }
  await refreshOwnerData();
  screen.value = "owner";
}

onMounted(() => {
  void attempt(async () => {
    const setup = await api.setupStatus();
    if (!setup.claimed) { screen.value = "setup"; return; }
    try { await enterOwner(); }
    catch { screen.value = "signin"; }
  });
});

function claim(input: { setupSecret: string; email: string; password: string }) {
  void attempt(async () => {
    await api.claimOwner(input);
    signInPassword.value = input.password;
    const login = await api.signIn(input.email, input.password);
    screen.value = login.twoFactorRedirect ? "signin-totp" : "enroll";
    notice.value = "Owner account created. Set up administrator TOTP to continue.";
  });
}

function signIn(email: string, password: string) {
  void attempt(async () => {
    signInPassword.value = password;
    const login = await api.signIn(email, password);
    if (login.twoFactorRedirect) screen.value = "signin-totp";
    else await enterOwner();
  });
}

function verifySignIn(code: string) {
  void attempt(async () => {
    await api.completeTotp(code);
    await enterOwner();
  });
}

function beginEnrollment(password: string) {
  void attempt(async () => {
    const enrollment = await api.enableTotp(password || signInPassword.value);
    enrollUri.value = enrollment.totpURI;
    backupCodes.value = enrollment.backupCodes ?? [];
  });
}

function finishEnrollment(code: string) {
  void attempt(async () => {
    await api.completeTotp(code);
    enrollUri.value = "";
    backupCodes.value = [];
    signInPassword.value = "";
    await enterOwner();
  });
}

function checkIn(code?: string) {
  void attempt(async () => {
    const result = await api.checkIn(code);
    notice.value = result.nextDueAt ? "Check-in accepted. Your deadline has been reset." : "Check-in accepted.";
  });
}

function verifyAdmin() {
  void attempt(async () => {
    await api.completeTotp(adminCode.value);
    adminCode.value = "";
    notice.value = "Administrator code verified for the next five minutes.";
  });
}

function savePolicy(methods: CheckInMethod[], regenerateTotp: boolean) {
  void attempt(async () => {
    policy.value = await api.savePolicy(methods, regenerateTotp);
    notice.value = "Check-in policy saved.";
  });
}

function issueKey(name: string) {
  void attempt(async () => {
    const created = await api.issueKey(name);
    issuedKey.value = created.key;
    keys.value = (await api.listKeys()).keys;
    notice.value = "Key created. Save its value now; it cannot be retrieved again.";
  });
}

function revokeKey(id: string) {
  void attempt(async () => {
    await api.revokeKey(id);
    keys.value = (await api.listKeys()).keys;
    issuedKey.value = "";
    notice.value = "Key revoked.";
  });
}

function togglePause(paused: boolean) {
  void attempt(async () => {
    await api.pause(paused);
    await api.loadStatus();
    notice.value = paused ? "New round claims paused." : "New round claims resumed.";
  });
}

function selectTab(value: Tab) {
  tab.value = value;
  error.value = "";
  notice.value = "";
  issuedKey.value = "";
  if (value === "history") void attempt(async () => { history.value = await api.getHistory(); });
  if (value === "policy") void attempt(async () => {
    policy.value = await api.getPolicy();
    keys.value = (await api.listKeys()).keys;
  });
}

function signOut() {
  void attempt(async () => {
    await api.signOut();
    api.status.value = null;
    screen.value = "signin";
    tab.value = "dashboard";
    notice.value = "";
    issuedKey.value = "";
  });
}
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <header class="border-b border-border/80"><div class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-5"><div><div class="text-xs font-semibold uppercase tracking-[.32em] text-primary">CF Deadman</div><div class="mt-1 text-sm text-muted-foreground">A single-owner check-in switch on Cloudflare</div></div>
      <nav v-if="screen === 'owner'" aria-label="Main navigation" class="flex flex-wrap items-center gap-1"><Button :variant="tab === 'dashboard' ? 'secondary' : 'ghost'" @click="selectTab('dashboard')">Dashboard</Button><Button :variant="tab === 'policy' ? 'secondary' : 'ghost'" @click="selectTab('policy')">Check-in policy</Button><Button :variant="tab === 'history' ? 'secondary' : 'ghost'" @click="selectTab('history')">History</Button><Button variant="ghost" @click="signOut">Sign out</Button></nav>
    </div></header>
    <main class="mx-auto max-w-6xl px-5 py-10">
      <div v-if="error" role="alert" class="mb-6 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">{{ error }}</div>
      <div v-if="notice && screen !== 'owner'" role="status" class="mb-6 rounded-lg border border-primary/50 bg-primary/10 p-4 text-sm text-primary">{{ notice }}</div>
      <p v-if="screen === 'loading'" class="text-muted-foreground">Loading deployment…</p>
      <Setup v-else-if="screen === 'setup'" :busy="busy" @submit="claim" />
      <SignIn v-else-if="screen === 'signin' || screen === 'signin-totp'" :step="screen === 'signin' ? 'password' : 'totp'" :busy="busy" @password="signIn" @totp="verifySignIn" />
      <EnrollTotp v-else-if="screen === 'enroll'" :uri="enrollUri" :backup-codes="backupCodes" :busy="busy" @start="beginEnrollment" @verify="finishEnrollment" />
      <template v-else-if="screen === 'owner'">
        <div v-if="notice" role="status" class="mb-6 rounded-lg border border-primary/50 bg-primary/10 p-4 text-sm text-primary">{{ notice }}</div>
        <Dashboard v-if="tab === 'dashboard' && api.status.value" :status="api.status.value" :methods="policy.methods" :time-zone="timeZone" :busy="busy" @check-in="checkIn" @toggle-pause="togglePause" />
        <div v-else-if="tab === 'policy'" class="space-y-6"><div class="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4"><div class="space-y-1"><label for="admin-code" class="text-sm font-medium">Verify administrator TOTP before changing settings</label><input id="admin-code" v-model="adminCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" class="block h-9 rounded-md border border-input bg-transparent px-3 text-sm" placeholder="6-digit code" /></div><Button variant="outline" :disabled="busy || adminCode.length !== 6" @click="verifyAdmin">Verify code</Button></div><Policy :policy="policy" :keys="keys" :issued-key="issuedKey" :busy="busy" @save="savePolicy" @issue-key="issueKey" @revoke-key="revokeKey" /></div>
        <HistoryPage v-else-if="tab === 'history'" :history="history" :time-zone="timeZone" />
      </template>
    </main>
    <footer class="mx-auto max-w-6xl px-5 pb-8 text-xs text-muted-foreground"><a href="/api/docs" class="underline underline-offset-4">API documentation</a> · Open source · Foundation release</footer>
  </div>
</template>
