import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';

export interface CountyIncome {
  fips: string;
  name: string;
  meanIncome: number | null;
  marginOfError: number | null;
  households: number | null;
}

export interface AtlasMetadata {
  releaseYear: number;
  period: string;
  dollarYear: number;
  source: string;
  sourceUrl: string;
  sourceVariable: string;
  releaseDate: string;
  fetchedAt: string;
  boundarySource: string;
  boundaryUrl: string;
  boundaryYear: number;
  definition: string;
  notes: string;
}

export interface AtlasData {
  metadata: AtlasMetadata;
  stateMeanIncome: number | null;
  stateMarginOfError: number | null;
  counties: CountyIncome[];
}

export interface CountyProperties {
  fips: string;
  name: string;
}

export type CountyFeatureCollection = FeatureCollection<Polygon | MultiPolygon, CountyProperties>;

export interface CountyMapProps {
  geometry: CountyFeatureCollection;
  counties: CountyIncome[];
  selectedFips: string | null;
  onSelect: (fips: string) => void;
}
