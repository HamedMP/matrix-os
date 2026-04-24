"use client";

interface ProfileInfoPanelProps {
  fields: {
    name?: string;
    role?: string;
    interests?: string[];
  };
}

export function ProfileInfoPanel({ fields }: ProfileInfoPanelProps) {
  const hasName = !!fields.name;
  const hasRole = !!fields.role;
  const hasInterests = fields.interests && fields.interests.length > 0;

  return (
    <div className="w-full max-w-sm">
      {/* User name — large, prominent */}
      {hasName && (
        <div className="text-center mb-6 transition-all duration-700 ease-out">
          <p className="text-[10px] uppercase tracking-[0.25em] text-foreground/25 mb-2">
            Nice to meet you
          </p>
          <h2
            className="text-3xl font-light text-foreground/80 tracking-tight"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            {fields.name}
          </h2>
        </div>
      )}

      {/* Details card — appears after name */}
      {(hasRole || hasInterests) && (
        <div className="rounded-2xl border border-foreground/6 bg-foreground/[0.02] p-5 transition-all duration-700 ease-out">
          {/* Role */}
          {hasRole && (
            <div className="mb-4 transition-all duration-500">
              <p className="text-[9px] uppercase tracking-[0.2em] text-foreground/25 mb-1">Role</p>
              <p className="text-sm text-foreground/60">{fields.role}</p>
            </div>
          )}

          {/* Interests */}
          {hasInterests && (
            <div className="transition-all duration-500">
              <p className="text-[9px] uppercase tracking-[0.2em] text-foreground/25 mb-2">Interests</p>
              <div className="flex flex-wrap gap-1.5">
                {fields.interests!.map((interest, i) => (
                  <span
                    key={interest}
                    className="rounded-full border border-foreground/6 bg-foreground/[0.03] px-3 py-1 text-xs text-foreground/50 transition-all duration-500"
                    style={{ transitionDelay: `${i * 100}ms` }}
                  >
                    {interest}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
