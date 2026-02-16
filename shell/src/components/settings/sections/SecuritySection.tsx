"use client";

import { useState, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getGatewayUrl } from "@/lib/gateway";
import { ShieldIcon, AlertTriangleIcon, InfoIcon, RefreshCwIcon } from "lucide-react";

const GATEWAY = getGatewayUrl();

interface AuditFinding {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  remediation?: string;
}

interface AuditReport {
  findings: AuditFinding[];
  score: number;
  checkedAt: string;
}

const SEVERITY_STYLES: Record<string, { badge: string; icon: React.ReactNode }> = {
  critical: {
    badge: "bg-red-500/10 text-red-600 border-red-500/20",
    icon: <AlertTriangleIcon className="size-4 text-red-500" />,
  },
  warning: {
    badge: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
    icon: <AlertTriangleIcon className="size-4 text-yellow-500" />,
  },
  info: {
    badge: "bg-blue-500/10 text-blue-600 border-blue-500/20",
    icon: <InfoIcon className="size-4 text-blue-500" />,
  },
};

export function SecuritySection() {
  const [report, setReport] = useState<AuditReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAudit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY}/api/security/audit`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setReport({
        findings: data.findings ?? [],
        score: data.score ?? 0,
        checkedAt: new Date().toISOString(),
      });
    } catch (err) {
      setError("Security audit not available. It may not be configured yet.");
    } finally {
      setLoading(false);
    }
  }, []);

  const counts = report ? {
    critical: report.findings.filter((f) => f.severity === "critical").length,
    warning: report.findings.filter((f) => f.severity === "warning").length,
    info: report.findings.filter((f) => f.severity === "info").length,
  } : null;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Security</h2>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={runAudit}
          disabled={loading}
        >
          <RefreshCwIcon className={`size-3 mr-1 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Running..." : "Run Audit"}
        </Button>
      </div>

      {error && (
        <Card>
          <CardContent className="py-8 text-center">
            <ShieldIcon className="size-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      )}

      {!report && !error && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <ShieldIcon className="size-8 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium">Security audit</p>
            <p className="text-xs text-muted-foreground mt-1">
              Run an audit to check your system's security posture.
            </p>
          </CardContent>
        </Card>
      )}

      {report && counts && (
        <>
          <div className="flex gap-3">
            {counts.critical > 0 && (
              <Badge variant="outline" className={SEVERITY_STYLES.critical.badge}>
                {counts.critical} critical
              </Badge>
            )}
            {counts.warning > 0 && (
              <Badge variant="outline" className={SEVERITY_STYLES.warning.badge}>
                {counts.warning} warnings
              </Badge>
            )}
            <Badge variant="outline" className={SEVERITY_STYLES.info.badge}>
              {counts.info} info
            </Badge>
          </div>

          <div className="space-y-3">
            {report.findings.map((finding, i) => {
              const style = SEVERITY_STYLES[finding.severity] ?? SEVERITY_STYLES.info;
              return (
                <Card key={`${finding.id}-${i}`} className="gap-0">
                  <CardHeader className="py-3 px-4">
                    <div className="flex items-center gap-3">
                      {style.icon}
                      <CardTitle className="text-sm font-medium">{finding.title}</CardTitle>
                      <Badge variant="outline" className={`text-xs ${style.badge}`}>
                        {finding.severity}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 ml-7">
                      {finding.description}
                    </p>
                    {finding.remediation && (
                      <p className="text-xs mt-2 ml-7 px-2 py-1 bg-muted/30 rounded">
                        Fix: {finding.remediation}
                      </p>
                    )}
                  </CardHeader>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
