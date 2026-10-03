import { LeaguePortal } from '@/components/league-portal';
import { PortalSearchProvider } from '@/components/use-portal-location';

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) value.forEach(item => query.append(key, item));
    else if (value !== undefined) query.append(key, value);
  }
  const initialSearch = query.size ? '?' + query.toString() : '';
  return <PortalSearchProvider initialSearch={initialSearch}><LeaguePortal initialSearch={initialSearch}/></PortalSearchProvider>;
}
