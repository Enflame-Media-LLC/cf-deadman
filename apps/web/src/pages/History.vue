<script setup lang="ts">
import type { History } from "../api";
import { formatDueAt } from "../format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

defineProps<{ history: History; timeZone?: string }>();
</script>

<template>
  <div class="space-y-6"><div><p class="text-sm uppercase tracking-[.2em] text-muted-foreground">Audit trail</p><h2 class="text-3xl font-semibold tracking-tight">History</h2></div>
    <Card><CardHeader><CardTitle>Round runs</CardTitle><CardDescription>Most recent 200 runs, including skipped and canceled rounds.</CardDescription></CardHeader><CardContent><div v-if="history.runs.length" class="overflow-x-auto"><table class="w-full text-left text-sm"><thead class="text-muted-foreground"><tr><th class="pb-2">Due</th><th class="pb-2">Status</th><th class="pb-2">Round</th></tr></thead><tbody><tr v-for="run in history.runs" :key="run.id" class="border-t border-border"><td class="py-3">{{ formatDueAt(run.due_at, timeZone) }}</td><td class="py-3 capitalize">{{ run.status.replace('_', ' ') }}</td><td class="py-3 font-mono text-xs">{{ run.round_id.slice(0, 12) }}…</td></tr></tbody></table></div><p v-else class="text-sm text-muted-foreground">No rounds have run yet.</p></CardContent></Card>
    <Card><CardHeader><CardTitle>Schedule revisions</CardTitle><CardDescription>Saved revisions are immutable.</CardDescription></CardHeader><CardContent><ul v-if="history.revisions.length" class="space-y-2"><li v-for="revision in history.revisions" :key="revision.id" class="flex justify-between gap-3 border-t border-border pt-2 text-sm"><span>Revision {{ revision.version }}</span><span class="text-muted-foreground">{{ formatDueAt(revision.created_at, timeZone) }}</span></li></ul><p v-else class="text-sm text-muted-foreground">No schedule revision has been saved yet.</p></CardContent></Card>
  </div>
</template>
