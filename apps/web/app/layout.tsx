import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'AI PR Review Copilot',
  description:
    'RAG + agentic LLM that reviews GitHub PRs against a team knowledge base.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          background: '#0b0d10',
          color: '#e8edf3',
        }}
      >
        {children}
      </body>
    </html>
  );
}
