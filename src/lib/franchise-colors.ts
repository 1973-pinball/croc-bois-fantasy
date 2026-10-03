import type { CSSProperties } from 'react';

// Fixed franchise identities keep ownership colors stable through trades, renamed
// teams, and changes to the draft order. Unknown or unassigned slots stay neutral.
const franchiseColors: Record<string, readonly [background: string, border: string]> = {
  '91565de8-795e-4ebf-8353-29b83bbfecc7': ['#dceafb', '#8daed3'],
  'ea426552-e14c-41e0-831f-558ed0e91691': ['#f9dfe6', '#d69bab'],
  '0a36f406-2ec5-447a-8202-7f602a30b7c9': ['#fff0c7', '#ccb36d'],
  '5cc31eed-a450-4a8e-8380-feccd817c164': ['#d7f0ea', '#83b9ab'],
  'f20ba68b-0d3f-46b7-82cf-5ca0b9417a4c': ['#fde2d1', '#d4a17f'],
  '0e926a61-0f4b-40ff-8ce0-f674fb0616be': ['#e2e3fc', '#a1a3d6'],
  '6f828799-7d52-4fef-83d4-03579f52b2df': ['#e9f0c7', '#b1be79'],
  'c81be1b5-6655-459d-8c3b-ace971b0f0fa': ['#f1deed', '#be96b6'],
};

export function franchiseColorStyle(franchiseId: string | null | undefined): CSSProperties | undefined {
  const colors = franchiseId ? franchiseColors[franchiseId] : undefined;
  return colors ? { '--franchise-bg': colors[0], '--franchise-border': colors[1] } as CSSProperties : undefined;
}
