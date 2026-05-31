import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { NavShell } from '@/components/nav-shell';

export const metadata: Metadata = {
  title: 'PR Review Copilot',
  description:
    'Operator dashboard for the PR review bot: reviews, analytics, and bot config.',
};

// Dark-only is deliberate: the operator surface lives next to a terminal,
// the bot writes to a local SQLite store, and a light/dark toggle would be
// a decision-cost the operator never asked us to expose. A future theme
// switcher lands the day someone needs it.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        <NavShell>{children}</NavShell>
      </body>
    </html>
  );
}
