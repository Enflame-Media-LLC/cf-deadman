<script setup lang="ts">
import { ref, watch } from "vue";
import type { CheckInMethod, CheckInPolicy, KeyMetadata } from "../api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const props = withDefaults(defineProps<{
  policy: CheckInPolicy;
  keys?: KeyMetadata[];
  issuedKey?: string;
  busy?: boolean;
}>(), { keys: () => [] });
const emit = defineEmits<{
  save: [methods: CheckInMethod[], regenerateTotp: boolean];
  issueKey: [name: string];
  revokeKey: [id: string];
}>();
const choices: { value: CheckInMethod; label: string; description: string }[] = [
  { value: "session", label: "Owner session", description: "Use the signed-in web or iOS app." },
  { value: "session_totp", label: "Session and check-in code", description: "Require the separate check-in TOTP in addition to a session." },
  { value: "api_key", label: "API key", description: "Use a scoped key from a webhook or automation." },
  { value: "api_key_totp", label: "API key and check-in code", description: "Require both the scoped key and separate check-in TOTP." },
];
const methods = ref<CheckInMethod[]>([...props.policy.methods]);
const regenerateTotp = ref(false);
const keyName = ref("");
watch(() => props.policy.methods, (value) => { methods.value = [...value]; });
function toggle(method: CheckInMethod) {
  methods.value = methods.value.includes(method) ? methods.value.filter((item) => item !== method) : [...methods.value, method];
}
</script>

<template>
  <div class="space-y-6">
    <div><p class="text-sm uppercase tracking-[.2em] text-muted-foreground">Access</p><h2 class="text-3xl font-semibold tracking-tight">Check-in policy</h2><p class="mt-2 text-muted-foreground">Enable one or more ways to confirm you are here. Administrative changes always need a recent administrator TOTP proof.</p></div>
    <Card><CardHeader><CardTitle>Allowed methods</CardTitle><CardDescription>At least one method must remain enabled.</CardDescription></CardHeader><CardContent class="space-y-4">
      <label v-for="choice in choices" :key="choice.value" class="flex cursor-pointer gap-3 rounded-lg border border-border p-4">
        <input type="checkbox" :checked="methods.includes(choice.value)" class="mt-1 accent-primary" @change="toggle(choice.value)" />
        <span><span class="block font-medium">{{ choice.label }}</span><span class="block text-sm text-muted-foreground">{{ choice.description }}</span></span>
      </label>
      <label class="flex items-center gap-2 text-sm"><input v-model="regenerateTotp" type="checkbox" class="accent-primary" />Rotate separate check-in code</label>
      <Button :disabled="busy || !methods.length" @click="emit('save', methods, regenerateTotp)">Save policy</Button>
      <p v-if="policy.setupUri" class="break-all rounded-lg border border-primary/50 bg-primary/10 p-3 font-mono text-sm" role="status">New check-in authenticator URI (shown once): {{ policy.setupUri }}</p>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>Automation keys</CardTitle><CardDescription>Each key can only create check-ins. The value appears once when issued.</CardDescription></CardHeader><CardContent class="space-y-4">
      <p v-if="issuedKey" class="break-all rounded-lg border border-primary/50 bg-primary/10 p-3 font-mono text-sm" role="status">New key: {{ issuedKey }}</p>
      <div class="flex flex-wrap items-end gap-3"><div class="space-y-2"><Label for="key-name">Key name</Label><Input id="key-name" v-model="keyName" placeholder="Home automation" /></div><Button :disabled="busy || !keyName.trim()" @click="emit('issueKey', keyName.trim())">Create key</Button></div>
      <ul class="space-y-2"><li v-for="key in keys" :key="key.id" class="flex items-center justify-between gap-3 border-t border-border pt-2 text-sm"><span class="font-mono">{{ key.id.slice(0, 12) }}… <span v-if="key.revoked_at" class="text-muted-foreground">Revoked</span></span><Button v-if="!key.revoked_at" size="sm" variant="outline" :disabled="busy" @click="emit('revokeKey', key.id)">Revoke</Button></li></ul>
      <p class="text-xs text-muted-foreground">Send <code>POST /api/check-ins</code> with <code>Authorization: Bearer &lt;key&gt;</code>. Add <code>x-checkin-totp</code> when that method is enabled.</p>
    </CardContent></Card>
  </div>
</template>
