export default function HomePage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '4rem 1.5rem',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: '2.5rem', margin: 0, letterSpacing: '-0.02em' }}>
        AI PR Review Copilot
      </h1>
      <p style={{ marginTop: '0.75rem', color: '#9aa4b2', maxWidth: '36rem' }}>
        Dashboard coming soon. The API listens on{' '}
        <code
          style={{
            background: '#1a1f26',
            padding: '0.125rem 0.375rem',
            borderRadius: '0.25rem',
          }}
        >
          localhost:3001
        </code>{' '}
        and accepts GitHub PR webhooks today; the UI lands on Day 7 of the
        baseline plan.
      </p>
      <p style={{ marginTop: '1.5rem', fontSize: '0.875rem', color: '#6b7785' }}>
        See <code>docs/plans/01-baseline.md</code> for the 10-day plan.
      </p>
    </main>
  );
}
