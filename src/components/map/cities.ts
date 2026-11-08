export interface CityLabel {
  name: string;
  lat: number;
  lon: number;
  /** Which side of the dot the name sits on, chosen so nearby labels do not collide. */
  side: 'left' | 'right';
}

/** Internal points from the U.S. Census Bureau 2023 Gazetteer place file for Texas (INTPTLAT/INTPTLONG). */
export const CITY_LABELS: CityLabel[] = [
  { name: 'Dallas', lat: 32.793333, lon: -96.766513, side: 'right' },
  { name: 'Houston', lat: 29.785743, lon: -95.388806, side: 'right' },
  { name: 'Austin', lat: 30.298622, lon: -97.754134, side: 'right' },
  { name: 'San Antonio', lat: 29.462809, lon: -98.524635, side: 'left' },
  { name: 'El Paso', lat: 31.84778, lon: -106.431106, side: 'right' },
];
