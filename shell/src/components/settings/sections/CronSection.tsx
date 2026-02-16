"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { getGatewayUrl } from "@/lib/gateway";
import { ClockIcon, PlusIcon, TrashIcon } from "lucide-react";

const GATEWAY = getGatewayUrl();

interface CronJob {
  id: string;
  name: string;
  message: string;
  schedule: {
    type: "interval" | "cron" | "once";
    intervalMs?: number;
    cron?: string;
    at?: string;
  };
  target?: { channel: string; chatId: string };
  createdAt: string;
}

function formatSchedule(schedule: CronJob["schedule"]): string {
  if (schedule.type === "interval" && schedule.intervalMs) {
    const minutes = Math.round(schedule.intervalMs / 60000);
    if (minutes >= 60) return `Every ${Math.round(minutes / 60)}h`;
    return `Every ${minutes}m`;
  }
  if (schedule.type === "cron" && schedule.cron) return schedule.cron;
  if (schedule.type === "once" && schedule.at) {
    return new Date(schedule.at).toLocaleString();
  }
  return "Unknown";
}

const SCHEDULE_HELPERS: Record<string, string> = {
  interval: "Interval in minutes (e.g. 30)",
  cron: "Cron expression (e.g. 0 9 * * *)",
  once: "Date and time (e.g. 2026-03-01T09:00)",
};

export function CronSection() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    message: "",
    scheduleType: "interval" as "interval" | "cron" | "once",
    scheduleValue: "",
  });

  const loadJobs = useCallback(async () => {
    try {
      const r = await fetch(`${GATEWAY}/api/cron`);
      if (r.ok) setJobs(await r.json());
    } catch { /* skip */ }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  async function handleDelete(id: string) {
    try {
      const res = await fetch(`${GATEWAY}/api/cron/${id}`, { method: "DELETE" });
      if (res.ok) await loadJobs();
    } catch { /* skip */ }
  }

  async function handleCreate() {
    if (!form.name.trim() || !form.message.trim() || !form.scheduleValue.trim()) return;

    let schedule: CronJob["schedule"];
    switch (form.scheduleType) {
      case "interval":
        schedule = { type: "interval", intervalMs: Number(form.scheduleValue) * 60000 };
        break;
      case "cron":
        schedule = { type: "cron", cron: form.scheduleValue };
        break;
      case "once":
        schedule = { type: "once", at: new Date(form.scheduleValue).toISOString() };
        break;
    }

    setSaving(true);
    try {
      const res = await fetch(`${GATEWAY}/api/cron`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, message: form.message, schedule }),
      });
      if (res.ok) {
        setDialogOpen(false);
        setForm({ name: "", message: "", scheduleType: "interval", scheduleValue: "" });
        await loadJobs();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Cron Jobs</h2>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setDialogOpen(true)}>
          <PlusIcon className="size-3 mr-1" />
          Add Job
        </Button>
      </div>

      {jobs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <ClockIcon className="size-8 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium">No cron jobs</p>
            <p className="text-xs text-muted-foreground mt-1">
              Schedule recurring tasks like daily summaries or reminders.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <Card key={job.id} className="gap-0">
              <CardHeader className="py-3 px-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <ClockIcon className="size-4 text-primary" />
                    <CardTitle className="text-sm font-medium">{job.name}</CardTitle>
                    <Badge variant="secondary" className="text-xs font-mono">
                      {formatSchedule(job.schedule)}
                    </Badge>
                    {job.target?.channel && (
                      <Badge variant="outline" className="text-xs">
                        {job.target.channel}
                      </Badge>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground"
                    onClick={() => handleDelete(job.id)}
                  >
                    <TrashIcon className="size-3" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1 ml-7 truncate">
                  {job.message}
                </p>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Cron Job</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cron-name">Job Name</Label>
              <Input
                id="cron-name"
                placeholder="e.g. Daily Summary"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cron-message">Message / Prompt</Label>
              <Textarea
                id="cron-message"
                placeholder="What should the agent do when triggered?"
                rows={3}
                value={form.message}
                onChange={(e) => setForm({ ...form, message: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Schedule Type</Label>
              <Select
                value={form.scheduleType}
                onValueChange={(v) =>
                  setForm({ ...form, scheduleType: v as "interval" | "cron" | "once", scheduleValue: "" })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="interval">Interval</SelectItem>
                  <SelectItem value="cron">Cron Expression</SelectItem>
                  <SelectItem value="once">One-time</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cron-value">Schedule Value</Label>
              <Input
                id="cron-value"
                placeholder={SCHEDULE_HELPERS[form.scheduleType]}
                value={form.scheduleValue}
                onChange={(e) => setForm({ ...form, scheduleValue: e.target.value })}
                type={form.scheduleType === "once" ? "datetime-local" : "text"}
              />
              <p className="text-xs text-muted-foreground">{SCHEDULE_HELPERS[form.scheduleType]}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={handleCreate}
              disabled={!form.name.trim() || !form.message.trim() || !form.scheduleValue.trim() || saving}
            >
              {saving ? "Creating..." : "Create Job"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
