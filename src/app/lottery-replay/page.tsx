import type { Metadata } from 'next';
import { LotteryReplay } from '@/components/lottery-replay';

export const metadata: Metadata = { title: 'Lottery replay | Croc Bois', robots: { index: false, follow: false } };

export default async function LotteryReplayPage({ searchParams }: { searchParams: Promise<{ shareId?: string | string[] }> }) {
  const { shareId } = await searchParams;
  const id = typeof shareId === 'string' ? shareId : '';
  return <LotteryReplay key={id} shareId={id}/>;
}
