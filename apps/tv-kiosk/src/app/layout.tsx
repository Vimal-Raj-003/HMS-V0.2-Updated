import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: "Vim's HMS — Display",
  description: "Vim's HMS by VIMS ENTERPRISE — token board and kiosk display client",
  applicationName: "Vim's HMS Display",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // A wall-mounted TV has no pinch gesture and no user to perform it; locking the
  // scale is what keeps a stray HDMI-CEC event from leaving the board zoomed in.
  maximumScale: 1,
  userScalable: false,
  // Deliberately no `themeColor`: the board's canvas is defined once, as
  // `--bg-canvas` in the dark token map, and duplicating it here as a literal
  // would be a second definition free to drift (docs/06 §11). `colorScheme`
  // gets the browser to paint its own chrome dark without naming a colour.
  colorScheme: 'dark',
};

export default function DisplayRootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    // docs/06 §2: boards are always the Dark Layered Stack, and always
    // high-contrast — EN-018 §13 requires >= 7:1 at 8 m.
    <html lang="en-IN" dir="ltr" data-theme="dark" data-contrast="high" suppressHydrationWarning>
      <body className="h-full bg-canvas text-fg-default antialiased">{children}</body>
    </html>
  );
}
