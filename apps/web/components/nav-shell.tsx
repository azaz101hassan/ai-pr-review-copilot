// Server Component layout fragment: persistent top navigation + page slot.
// Active-route highlight is handled by the NavLinks Client subcomponent
// (usePathname() is client-only).
import type { ReactNode } from 'react';
import { NavLinks } from './nav-links';

interface NavShellProps {
  children: ReactNode;
}

export function NavShell({ children }: NavShellProps) {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-14 items-center px-4">
          <div className="mr-6 flex items-center">
            <span className="font-semibold text-sm">PR Review Copilot</span>
          </div>
          <NavLinks />
        </div>
      </header>
      <main className="container mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
