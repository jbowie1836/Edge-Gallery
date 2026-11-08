import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Download, Search } from 'lucide-react';
import { formatCurrency, getIncomeColor } from '../../lib/income';
import type { AtlasMetadata, CountyIncome } from '../../types';
import {
  buildCountyCsv,
  csvFileName,
  displayCountyName,
  filterCounties,
  formatCount,
  formatMoe,
  formatPeriod,
  sortCounties,
} from './atlasModel';
import type { SortDirection, SortKey } from './atlasModel';

export const PAGE_SIZE = 20;

const COLUMNS: Array<{ key: SortKey; label: string; sub?: string; numeric: boolean; className: string }> = [
  { key: 'name', label: 'County', numeric: false, className: 'col-county' },
  { key: 'meanIncome', label: 'Mean annual household income', numeric: true, className: 'col-mean' },
  { key: 'marginOfError', label: 'Margin of error', sub: '90% confidence', numeric: true, className: 'col-moe' },
  { key: 'households', label: 'Households', numeric: true, className: 'col-households' },
];

interface CountyTableProps {
  counties: readonly CountyIncome[];
  ranks: ReadonlyMap<string, number>;
  metadata: AtlasMetadata;
  selectedFips: string | null;
  onSelect: (fips: string) => void;
}

function downloadText(text: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function CountyTable({ counties, ranks, metadata, selectedFips, onSelect }: CountyTableProps) {
  const baseId = useId();
  const filterId = `${baseId}-filter`;
  const tableId = `${baseId}-table`;
  const rowHintId = `${baseId}-row-hint`;
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('meanIncome');
  const [direction, setDirection] = useState<SortDirection>('descending');
  const [page, setPage] = useState(0);
  const [showAll, setShowAll] = useState(false);

  const filtered = useMemo(() => filterCounties(counties, query), [counties, query]);
  const sorted = useMemo(() => sortCounties(filtered, sortKey, direction), [filtered, sortKey, direction]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const start = showAll ? 0 : currentPage * PAGE_SIZE;
  const visible = showAll ? sorted : sorted.slice(start, start + PAGE_SIZE);
  const dollarLabel = `${metadata.dollarYear} inflation-adjusted dollars`;

  // Follow selections made on the map or in search by turning to the selected county's page.
  const lastSynced = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedFips || selectedFips === lastSynced.current) return;
    lastSynced.current = selectedFips;
    const index = sorted.findIndex((county) => county.fips === selectedFips);
    if (index >= 0) setPage(Math.floor(index / PAGE_SIZE));
  }, [selectedFips, sorted]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setDirection((value) => (value === 'ascending' ? 'descending' : 'ascending'));
    } else {
      setSortKey(key);
      setDirection(key === 'name' ? 'ascending' : 'descending');
    }
    setPage(0);
  };

  const activeColumn = COLUMNS.find((column) => column.key === sortKey) ?? COLUMNS[1];
  const trimmedQuery = query.trim();
  const countText = sorted.length === 0
    ? `No counties match “${trimmedQuery}”.`
    : `Showing ${start + 1}–${start + visible.length} of ${sorted.length} ${sorted.length === 1 ? 'county' : 'counties'}`
      + `${trimmedQuery ? ` matching “${trimmedQuery}”` : ''}.`;

  return (
    <section id="counties" className="section" aria-labelledby="counties-title">
      <div className="section-head">
        <div>
          <p className="eyebrow">County table</p>
          <h2 id="counties-title">Every county, side by side</h2>
          <p className="section-lede">
            Mean annual household income for all {counties.length} counties in {dollarLabel}, with 90% margins of error.
            Choose a county name to see it on the map.
          </p>
        </div>
        <div className="table-tools">
          <div className="field">
            <label className="field__label" htmlFor={filterId}>Filter counties</label>
            <div className="field__control">
              <Search size={16} aria-hidden="true" />
              <input
                id={filterId}
                type="search"
                value={query}
                placeholder="Name or FIPS code"
                autoComplete="off"
                spellCheck={false}
                aria-controls={tableId}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </div>
          </div>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => downloadText(buildCountyCsv(counties, ranks, metadata), csvFileName(metadata))}
          >
            <Download size={16} aria-hidden="true" /> Download CSV
          </button>
        </div>
      </div>

      <div className="table-card">
        <div className="table-scroll">
          <table id={tableId} className="atlas-table">
            <caption className="visually-hidden">
              Texas counties by mean annual household income, ACS {formatPeriod(metadata.period)} 5-year estimates in {dollarLabel}.
              Sorted by {activeColumn.label.toLowerCase()}, {direction}. Missing estimates are listed last and are not zero.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="num col-rank">Rank</th>
                {COLUMNS.map((column) => {
                  const active = column.key === sortKey;
                  const SortIcon = active ? (direction === 'ascending' ? ArrowUp : ArrowDown) : ChevronsUpDown;
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      className={`${column.className}${column.numeric ? ' num' : ''}`}
                      aria-sort={active ? direction : undefined}
                    >
                      <button type="button" className="sort-button" onClick={() => toggleSort(column.key)}>
                        <span className="sort-button__text">
                          {column.label}
                          <span className="th-sub">{column.key === 'meanIncome' ? `${metadata.dollarYear} dollars` : column.sub}</span>
                        </span>
                        <SortIcon size={14} aria-hidden="true" className="sort-button__icon" />
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visible.map((county) => {
                const selected = county.fips === selectedFips;
                const rank = ranks.get(county.fips);
                const missing = county.meanIncome === null;
                return (
                  <tr
                    key={county.fips}
                    className={selected ? 'is-selected' : undefined}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => onSelect(county.fips)}
                  >
                    <td className="num col-rank">
                      {rank ?? (<><span aria-hidden="true">—</span><span className="visually-hidden">Not ranked</span></>)}
                    </td>
                    <th scope="row" className="col-county">
                      <button
                        type="button"
                        className="row-button"
                        aria-describedby={rowHintId}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelect(county.fips);
                        }}
                      >
                        {displayCountyName(county.name)}
                      </button>
                      {selected && <span className="visually-hidden"> (selected)</span>}
                    </th>
                    <td className="num col-mean">
                      <span className="value-cell">
                        <span
                          className={`swatch${missing ? ' swatch--missing' : ''}`}
                          style={{ backgroundColor: getIncomeColor(county.meanIncome) }}
                          aria-hidden="true"
                        />
                        <span className={missing ? 'missing-text' : undefined}>{formatCurrency(county.meanIncome)}</span>
                      </span>
                      {!missing && county.marginOfError !== null && (
                        <span className="moe-inline">{formatMoe(county.marginOfError)}</span>
                      )}
                    </td>
                    <td className={`num col-moe${county.marginOfError === null ? ' missing-text' : ''}`}>
                      {formatMoe(county.marginOfError)}
                    </td>
                    <td className={`num col-households${county.households === null ? ' missing-text' : ''}`}>
                      {formatCount(county.households)}
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr className="atlas-table__empty">
                  <td colSpan={5}>
                    No counties match “{trimmedQuery}”.{' '}
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setQuery('');
                        setPage(0);
                      }}
                    >
                      Clear the filter
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p id={rowHintId} hidden>Shows this county on the map.</p>
        <div className="table-footer">
          <p className="table-count" role="status" aria-live="polite">{countText}</p>
          {sorted.length > PAGE_SIZE && (
            <nav className="pager" aria-label="County table pages">
              {!showAll && (
                <>
                  <button
                    type="button"
                    className="btn btn--secondary btn--compact"
                    aria-disabled={currentPage === 0}
                    onClick={() => currentPage > 0 && setPage(currentPage - 1)}
                  >
                    <ChevronLeft size={16} aria-hidden="true" /> Previous
                  </button>
                  <span className="pager__status">Page {currentPage + 1} of {pageCount}</span>
                  <button
                    type="button"
                    className="btn btn--secondary btn--compact"
                    aria-disabled={currentPage >= pageCount - 1}
                    onClick={() => currentPage < pageCount - 1 && setPage(currentPage + 1)}
                  >
                    Next <ChevronRight size={16} aria-hidden="true" />
                  </button>
                </>
              )}
              <button type="button" className="btn btn--ghost btn--compact" aria-pressed={showAll} onClick={() => setShowAll((value) => !value)}>
                {showAll ? 'Show pages' : `Show all ${sorted.length}`}
              </button>
            </nav>
          )}
        </div>
      </div>
    </section>
  );
}
