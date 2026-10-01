import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Croc Bois Fantasy Basketball',
    short_name: 'Croc Bois',
    description: 'Your league. Your keepers. Your next move.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f4f2e9',
    theme_color: '#193c32',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
}
