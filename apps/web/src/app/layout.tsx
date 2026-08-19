import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: "Vim's HMS",
  description: "Vim's HMS by VIMS ENTERPRISE — hospital management system",
  applicationName: "Vim's HMS",
};

export const viewport: Viewport = {
  // Clinical screens are used on tablets held at arm's length in bright wards;
  // zoom must never be disabled (WCAG 2.2 AA, docs/06 §7).
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1220' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" dir="ltr" suppressHydrationWarning>
      <body className="min-h-dvh bg-canvas text-default antialiased">{children}</body>
    </html>
  );
}
