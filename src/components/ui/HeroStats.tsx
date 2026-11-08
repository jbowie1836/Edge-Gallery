import type { ReactNode } from 'react';
import { formatCurrency } from '../../lib/income';
import type { AtlasData } from '../../types';
import { formatDate, formatMoe, formatPeriod } from './atlasModel';
import type { JoinReport } from './atlasModel';

interface HeroStatsProps {
  data: AtlasData | null;
  join: JoinReport | null;
  failed: boolean;
}

/** Headline figures; nothing numeric is shown until the official data has loaded. */
export default function HeroStats({ data, join, failed }: HeroStatsProps) {
  const placeholder: ReactNode = failed
    ? <span className="stat__unavailable">Unavailable</span>
    : <><span className="skeleton skeleton--stat" aria-hidden="true" /><span className="visually-hidden">Loading</span></>;

  if (!data || !join) {
    return (
      <dl className="stats" aria-busy={!failed}>
        {['Texas mean annual household income', 'Counties with estimates', 'ACS 5-year estimates'].map((label, index) => (
          <div key={label} className={`stat${index === 0 ? ' stat--lead' : ''}`}>
            <dt>{label}</dt>
            <dd className="stat__value">{placeholder}</dd>
            <dd className="stat__note" aria-hidden="true">&nbsp;</dd>
          </div>
        ))}
      </dl>
    );
  }

  const { metadata } = data;
  const missing = join.boundaryCount - join.matchedWithEstimate;
  const unmatched = join.boundariesWithoutRecord.length + join.recordsWithoutBoundary.length;
  let coverageNote = 'Joined to boundaries by FIPS code';
  if (unmatched > 0) coverageNote = `${unmatched} FIPS ${unmatched === 1 ? 'code' : 'codes'} unmatched`;
  else if (missing > 0) coverageNote = `${missing} ${missing === 1 ? 'county' : 'counties'} not available`;

  return (
    <dl className="stats">
      <div className="stat stat--lead">
        <dt>Texas mean annual household income</dt>
        <dd className={`stat__value${data.stateMeanIncome === null ? ' stat__value--missing' : ''}`}>
          {formatCurrency(data.stateMeanIncome)}
        </dd>
        <dd className="stat__note">
          {data.stateMarginOfError === null ? 'Margin of error not available' : `${formatMoe(data.stateMarginOfError)} (90% MOE)`}
          {' · '}
          {metadata.dollarYear} inflation-adjusted dollars
        </dd>
      </div>
      <div className="stat">
        <dt>Counties with estimates</dt>
        <dd className="stat__value">
          {join.matchedWithEstimate}
          <small> / {join.boundaryCount}</small>
        </dd>
        <dd className="stat__note">{coverageNote}</dd>
      </div>
      <div className="stat">
        <dt>ACS 5-year estimates</dt>
        <dd className="stat__value">{formatPeriod(metadata.period)}</dd>
        <dd className="stat__note">
          {metadata.releaseDate ? `Released ${formatDate(metadata.releaseDate)}` : `${metadata.releaseYear} ACS release`}
        </dd>
      </div>
    </dl>
  );
}
