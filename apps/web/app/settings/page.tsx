// Settings page — Server Component.
// Fetches /api/dashboard/settings and renders the positive-allowlist fields.
// Read-only: no edit affordances. No eval baseline section (Day-8 territory).
import { fetchDashboard } from '@/lib/api';
import { SettingsCard, SettingsRow } from '@/components/settings-card';
import { EmptyState } from '@/components/empty-state';
import type { SettingsResponseDto } from '@/lib/api-types';

export default async function SettingsPage() {
  const settings = await fetchDashboard<SettingsResponseDto>('/settings');

  return (
    <div className="space-y-8">
      {/* Page heading */}
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Settings
        </h1>
        <p className="text-sm text-muted-foreground">
          Bot configuration. Read-only: edit in source to change.
        </p>
      </header>

      {/* Model */}
      <SettingsCard title="Model">
        <dl>
          <SettingsRow label="Review model" value={settings.model} />
          <SettingsRow
            label="Embedding model"
            value={settings.embeddingModel}
          />
          <SettingsRow
            label="Chroma collection"
            value={settings.chromaCollection}
            isLast
          />
        </dl>
      </SettingsCard>

      {/* Knowledge sources */}
      <SettingsCard title="Knowledge sources">
        {settings.knowledgeSources.length === 0 ? (
          <EmptyState
            title="No sources configured yet."
            description={
              <>
                Run{' '}
                <code className="rounded bg-muted px-1 font-mono text-xs">
                  npm run embeddings:seed
                </code>{' '}
                to load the default ruleset into Chroma.
              </>
            }
            className="border-0 py-8"
          />
        ) : (
          <dl>
            {settings.knowledgeSources.map((src, idx) => (
              <SettingsRow
                key={src.id}
                label={src.name}
                value={
                  src.description ? (
                    <span className="font-sans text-xs text-muted-foreground">
                      {src.description}
                    </span>
                  ) : (
                    <span className="font-sans text-xs text-muted-foreground/50">
                      No description
                    </span>
                  )
                }
                isLast={idx === settings.knowledgeSources.length - 1}
              />
            ))}
          </dl>
        )}
      </SettingsCard>

      {/* Severity gate */}
      <SettingsCard title="Severity gate">
        <dl>
          <SettingsRow
            label="Allowed severities"
            value={settings.severityGate.allowed.join(', ')}
          />
          <SettingsRow
            label="Default severity"
            value={settings.severityGate.default}
            isLast
          />
        </dl>
      </SettingsCard>
    </div>
  );
}
