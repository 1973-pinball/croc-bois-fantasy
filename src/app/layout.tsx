import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Croc Bois | Fantasy Basketball',
  description: 'The home of Croc Bois Fantasy Basketball. League history, keeper planning, draft picks, and the deals that made it all happen.',
  applicationName: 'Croc Bois',
  icons: { apple: '/icon-192.png' },
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Croc Bois' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#193c32',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
