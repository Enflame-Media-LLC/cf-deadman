<script setup lang="ts">
import { ref } from "vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

defineProps<{ busy?: boolean }>();
const emit = defineEmits<{ submit: [input: { setupSecret: string; email: string; password: string }] }>();
const setupSecret = ref("");
const email = ref("");
const password = ref("");
</script>

<template>
  <Card class="mx-auto max-w-lg"><CardHeader><CardTitle class="text-2xl">Claim this deployment</CardTitle><CardDescription>There is one owner per deployment. Enter the setup secret configured in Cloudflare and create the owner account.</CardDescription></CardHeader><CardContent>
    <form class="space-y-4" @submit.prevent="emit('submit', { setupSecret, email, password })">
      <div class="space-y-2"><Label for="setup-secret">Setup secret</Label><Input id="setup-secret" v-model="setupSecret" type="password" autocomplete="off" required /></div>
      <div class="space-y-2"><Label for="setup-email">Email</Label><Input id="setup-email" v-model="email" type="email" autocomplete="email" required /></div>
      <div class="space-y-2"><Label for="setup-password">Password</Label><Input id="setup-password" v-model="password" type="password" minlength="12" autocomplete="new-password" required /></div>
      <Button type="submit" :disabled="busy" class="w-full">{{ busy ? 'Creating owner…' : 'Create owner' }}</Button>
    </form>
  </CardContent></Card>
</template>
