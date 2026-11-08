import { ExternalLink } from 'lucide-react';
import type { AtlasMetadata } from '../../types';
import BrandMark from './BrandMark';
import { formatDate, formatPeriod } from './atlasModel';
import { GEOMETRY_URL, INCOME_URL } from './useAtlasData';

function ExternalAnchor({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ExternalLink size={13} aria-hidden="true" />
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

export default function SourceFooter({ metadata }: { metadata: AtlasMetadata | null }) {
  return (
    <footer id="sources" className="site-footer">
      <div className="site-footer__inner">
        <div className="site-footer__brand">
          <BrandMark className="site-footer__mark" />
          <p className="site-footer__name">Lone Star <span aria-hidden="true">/</span> An Income Atlas</p>
          <p className="site-footer__tagline">Mean annual household income for every Texas county, from official Census Bureau estimates.</p>
        </div>
        <div>
          <h2 className="site-footer__title">Sources</h2>
          {metadata ? (
            <>
              <dl className="source-list">
                <div>
                  <dt>Income estimates</dt>
                  <dd>
                    {metadata.source}, ACS {formatPeriod(metadata.period)} 5-year estimates ({metadata.releaseYear} vintage),
                    variable <code>{metadata.sourceVariable}</code>.
                    {metadata.releaseDate && ` Released ${formatDate(metadata.releaseDate)}.`}
                    {metadata.fetchedAt && ` Retrieved ${formatDate(metadata.fetchedAt)}.`}{' '}
                    <ExternalAnchor href={metadata.sourceUrl}>View source data</ExternalAnchor>
                  </dd>
                </div>
                <div>
                  <dt>Dollar basis</dt>
                  <dd>{metadata.dollarYear} inflation-adjusted dollars</dd>
                </div>
                <div>
                  <dt>Income definition</dt>
                  <dd>{metadata.definition}</dd>
                </div>
                {metadata.boundarySource && (
                  <div>
                    <dt>County boundaries</dt>
                    <dd>
                      {metadata.boundarySource}
                      {metadata.boundaryYear ? `, ${metadata.boundaryYear}` : ''}.{' '}
                      {metadata.boundaryUrl && <ExternalAnchor href={metadata.boundaryUrl}>View boundary source</ExternalAnchor>}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Data files</dt>
                  <dd className="source-list__files">
                    <a href={INCOME_URL} download>income.json</a>
                    <a href={GEOMETRY_URL} download>texas-counties.geojson</a>
                  </dd>
                </div>
              </dl>
              {metadata.sourceUrl.includes('api.census.gov') && (
                <p className="site-footer__note">
                  This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.
                </p>
              )}
            </>
          ) : (
            <p className="site-footer__note">Source details appear once the data has loaded.</p>
          )}
        </div>
      </div>
    </footer>
  );
}
