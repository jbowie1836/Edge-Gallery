import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';

interface MapBoundaryState {
  failed: boolean;
}

/** Keeps the rest of the atlas usable if the WebGL map (or its lazy chunk) fails. */
export default class MapBoundary extends Component<{ children: ReactNode }, MapBoundaryState> {
  state: MapBoundaryState = { failed: false };

  static getDerivedStateFromError(): MapBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('County map failed to render', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="explorer__status" role="alert">
        <TriangleAlert size={28} aria-hidden="true" className="explorer__status-icon" />
        <p className="explorer__status-title">The 3D map couldn’t start.</p>
        <p>Your browser may not support WebGL. Every county estimate is still listed in the table below.</p>
        <div className="explorer__status-actions">
          <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
            <RefreshCw size={16} aria-hidden="true" /> Reload page
          </button>
          <a className="btn btn--secondary" href="#counties">Go to the county table</a>
        </div>
      </div>
    );
  }
}
