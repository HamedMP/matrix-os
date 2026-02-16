"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { getGatewayUrl } from "@/lib/gateway";
import { SparklesIcon, ChevronDownIcon, ChevronUpIcon, PlusIcon } from "lucide-react";

const GATEWAY = getGatewayUrl();

interface SkillInfo {
  name: string;
  description?: string;
  triggers?: string[];
  content?: string;
}

function parseSkillFrontmatter(name: string, raw: string): SkillInfo {
  const skill: SkillInfo = { name };
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (match) {
    const lines = match[1].split("\n");
    for (const line of lines) {
      const [key, ...rest] = line.split(":");
      const val = rest.join(":").trim();
      if (key.trim() === "description") skill.description = val;
      if (key.trim() === "triggers") {
        skill.triggers = val.replace(/[\[\]"]/g, "").split(",").map((t) => t.trim()).filter(Boolean);
      }
    }
  }
  skill.content = raw;
  return skill;
}

export function SkillsSection() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", triggers: "", body: "" });

  const loadSkills = useCallback(async () => {
    try {
      const res = await fetch(`${GATEWAY}/files/agents/skills/`);
      if (!res.ok) return;
      const text = await res.text();
      const files = text.match(/[\w-]+\.md/g) ?? [];
      const loaded: SkillInfo[] = [];
      for (const file of files) {
        try {
          const r = await fetch(`${GATEWAY}/files/agents/skills/${file}`);
          if (r.ok) {
            const content = await r.text();
            loaded.push(parseSkillFrontmatter(file.replace(".md", ""), content));
          }
        } catch { /* skip */ }
      }
      setSkills(loaded);
    } catch { /* skip */ }
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  async function handleCreate() {
    const slug = form.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) return;

    const triggers = form.triggers
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const frontmatter = [
      "---",
      `name: ${form.name}`,
      form.description ? `description: ${form.description}` : null,
      triggers.length > 0 ? `triggers: [${triggers.map((t) => `"${t}"`).join(", ")}]` : null,
      "---",
    ]
      .filter(Boolean)
      .join("\n");

    const content = `${frontmatter}\n\n${form.body}`;

    setSaving(true);
    try {
      const res = await fetch(`${GATEWAY}/files/agents/skills/${slug}.md`, {
        method: "PUT",
        body: content,
      });
      if (res.ok) {
        setDialogOpen(false);
        setForm({ name: "", description: "", triggers: "", body: "" });
        await loadSkills();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Skills</h2>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setDialogOpen(true)}>
          <PlusIcon className="size-3 mr-1" />
          Add Skill
        </Button>
      </div>

      {skills.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <SparklesIcon className="size-8 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium">No skills installed</p>
            <p className="text-xs text-muted-foreground mt-1">
              Skills extend your agent's capabilities. Add one above or ask in the chat.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {skills.map((skill) => (
            <Card key={skill.name} className="gap-0">
              <CardHeader
                className="cursor-pointer py-3 px-4"
                onClick={() => setExpanded(expanded === skill.name ? null : skill.name)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <SparklesIcon className="size-4 text-primary" />
                    <CardTitle className="text-sm font-medium">{skill.name}</CardTitle>
                    <Badge variant="secondary" className="text-xs">Ready</Badge>
                  </div>
                  {expanded === skill.name ? (
                    <ChevronUpIcon className="size-4 text-muted-foreground" />
                  ) : (
                    <ChevronDownIcon className="size-4 text-muted-foreground" />
                  )}
                </div>
                {skill.description && (
                  <p className="text-xs text-muted-foreground mt-1 ml-7">{skill.description}</p>
                )}
              </CardHeader>
              {expanded === skill.name && skill.content && (
                <CardContent className="px-4 pb-4 pt-0">
                  <pre className="text-xs bg-muted/30 p-3 rounded-md overflow-x-auto whitespace-pre-wrap">
                    {skill.content}
                  </pre>
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Skill</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="skill-name">Skill Name</Label>
              <Input
                id="skill-name"
                placeholder="e.g. code-review"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="skill-desc">Description</Label>
              <Input
                id="skill-desc"
                placeholder="What this skill does"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="skill-triggers">Triggers (comma-separated)</Label>
              <Input
                id="skill-triggers"
                placeholder="review, code review, PR review"
                value={form.triggers}
                onChange={(e) => setForm({ ...form, triggers: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="skill-body">Skill Content</Label>
              <Textarea
                id="skill-body"
                placeholder="The skill's markdown instructions..."
                rows={6}
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!form.name.trim() || saving}>
              {saving ? "Creating..." : "Create Skill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
