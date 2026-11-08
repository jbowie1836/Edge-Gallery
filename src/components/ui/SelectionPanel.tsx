import type { Ref } from 'react';
import { BookOpen, MousePointerClick, X } from 'lucide-react';
import { formatCurrency } from '../../lib/income';
import type { AtlasData, CountyIncome } from '../../types';
import {
  compareToReference,
  confidenceInterval,
  displayCountyName,
  formatCompactCurrency,
  formatCount,
  formatMoe,
  formatPercent,
  incomeGradient,
  ordinal,
  positionInRange,
  relativeMoe,
  shortCountyName,
} from './atlasModel';
import type { CountySummary } from './atlasModel';

// Harris, Dallas, Tarrant, Bexar, Travis, Collin.
const METRO_FIPS = ['48201', '48113', '48439', '48029', '48453', '48085'];

interface SelectionPanelProps {
  county: CountyIncome | null;
  data: AtlasData;
  ranks: ReadonlyMap<string, number>;
  summary: CountySummary;
  headingRef: Ref<HTMLHeadingElement>;
  onSelect: (fips: string) => void;
  onClear: () => void;
}

export default function SelectionPanel(props: SelectionPanelProps) {
  return props.county ? <CountyDetails {...props} county={props.county} /> : <StateGlance {...props} />;
}

function CountyDetails({ county, data, ranks, summary, headingRef, onClear }: SelectionPanelProps & { county: CountyIncome }) {
  const { dollarYear } = data.metadata;
  const name = displayCountyName(county.name);
  const rank = ranks.get(county.fips);
  const interval = confidenceInterval(county.meanIncome, county.marginOfError);
  const moeShare = relativeMoe(county.meanIncome, county.marginOfError);

  return (
    <article className="selection" aria-labelledby="selection-title">
      <div className="selection__head">
        <span className="pill"><span className="pill__dot" aria-hidden="true" />Selected county</span>
        <button type="button" className="ghost-button" onClick={onClear}>
          <X size={15} aria-hidden="true" />
          Clear<span className="visually-hidden"> selection and show the Texas overview</span>
        </button>
      </div>
      <h3 id="selection-title" ref={headingRef} tabIndex={-1} className="panel-title">{name}</h3>
      <p className="panel-meta">
        FIPS {county.fips}
        <span aria-hidden="true"> · </span>
        <span className="visually-hidden">, </span>
        {county.households === null ? 'households not available' : `${formatCount(county.households)} households`}
      </p>

      {county.meanIncome === null ? (
        <div className="selection__missing">
          <p className="panel-value panel-value--missing">No published estimate</p>
          <p className="panel-label">
            The Census Bureau did not publish a mean annual household income estimate for this county in this release.
            It is shown in gray on the map, left out of rankings, and never treated as $0.
          </p>
        </div>
      ) : (
        <>
          <p className="panel-value">{formatCurrency(county.meanIncome)}</p>
          <p className="panel-label">
            <strong>Mean annual household income</strong>
            <br />
            in {dollarYear} inflation-adjusted dollars
          </p>
          <div className="panel-moe">
            {county.marginOfError === null ? (
              <p>Margin of error not available</p>
            ) : (
              <>
                <p>
                  <strong>{formatMoe(county.marginOfError)}</strong> margin of error (90%)
                  {moeShare !== null && ` · ${formatPercent(moeShare)} of the estimate`}
                </p>
                {interval && <p>90% interval {formatCurrency(interval.low)} to {formatCurrency(interval.high)}</p>}
              </>
            )}
          </div>
          <RangeStrip county={county} rank={rank} summary={summary} stateMean={data.stateMeanIncome} />
        </>
      )}
      <a className="panel-link" href="#methodology">
        <BookOpen size={15} aria-hidden="true" /> How to read margins of error
      </a>
    </article>
  );
}

function rankTitle(rank: number | undefined, total: number): string {
  if (rank === undefined) return 'Among Texas counties';
  if (rank === 1) return `Highest of ${total} counties`;
  if (rank === total) return `Lowest of ${total} counties`;
  return `${ordinal(rank)} highest of ${total} counties`;
}

interface RangeStripProps {
  county: CountyIncome;
  rank: number | undefined;
  summary: CountySummary;
  stateMean: number | null;
}

