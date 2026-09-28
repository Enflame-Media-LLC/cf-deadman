<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const props = defineProps<{ uri?: string; backupCodes?: string[]; busy?: boolean }>();
const emit = defineEmits<{ start: [password: string]; verify: [code: string] }>();
const password = ref("");
const code = ref("");
const secret = computed(() => props.uri ? new URL(props.uri).searchParams.get("secret") : "");
</script>

<template>
  <Card class="mx-auto max-w-xl"><CardHeader><CardTitle class="text-2xl">Protect administrator access</CardTitle><CardDescription>Administrator TOTP is required before policy or schedule changes. Store the recovery codes safely.</CardDescription></CardHeader><CardContent class="space-y-5">
    <form v-if="!uri" class="space-y-3" @submit.prevent="emit('start', password)"><Label for="enroll-password">Confirm your password</Label><Input id="enroll-password" v-model="password" type="password" autocomplete="current-password" required /><Button type="submit" :disabled="busy">Set up TOTP</Button></form>
    <template v-else>
      <div class="space-y-2"><p class="text-sm text-muted-foreground">Add this account to your authenticator with the secret below or its URI.</p><p class="break-all rounded-lg border border-border p-3 font-mono text-sm">{{ secret }}</p><details class="text-xs"><summary class="cursor-pointer">Show authenticator URI</summary><p class="mt-2 break-all">{{ uri }}</p></details></div>
      <div v-if="backupCodes?.length" class="space-y-2"><p class="font-medium">One-time recovery codes</p><ul class="grid gap-1 font-mono text-sm sm:grid-cols-2"><li v-for="item in backupCodes" :key="item">{{ item }}</li></ul></div>
      <form class="space-y-3" @submit.prevent="emit('verify', code)"><Label for="enroll-code">Verify a code from your authenticator</Label><Input id="enroll-code" v-model="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" required /><Button type="submit" :disabled="busy || code.length !== 6">Finish setup</Button></form>
    </template>
  </CardContent></Card>
</template>
