<script setup lang="ts">
import { computed, ref } from "vue";
import type { CheckInMethod, SwitchStatus } from "../api";
import { formatDueAt } from "../format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const props = withDefaults(defineProps<{
  status: SwitchStatus;
  methods?: CheckInMethod[];
  timeZone?: string;
  busy?: boolean;
  message?: string;
}>(), { methods: () => ["session"] });
const emit = defineEmits<{ checkIn: [code?: string]; togglePause: [paused: boolean] }>();
const code = ref("");
const sessionAllowed = computed(() => props.methods.includes("session") || props.methods.includes("session_totp"));
const codeRequired = computed(() => !props.methods.includes("session") && props.methods.includes("session_totp"));
const due = computed(() => formatDueAt(props.status.nextDueAt, props.timeZone));
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div><p class="text-sm uppercase tracking-[.2em] text-muted-foreground">Current cycle</p><h2 class="text-3xl font-semibold tracking-tight">Your switch</h2></div>
      <Badge :variant="status.paused ? 'outline' : 'secondary'">{{ status.paused ? 'Paused' : status.armed ? 'Armed' : 'Unarmed' }}</Badge>
    </div>
    <Card class="border-primary/30 bg-gradient-to-br from-card to-[#102b35]">
      <CardHeader><CardDescription>Next scheduled deadline</CardDescription><CardTitle class="text-3xl">{{ due }}</CardTitle></CardHeader>
      <CardContent class="space-y-4">
        <p class="text-sm text-muted-foreground">A successful check-in begins a new cycle and cancels pending actions from the previous cycle.</p>
        <div v-if="sessionAllowed" class="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div v-if="methods.includes('session_totp')" class="space-y-2">
            <Label for="checkin-code">Separate check-in code{{ codeRequired ? ' (required)' : ' (optional)' }}</Label>
            <Input id="checkin-code" v-model="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="6-digit code" class="max-w-48" />
          </div>
          <Button :disabled="busy || (codeRequired && code.length !== 6)" @click="emit('checkIn', code || undefined)">{{ busy ? 'Checking in…' : 'Check in' }}</Button>
        </div>
        <p v-else class="text-sm text-muted-foreground">This deployment currently accepts API key check-ins. Configure or use a scoped key in Check-in policy.</p>
        <p v-if="message" role="status" class="text-sm text-primary">{{ message }}</p>
      </CardContent>
    </Card>
    <div class="grid gap-3 md:grid-cols-2">
      <Card><CardHeader><CardTitle class="text-lg">Schedule</CardTitle><CardDescription>{{ status.rounds.length }} {{ status.rounds.length === 1 ? 'round' : 'rounds' }} in this revision</CardDescription></CardHeader>
        <CardContent><ul v-if="status.rounds.length" class="space-y-3"><li v-for="(round, index) in status.rounds" :key="round.id" class="flex items-center justify-between gap-3 border-t border-border pt-3 text-sm"><span>Round {{ index + 1 }}<span v-if="round.manualRearm" class="ml-2 text-muted-foreground">Manual rearm</span></span><span class="text-right">{{ formatDueAt(round.dueAt, timeZone) }}</span></li></ul><p v-else class="text-sm text-muted-foreground">No schedule revision has been saved yet.</p></CardContent>
      </Card>
      <Card><CardHeader><CardTitle class="text-lg">Delivery state</CardTitle><CardDescription>Foundation release</CardDescription></CardHeader><CardContent><p class="text-sm text-muted-foreground">Outbound actions are not configured in this release. The switch remains unarmed until delivery adapters are added and verified.</p></CardContent></Card>
    </div>
    <div class="flex justify-end"><Button variant="outline" :disabled="busy" @click="emit('togglePause', !status.paused)">{{ status.paused ? 'Resume new claims' : 'Pause new claims' }}</Button></div>
  </div>
</template>
