# Lone Star — Texas Income Atlas

A responsive, interactive 3D atlas of **mean annual household income** across all 254 Texas counties. Built with React, TypeScript, Three.js, and Vite. The app ships with its data and geographic boundaries; browsing requires no Census API key or external map service.

## Run

Use Node.js 24 and npm.

```sh
npm ci
npm run dev
```

Open the development server on port 3000. Hoplite uses the repository-owned `.hoplite/setup.sh` and `.hoplite/run.sh` scripts for its managed Preview.

```sh
npm test       # Data integrity, map geometry, and application utility tests
npm run build # Type checking and optimized static production build
npm run preview
```

Deploy the generated `dist/` directory to a static web host. The data is versioned alongside the application, so a production build does not depend on the Census API being available.

## Explore

- County color and extrusion height represent the same household **mean**, with a dollar-value legend.
- Search by county name or FIPS; select a county on the map or in the table to inspect its estimate and uncertainty.
- Switch between 2D and 3D, zoom, pan, rotate, tilt, or reset the camera using the labeled controls.
- Use the searchable county table as a non-WebGL, keyboard-accessible way to explore the data.
- Review the methodology for the release, dollar basis, income definition, and sampling caveats.

## Data

The latest available ACS 5-year release at implementation time (November 8, 2026) is **2020–2024**, released January 29, 2026. Dollar estimates are expressed in **2024 inflation-adjusted dollars**. Mean household income is total household income divided by the number of households; it is **not** median household income or per-capita income. The statewide figure is the official state estimate, not an unweighted average of county estimates.

The data pipeline joins official estimates and real county boundaries by five-digit county FIPS. Missing or suppressed values remain `null`, never fabricated values or zero. Source extracts, release metadata, geographic provenance, refresh instructions, and any limitations are documented in [docs/DATA.md](docs/DATA.md).

## Project layout

```text
public/data/          Versioned Census estimates and county GeoJSON
scripts/              Reproducible data ingestion
src/components/map/   Projection and 3D map implementation utilities
src/components/ui/    Search, table, and other interface components
src/lib/income.ts     Shared color, height, and currency encoding
src/types.ts          Shared data and component contracts
tests/                Automated integrity and behavior checks
```

The interface supports small screens, keyboard navigation, reduced-motion preferences, and a tabular alternative to the visual map. ACS figures are survey estimates, not exact measurements; point-estimate ranks should not be read as statistically significant differences.
