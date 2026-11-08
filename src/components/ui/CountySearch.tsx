import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import { formatCurrency, getIncomeColor } from '../../lib/income';
import type { CountyIncome } from '../../types';
import { displayCountyName, searchCounties } from './atlasModel';

const MAX_RESULTS = 8;

interface CountySearchProps {
  counties: readonly CountyIncome[];
  onSelect: (fips: string) => void;
  disabled?: boolean;
}

/** WAI-ARIA combobox with a list popup; focus stays in the input while options are browsed. */
export default function CountySearch({ counties, onSelect, disabled = false }: CountySearchProps) {
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listboxId = `${baseId}-listbox`;
  const hintId = `${baseId}-hint`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const results = useMemo(() => searchCounties(counties, query, MAX_RESULTS), [counties, query]);
  const hasQuery = query.trim().length > 0;
  const expanded = open && hasQuery && results.length > 0;
  const optionId = (county: CountyIncome) => `${listboxId}-${county.fips}`;
  const activeCounty = expanded && activeIndex >= 0 ? results[activeIndex] : undefined;
  const activeOptionId = activeCounty ? optionId(activeCounty) : undefined;

  useEffect(() => {
    if (activeOptionId) document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
  }, [activeOptionId]);

  const close = () => {
    setOpen(false);
    setActiveIndex(-1);
  };

  const choose = (county: CountyIncome) => {
    onSelect(county.fips);
    setQuery('');
    close();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!hasQuery || results.length === 0) return;
        event.preventDefault();
        setOpen(true);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((index) => {
          if (!expanded || index < 0) return step === 1 ? 0 : results.length - 1;
          return (index + step + results.length) % results.length;
        });
        return;
      }
      case 'Enter':
        if (!expanded) return;
        event.preventDefault();
        choose(results[activeIndex >= 0 ? activeIndex : 0]);
        return;
      case 'Escape':
        if (expanded) {
          event.preventDefault();
          close();
        } else if (query) {
          event.preventDefault();
          setQuery('');
        }
        return;
      case 'Tab':
        close();
        return;
      default:
    }
  };

  let status = '';
  if (open && hasQuery) {
    status = results.length === 0
      ? 'No matching counties.'
      : `${results.length} ${results.length === 1 ? 'county' : 'counties'} found. Use the arrow keys to browse.`;
  }

  return (
    <div className="search">
      <label className="search__label" htmlFor={inputId}>Find a county</label>
      <div className="search__combo">
        <div className="search__field">
          <Search className="search__icon" size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            id={inputId}
            className="search__input"
            type="text"
            role="combobox"
            aria-expanded={expanded}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
            aria-describedby={hintId}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="search"
            placeholder={disabled ? 'Loading counties…' : 'County name or FIPS code'}
            disabled={disabled}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
              setActiveIndex(-1);
            }}
            onFocus={() => setOpen(true)}
            onBlur={close}
            onKeyDown={handleKeyDown}
          />
          {query && (
            <button
              type="button"
              className="search__clear"
              aria-label="Clear search"
              onClick={() => {
                setQuery('');
                close();
                inputRef.current?.focus();
              }}
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Matching counties"
          className="search__results"
          hidden={!expanded}
          // Keep focus in the input so a pointer selection never triggers blur first.
          onMouseDown={(event) => event.preventDefault()}
        >
          {results.map((county, index) => (
            <li
              key={county.fips}
              id={optionId(county)}
              role="option"
              aria-selected={index === activeIndex}
              className={`search__option${index === activeIndex ? ' is-active' : ''}`}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => choose(county)}
            >
              <span
                className={`swatch${county.meanIncome === null ? ' swatch--missing' : ''}`}
                style={{ backgroundColor: getIncomeColor(county.meanIncome) }}
                aria-hidden="true"
              />
              <span className="search__option-name">{displayCountyName(county.name)}</span>
              <span className={`search__option-value${county.meanIncome === null ? ' is-missing' : ''}`}>
                {formatCurrency(county.meanIncome)}
              </span>
            </li>
          ))}
        </ul>
        {open && hasQuery && results.length === 0 && (
          <p className="search__empty" aria-hidden="true">No county matches “{query.trim()}”.</p>
        )}
      </div>
      <p id={hintId} className="visually-hidden">
        Search all Texas counties by name or FIPS code. Use the up and down arrow keys to browse matches and Enter to select.
      </p>
      <p className="visually-hidden" role="status" aria-live="polite">{status}</p>
    </div>
  );
}
