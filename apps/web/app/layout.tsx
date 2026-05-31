import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { NavShell } from '@/components/nav-shell';

export const metadata: Metadata = {
  title: 'AI PR Review Copilot',
  description:
    'RAG + agentic LLM that reviews GitHub PRs against a team knowledge base.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <NavShell>{children}</NavShell>
      </body>
    </html>
  );
}
