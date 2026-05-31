// Server-presentational component: a labelled section card for the settings page.
// Read-only. No edit affordances.
// Reused for Model, Knowledge sources, and Severity gate sections.
import type { ReactNode } from 'react';
import { Separator } from '@/components/ui/separator';

interface SettingsCardProps {
  title: string;
  children: ReactNode;
}

export function SettingsCard({ title, children }: SettingsCardProps) {
  return (
    <section aria-labelledby={`settings-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <h2
        id={`settings-${title.toLowerCase().replace(/\s+/g, '-')}`}
        className="mb-4 text-sm font-medium text-foreground"
      >
        {title}
      </h2>
      <div className="rounded-lg border border-border bg-card px-5 py-4">
        {children}
      </div>
    </section>
  );
}

// A single key-value row within a settings card.
interface SettingsRowProps {
  label: string;
  value: ReactNode;
  isLast?: boolean;
}

export function SettingsRow({ label, value, isLast = false }: SettingsRowProps) {
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1 py-2.5">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="font-mono text-xs text-foreground">{value}</dd>
      </div>
      {!isLast && <Separator className="opacity-50" />}
    </>
  );
}
