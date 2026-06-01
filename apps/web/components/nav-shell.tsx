// Server Component layout fragment: persistent top navigation + page slot.
// Active-route highlight is handled by the NavLinks Client subcomponent
// (usePathname() is client-only).
import type { ReactNode } from 'react';
import { NavLinks } from './nav-links';
import { KeyboardShortcuts } from './keyboard-shortcuts';
import { ShortcutsHint } from './shortcuts-hint';

interface NavShellProps {
  children: ReactNode;
}

export function NavShell({ children }: NavShellProps) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Skip-to-content: visually hidden until keyboard-focused. First Tab
        * stop on every page so a keyboard or screen-reader user can bypass
        * the persistent nav and land on the page body. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:border focus:border-border focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-none focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-border bg-background">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-8 px-6">
          <a
            href="/"
            className="font-mono text-sm font-medium tracking-tight text-foreground"
            aria-label="PR Review Copilot home"
          >
            pr-review-copilot
          </a>
          <NavLinks />
          <div className="ml-auto">
            <ShortcutsHint />
          </div>
        </div>
      </header>
      <main id="main-content" className="mx-auto max-w-6xl px-6 py-10">
        {children}
      </main>
      <KeyboardShortcuts />
    </div>
  );
}
