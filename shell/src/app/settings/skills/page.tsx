"use client";

import { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

export default function SkillsPage() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    async function loadSkills() {
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
    }
    loadSkills();
  }, []);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Skills</h2>
        <Button size="sm" variant="outline" className="h-8 text-xs">
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
    </div>
  );
}