function RangeStrip({ county, rank, summary, stateMean }: RangeStripProps) {
  const { highest, lowest } = summary;
  if (!highest || !lowest || county.meanIncome === null) return null;
  const min = lowest.meanIncome;
  const max = highest.meanIncome;
  const at = (value: number) => `${positionInRange(value, min, max)}%`;
  const comparison = compareToReference(county.meanIncome, stateMean);
  const label = `${displayCountyName(county.name)}, ${formatCurrency(county.meanIncome)}, on a scale from the lowest county mean `
    + `(${displayCountyName(lowest.name)}, ${formatCurrency(min)}) to the highest (${displayCountyName(highest.name)}, ${formatCurrency(max)})`
    + `${stateMean === null ? '' : `. Tick marks the Texas mean, ${formatCurrency(stateMean)}`}.`;

  return (
    <div className="range">
      <p className="range__title">{rankTitle(rank, summary.withEstimate)}</p>
      <div className="range__track" role="img" aria-label={label} style={{ backgroundImage: incomeGradient(min, max) }}>
        {stateMean !== null && (
          <span className="range__state" style={{ left: at(stateMean) }}>
            <span className="range__state-label" aria-hidden="true">TX</span>
          </span>
        )}
        <span className="range__marker" style={{ left: at(county.meanIncome) }} />
      </div>
      <div className="range__ends" aria-hidden="true">
        <span><strong>{formatCompactCurrency(min)}</strong>{shortCountyName(lowest.name)}</span>
        <span><strong>{formatCompactCurrency(max)}</strong>{shortCountyName(highest.name)}</span>
      </div>
      {comparison && stateMean !== null && (
        <p className="range__caption">
          {comparison.direction === 'equal' ? 'About the same as' : `${formatPercent(comparison.share)} ${comparison.direction}`}
          {' '}the Texas mean of {formatCurrency(stateMean)}
        </p>
      )}
    </div>
  );
}

function StateGlance({ data, summary, headingRef, onSelect }: SelectionPanelProps) {
  const { highest, lowest } = summary;
  const byFips = new Map(data.counties.map((county) => [county.fips, county]));
  const metros = METRO_FIPS.map((fips) => byFips.get(fips)).filter((county): county is CountyIncome => county !== undefined);

  return (
    <section className="selection" aria-labelledby="selection-title">
      <p className="panel-eyebrow">Statewide overview</p>
      <h3 id="selection-title" ref={headingRef} tabIndex={-1} className="panel-title">Texas at a glance</h3>
      <p className={`panel-value${data.stateMeanIncome === null ? ' panel-value--missing' : ''}`}>
        {formatCurrency(data.stateMeanIncome)}
      </p>
      <p className="panel-label">
        <strong>Texas mean annual household income</strong>
        <br />
        in {data.metadata.dollarYear} inflation-adjusted dollars
        {data.stateMarginOfError !== null && <> · {formatMoe(data.stateMarginOfError)} (90% MOE)</>}
      </p>
      <dl className="glance">
        {highest && (
          <div>
            <dt>Highest county mean</dt>
            <dd>
              <button type="button" className="text-button" onClick={() => onSelect(highest.fips)}>
                {displayCountyName(highest.name)}
              </button>
              <span className="num">{formatCurrency(highest.meanIncome)}</span>
            </dd>
          </div>
        )}
        {lowest && (
          <div>
            <dt>Lowest county mean</dt>
            <dd>
              <button type="button" className="text-button" onClick={() => onSelect(lowest.fips)}>
                {displayCountyName(lowest.name)}
              </button>
              <span className="num">{formatCurrency(lowest.meanIncome)}</span>
            </dd>
          </div>
        )}
        {summary.missing > 0 && (
          <div>
            <dt>No published estimate</dt>
            <dd><span className="num">{summary.missing} of {summary.total} counties</span></dd>
          </div>
        )}
      </dl>
      {metros.length > 0 && (
        <div className="glance__metros">
          <p id="metro-picks-label" className="panel-eyebrow">Major metro counties</p>
          <div className="chip-row" role="group" aria-labelledby="metro-picks-label">
            {metros.map((county) => (
              <button key={county.fips} type="button" className="chip" onClick={() => onSelect(county.fips)}>
                {shortCountyName(county.name)}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="glance__hint">
        <MousePointerClick size={16} aria-hidden="true" />
        <span>Click the map, search above, or use the table below.</span>
      </p>
    </section>
  );
}
