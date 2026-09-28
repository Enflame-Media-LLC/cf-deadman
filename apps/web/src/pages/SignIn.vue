<script setup lang="ts">
import { ref } from "vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

defineProps<{ step: "password" | "totp"; busy?: boolean }>();
const emit = defineEmits<{ password: [email: string, password: string]; totp: [code: string] }>();
const email = ref("");
const password = ref("");
const code = ref("");
</script>

<template>
  <Card class="mx-auto max-w-lg"><CardHeader><CardTitle class="text-2xl">{{ step === 'password' ? 'Owner sign in' : 'Verify administrator code' }}</CardTitle><CardDescription>{{ step === 'password' ? 'Sign in to manage the switch and check in.' : 'Enter the current code from your administrator authenticator.' }}</CardDescription></CardHeader><CardContent>
    <form v-if="step === 'password'" class="space-y-4" @submit.prevent="emit('password', email, password)">
      <div class="space-y-2"><Label for="signin-email">Email</Label><Input id="signin-email" v-model="email" type="email" autocomplete="username" required /></div>
      <div class="space-y-2"><Label for="signin-password">Password</Label><Input id="signin-password" v-model="password" type="password" autocomplete="current-password" required /></div>
      <Button type="submit" :disabled="busy" class="w-full">Sign in</Button>
    </form>
    <form v-else class="space-y-4" @submit.prevent="emit('totp', code)">
      <div class="space-y-2"><Label for="signin-totp">Administrator TOTP</Label><Input id="signin-totp" v-model="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" required /></div>
      <Button type="submit" :disabled="busy || code.length !== 6" class="w-full">Verify code</Button>
    </form>
  </CardContent></Card>
</template>
