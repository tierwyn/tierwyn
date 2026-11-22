export function LoadingScreen({ message = 'INITIALIZING…' }: { message?: string }) {
  return (
    <div className="app-loading-screen" role="status" aria-live="polite" aria-label="Loading Tierwyn">
      <div className="app-loading-container">
        <div className="app-loading-logo-wrap">
          <div className="app-loading-glow" aria-hidden="true" />
          <svg
            className="app-loading-svg"
            viewBox="256 172 512 680"
            role="img"
            aria-label="Tierwyn Logo"
          >
            <defs>
              <filter id="tierwyn-core-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Fused Scaffold */}
            <path
              className="app-loading-scaffold"
              d="
                M 256,172 H 304 V 276 H 382.2 A 132 132 0 0 0 382.2,324 H 304 V 488 H 432 L 408,512 L 432,536 H 304 V 700 H 432 L 408,724 L 432,748 H 304 V 852 H 256 Z
                M 768,172 V 852 H 720 V 748 H 592 L 616,724 L 592,700 H 720 V 536 H 592 L 616,512 L 592,488 H 720 V 324 H 641.8 A 132 132 0 0 1 641.8,276 H 720 V 172 Z
              "
            />

            {/* Top Parent Core Command Ring */}
            <path
              className="app-loading-core"
              fillRule="evenodd"
              filter="url(#tierwyn-core-glow)"
              d="
                M 512,198 A 102 102 0 1 0 512,402 A 102 102 0 1 0 512,198 Z
                M 512,249 A 51 51 0 1 1 512,351 A 51 51 0 1 1 512,249 Z
              "
            />

            {/* Middle Hollow Diamond Envoy */}
            <path
              className="app-loading-diamond app-loading-diamond-middle"
              fillRule="evenodd"
              d="
                M 512,444 L 580,512 L 512,580 L 444,512 Z
                M 512,478 L 546,512 L 512,546 L 478,512 Z
              "
            />

            {/* Bottom Hollow Diamond Envoy */}
            <path
              className="app-loading-diamond app-loading-diamond-bottom"
              fillRule="evenodd"
              d="
                M 512,656 L 580,724 L 512,792 L 444,724 Z
                M 512,690 L 546,724 L 512,758 L 478,724 Z
              "
            />
          </svg>
        </div>

        <div className="app-loading-brand">TIERWYN</div>
        <div className="app-loading-bar-track">
          <div className="app-loading-bar-thumb" />
        </div>
        {message ? <div className="app-loading-status">{message}</div> : null}
      </div>
    </div>
  );
}
