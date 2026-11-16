'use client';
import { usePathname } from 'next/navigation';
import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
const LegacyProviders = dynamic(() => import('./providers').then(m => m.Providers), { ssr: false });
export function LabProviders({ children }: { children: ReactNode }) {
  const path = usePathname();
  return path === '/aa' || path === '/' ? <>{children}</> : <LegacyProviders>{children}</LegacyProviders>;
}
