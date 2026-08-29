import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Department Reporting',
  description: 'Daily report ingestion, metrics and management summaries'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
