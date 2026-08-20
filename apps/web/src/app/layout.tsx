import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ServiceWorkerProvider } from './service-worker-provider';

export const metadata: Metadata = {
  title: "Vim's HMS",
  description: "Vim's HMS by VIMS ENTERPRISE — hospital management system",
  applicationName: "Vim's HMS",
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: "Vim's HMS",
    // `default` keeps the status bar readable against the light clinical theme;
    // `black-translucent` would put the clock over the patient banner.
    statusBarStyle: 'default',
  },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/icon-192.png', sizes: '192x192' }],
  },
  formatDetection: {
    // iOS otherwise turns UHIDs, bill numbers and dosages into telephone links,
    // which both looks wrong and makes a number tappable into a call.
    telephone: false,
  },
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
      <body className="min-h-dvh bg-canvas text-fg-default antialiased">
        <ServiceWorkerProvider>{children}</ServiceWorkerProvider>
      </body>
    </html>
  );
}
