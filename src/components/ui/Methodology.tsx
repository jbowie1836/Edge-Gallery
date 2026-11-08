import { CalendarRange, CircleDashed, ExternalLink, Ruler, Sigma } from 'lucide-react';
import type { AtlasData } from '../../types';
import { formatPeriod, periodYears, subjectDefinitionsUrl } from './atlasModel';
import type { CountySummary, JoinReport } from './atlasModel';

interface MethodologyProps {
  data: AtlasData;
  summary: CountySummary;
  join: JoinReport;
}

export default function Methodology({ data, summary, join }: MethodologyProps) {
  const { metadata } = data;
  const period = formatPeriod(metadata.period);
  const years = periodYears(metadata.period);
  const collected = years
    ? `survey responses collected from January ${years.start} through December ${years.end}`
    : 'survey responses collected over five years';
  const unmatched = [...join.boundariesWithoutRecord, ...join.recordsWithoutBoundary];

  const links = [
    { href: metadata.sourceUrl, label: 'Census source data used in this atlas' },
    { href: 'https://www.census.gov/programs-surveys/acs/guidance/estimates.html', label: 'Using 1-year or 5-year ACS data' },
    { href: 'https://www.census.gov/programs-surveys/acs/library/handbooks/general.html', label: 'Understanding and Using ACS Data (handbook)' },
    { href: subjectDefinitionsUrl(metadata.releaseYear), label: `ACS ${metadata.releaseYear} subject definitions (PDF)` },
  ];

  return (
    <section id="methodology" className="section methodology" aria-labelledby="methodology-title">
      <div className="section-head">
        <div>
          <p className="eyebrow">Methodology</p>
          <h2 id="methodology-title">How to read these numbers</h2>
          <p className="section-lede">{metadata.definition}</p>
        </div>
      </div>

      <div className="method-grid">
        <article className="method-card">
          <span className="method-card__icon" aria-hidden="true"><Sigma size={20} /></span>
          <h3>Mean, not median or per capita</h3>
          <p>
            Mean household income is total household income divided by the number of households. A few very high
            incomes pull it upward, so it usually sits above <strong>median</strong> household income, the midpoint at
            which half of households earn more and half earn less. <strong>Per capita</strong> income divides total
            income by every resident, children included, so it is lower still. The three are not interchangeable:
            compare means only with means.
          </p>
        </article>
        <article className="method-card">
          <span className="method-card__icon" aria-hidden="true"><CalendarRange size={20} /></span>
          <h3>Five years, pooled</h3>
          <p>
            These are ACS {period} 5-year estimates: {collected}, pooled so that even the smallest counties have
            published figures. They describe that whole period, not {years ? years.end : 'a single year'} alone. The
            Census Bureau expresses every dollar value in {metadata.dollarYear} inflation-adjusted dollars.
          </p>
        </article>
        <article className="method-card">
          <span className="method-card__icon" aria-hidden="true"><Ruler size={20} /></span>
          <h3>Every estimate has a margin of error</h3>
          <p>
            The ACS is a sample survey, so each estimate is published with a margin of error at the 90 percent
            confidence level: the range from the estimate minus the margin to the estimate plus the margin has about a
            90 percent chance of containing the true value. Counties with fewer households tend to have wider margins,
            so neighboring ranks may not differ meaningfully.
          </p>
        </article>
        <article className="method-card">
          <span className="method-card__icon" aria-hidden="true"><CircleDashed size={20} /></span>
          <h3>Missing is not zero</h3>
          <p>
            When the Census Bureau publishes no estimate for a county, the atlas says “Not available” and shades the
            county gray. Missing values are never filled in, never shown as $0, and are left out of rankings and
            comparisons.{' '}
            {summary.missing === 0
              ? `In this release, all ${summary.total} counties have a published estimate.`
              : `In this release, ${summary.missing} of ${summary.total} counties have no published estimate.`}
          </p>
        </article>
      </div>

      <div className="method-notes">
        <div className="method-notes__text">
          <p>
            <strong>Boundaries and joins.</strong> {metadata.boundarySource}
            {metadata.boundaryYear ? ` (${metadata.boundaryYear})` : ''} county shapes are matched to income records by
            five-digit county FIPS code: {join.matched} of {join.boundaryCount} boundaries matched an income record.
            {unmatched.length > 0 && ` Unmatched FIPS codes: ${unmatched.join(', ')}.`}
          </p>
          {data.stateMeanIncome !== null && (
            <p>
              <strong>Statewide figure.</strong> The Texas mean is the Census Bureau’s own statewide estimate, not an
              average of county means.
            </p>
          )}
          <p>
            <strong>Comparisons.</strong> Ranks and percentage differences compare point estimates only; they are not
            tests of statistical significance.
          </p>
          {metadata.notes && (
            <p>
              <strong>Data notes.</strong> {metadata.notes}
            </p>
          )}
        </div>
        <div>
          <h3 className="method-notes__title">Further reading</h3>
          <ul className="link-list">
            {links.map((link) => (
              <li key={link.href}>
                <a href={link.href} target="_blank" rel="noopener noreferrer">
                  {link.label}
                  <ExternalLink size={14} aria-hidden="true" />
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
