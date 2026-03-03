// ── PDF.js Viewer Interop Module ────────────────────────────────────────
// Provides PDF rendering, touch gestures (pinch-to-zoom, double-tap),
// Ctrl+mouse-wheel zoom, click-drag panning, single/continuous page modes,
// and resize handling.
// Called from the Blazor PdfViewer component via IJSObjectReference.

let pdfjsLib = null;
const viewers = {};  // containerId → viewer state

const PDFJS_VERSION = '4.6.82';
const PDFJS_CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;

// ── Configuration ───────────────────────────────────────────────────────
const MIN_SCALE = 0.5;   // Minimum allowed zoom level
const MAX_SCALE = 4.0;   // Maximum allowed zoom level

const DOUBLE_TAP_DELAY_MS = 300;   // Max interval between taps for double-tap
const DOUBLE_TAP_RADIUS_PX = 40;   // Max distance between taps (px)
const DOUBLE_TAP_ZOOM = 2.5;       // Zoom multiplier on double-tap (relative to fit)

// Ctrl+wheel zoom: exponential factor applied to deltaY.
// Mouse wheel (~100 delta/notch) → ~10% per notch.
// Trackpad (~2-10 delta/event) → smooth sub-percent increments.
const WHEEL_ZOOM_SPEED = 0.001;
const WHEEL_DEBOUNCE_MS = 250;     // Delay before committing wheel zoom to full render

// Swipe-at-boundary: triggers page navigation on mobile when
// the user swipes horizontally while already at the scroll edge.
const SWIPE_MIN_DISTANCE_PX = 60;  // Minimum horizontal travel for a swipe
const SWIPE_MAX_VERTICAL_PX = 80;  // Maximum vertical deviation (keeps it horizontal)
const SWIPE_MAX_DURATION_MS = 400;  // Maximum touch duration to count as a swipe

// iOS Safari enforces hard limits on canvas backing-store memory (~256 MB).
// These budgets prevent tab crashes on high-DPI devices at high zoom.
const MAX_CANVAS_PIXELS = 8_388_608;  // 8 MP per canvas
const MAX_TOTAL_PIXELS = 50_000_000;  // ~200 MB total across all pages (continuous mode)

// ── PDF.js bootstrap ────────────────────────────────────────────────────

/**
 * Lazily loads the PDF.js library via dynamic ESM import from CDN.
 * Only runs once — subsequent calls are no-ops.
 */
async function ensurePdfjsLoaded() {
    if (pdfjsLib) return;
    pdfjsLib = await import(`${PDFJS_CDN}/build/pdf.min.mjs`);
    pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/build/pdf.worker.min.mjs`;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Clamp a value between lo and hi (inclusive). */
function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

/**
 * Compute a scale factor for a PDF page based on the zoom mode.
 * - numeric value → used as-is
 * - 'page-width' → fit page width to container
 * - 'page-fit'   → fit entire page within container
 */
function computeScale(page, zoomValue, container, rotation) {
    if (typeof zoomValue === 'number') return zoomValue;

    const vp = page.getViewport({ scale: 1.0, rotation });
    const w = container.clientWidth - 24;   // 12px padding each side
    const h = container.clientHeight - 24;

    if (zoomValue === 'page-width') return w / vp.width;
    if (zoomValue === 'page-fit') return Math.min(w / vp.width, h / vp.height);
    return 1.0;
}

/**
 * Returns the effective scale for rendering.
 * If the user has pinch-zoomed, that overrides the computed scale.
 */
function getEffectiveScale(viewer, page, container) {
    return viewer.pinchScale !== null
        ? viewer.pinchScale
        : computeScale(page, viewer.zoomValue, container, viewer.rotation);
}

/** Euclidean distance between two touch points. */
function touchDist(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/** Midpoint between two touch points. */
function touchMid(a, b) {
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

/**
 * Return a device-pixel-ratio that keeps the canvas within the per-canvas
 * pixel budget.  On high-DPI devices at high zoom this may return a value
 * less than devicePixelRatio, but the page remains readable and Safari
 * won't crash from canvas memory exhaustion.
 */
function getSafeDpr(cssWidth, cssHeight) {
    const dpr = devicePixelRatio || 1;
    const pixels = cssWidth * dpr * cssHeight * dpr;
    if (pixels <= MAX_CANVAS_PIXELS) return dpr;
    // Scale DPR down so total backing-store pixels fit within the budget
    return Math.max(1, Math.sqrt(MAX_CANVAS_PIXELS / (cssWidth * cssHeight)));
}

/**
 * Measure the offset of the first .pdf-page element relative to the
 * scroll container's top-left content edge. Uses getBoundingClientRect
 * to get accurate positions regardless of offsetParent chain.
 * Returns {x, y} or {x:12, y:12} as fallback (the 12px padding).
 */
function getPageOffset(container) {
    const wrapper = container.firstElementChild;
    const page = wrapper?.querySelector('.pdf-page');
    if (!wrapper || !page) return { x: 12, y: 12 };

    // Use getBoundingClientRect to measure the page position relative
    // to the container's visible area, then add scroll to get the
    // position relative to the container's content origin.
    const containerRect = container.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    return {
        x: pageRect.left - containerRect.left + container.scrollLeft,
        y: pageRect.top - containerRect.top + container.scrollTop,
    };
}

// ── Page rendering ──────────────────────────────────────────────────────

/**
 * Renders PDF pages into the container.
 *
 * In single-page mode, only the current page is rendered.
 * In continuous mode, all pages are rendered until the pixel budget is exhausted.
 *
 * Uses a "render generation" counter to cancel stale renders — if a newer
 * render is triggered while this one is in progress, this one bails out.
 *
 * New content is built in a detached DOM fragment and swapped in atomically
 * after all rendering succeeds, preventing blank flashes on failure.
 */
async function renderPages(containerId) {
    const viewer = viewers[containerId];
    if (!viewer) return;

    const container = document.getElementById(containerId);
    if (!container) return;

    // Increment generation — any in-flight render with a lower gen will abort
    const gen = ++viewer.renderGeneration;

    // Build new content in a detached wrapper (not yet in the DOM)
    const wrapper = document.createElement('div');
    // Use inline-flex so the wrapper sizes to its content (the rendered pages)
    // without forcing the scroll container to grow. min-width:100% ensures
    // the wrapper fills the viewport when pages are narrower, so pages stay
    // centered via align-items:center. The scroll container clips and scrolls
    // any overflow beyond its own fixed bounds.
    wrapper.style.cssText =
        'display:inline-flex;flex-direction:column;align-items:flex-start;' +
        'gap:8px;padding:12px;min-width:100%;box-sizing:border-box';

    const { pdf, rotation, displayMode, currentPage } = viewer;
    let resolvedScale = 1.0;
    let totalPixels = 0;

    // Determine page range based on display mode
    const startPage = displayMode === 'single' ? currentPage : 1;
    const endPage = displayMode === 'single' ? currentPage : pdf.numPages;

    for (let i = startPage; i <= endPage; i++) {
        // Check if this render has been superseded
        if (viewer.renderGeneration !== gen) return;

        const page = await pdf.getPage(i);
        if (viewer.renderGeneration !== gen) return;

        const scale = getEffectiveScale(viewer, page, container);
        if (i === startPage) resolvedScale = scale;
        const vp = page.getViewport({ scale, rotation });

        // Compute safe backing-store dimensions to avoid Safari canvas limits
        const dpr = getSafeDpr(vp.width, vp.height);
        const bw = Math.floor(vp.width * dpr);
        const bh = Math.floor(vp.height * dpr);

        // Enforce total pixel budget in continuous mode to prevent memory exhaustion
        if (displayMode === 'continuous' && totalPixels + bw * bh > MAX_TOTAL_PIXELS) {
            console.warn(
                `[PdfViewer] Skipping page ${i}+ — total canvas pixel budget exceeded ` +
                `(${totalPixels.toLocaleString()} / ${MAX_TOTAL_PIXELS.toLocaleString()})`
            );
            break;
        }
        totalPixels += bw * bh;

        // Create page container div with shadow
        const div = document.createElement('div');
        div.className = 'pdf-page';
        div.style.cssText =
            `width:${vp.width}px;height:${vp.height}px;background:#fff;` +
            'box-shadow:0 2px 8px rgba(0,0,0,.3);flex-shrink:0;margin:0 auto';

        // Create and configure canvas
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            console.warn(`[PdfViewer] Failed to get 2D context for page ${i}`);
            continue;
        }
        canvas.width = bw;
        canvas.height = bh;
        canvas.style.width = `${vp.width}px`;
        canvas.style.height = `${vp.height}px`;
        ctx.scale(dpr, dpr);  // Scale context to match backing-store resolution

        div.appendChild(canvas);
        wrapper.appendChild(div);

        // Render the PDF page into the canvas
        try {
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
        } catch (err) {
            console.warn(`[PdfViewer] Render failed for page ${i}:`, err);
            // Show a fallback error message instead of a broken canvas
            canvas.style.display = 'none';
            const msg = document.createElement('div');
            msg.textContent = `Page ${i} — render error`;
            msg.style.cssText =
                'display:flex;align-items:center;justify-content:center;' +
                'width:100%;height:100%;color:#999;font-size:14px';
            div.appendChild(msg);
        }

        if (viewer.renderGeneration !== gen) return;
    }

    // ── Atomic DOM swap ──
    // Replace old content (possibly CSS-transformed from pinch/wheel zoom)
    // with the freshly rendered wrapper in a single step. This prevents any
    // flash of un-zoomed content between clearing the old and adding the new.
    container.innerHTML = '';
    container.appendChild(wrapper);
    viewer.wrapper = wrapper;

    // Cache the resolved scales for use by gesture handlers
    if (pdf.numPages > 0) {
        try {
            const refPage = await pdf.getPage(startPage);
            viewer.baseScale = computeScale(refPage, viewer.zoomValue, container, rotation);
            viewer.currentScale = resolvedScale;

            // Report the effective scale back to Blazor so the C# side
            // stays in sync with pinch/wheel zoom changes.
            if (viewer._dotNetRef) {
                viewer._dotNetRef.invokeMethodAsync('OnScaleChangedFromJs', resolvedScale);
            }
        } catch (err) {
            console.warn('[PdfViewer] Failed to cache base scale:', err);
        }
    }
}

// ── Focal-point scroll after render ─────────────────────────────────────

/**
 * After renderPages has swapped in new content, set the scroll so that
 * a specific point on the PDF page stays at a specific viewport position.
 *
 * Parameters describe the focal point in PAGE coordinates (relative to
 * the PDF page, not the wrapper). This avoids any dependency on the
 * wrapper's centering offset, which changes between renders.
 *
 * @param {string}  containerId - The container element ID
 * @param {number}  pageX       - X position on the page at OLD scale (0 = left edge of page)
 * @param {number}  pageY       - Y position on the page at OLD scale (0 = top edge of page)
 * @param {number}  vpX         - Viewport X where this point should appear
 * @param {number}  vpY         - Viewport Y where this point should appear
 * @param {number}  oldScale    - The PDF scale before the zoom
 */
function setScrollForFocalPoint(containerId, pageX, pageY, vpX, vpY, oldScale) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const viewer = viewers[containerId];
    if (!viewer) return;

    // Force layout reflow so scrollWidth/scrollHeight and element
    // positions reflect the newly swapped-in content.
    void container.offsetHeight;

    const newScale = viewer.currentScale ?? 1.0;
    const ratio = newScale / oldScale;
    const offset = getPageOffset(container);

    console.log('[PdfViewer] setScrollForFocalPoint:', {
        pageX, pageY, vpX, vpY,
        oldScale, newScale, ratio,
        offset,
        scrollWidth: container.scrollWidth,
        clientWidth: container.clientWidth,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        newContentX: offset.x + pageX * ratio,
        newContentY: offset.y + pageY * ratio,
        targetScrollLeft: Math.round(offset.x + pageX * ratio - vpX),
        targetScrollTop: Math.round(offset.y + pageY * ratio - vpY),
    });

    // If content fits entirely, let CSS centering handle it
    const fitsH = container.scrollWidth <= container.clientWidth;
    const fitsV = container.scrollHeight <= container.clientHeight;
    if (fitsH && fitsV) return;

    // The focal point in new content coordinates (relative to scroll origin).
    // pageX/pageY are in old-scale page coords, so multiply by ratio to
    // get the position in the new-scale layout.
    const newContentX = offset.x + pageX * ratio;
    const newContentY = offset.y + pageY * ratio;

    // Set scroll so that the focal point appears at the cursor position
    if (!fitsH) {
        container.scrollLeft = Math.max(0, Math.round(newContentX - vpX));
    }
    if (!fitsV) {
        container.scrollTop = Math.max(0, Math.round(newContentY - vpY));
    }
}

// ── Touch gestures ──────────────────────────────────────────────────────

/**
 * Sets up touch event handlers for pinch-to-zoom, double-tap-to-zoom,
 * and swipe-at-boundary page navigation.
 *
 * Pinch-to-zoom workflow:
 *   1. On touchstart (2 fingers): record initial distance, scale, and focal point
 *   2. On touchmove: apply CSS transform (translate + scale) to the wrapper for
 *      GPU-composited visual feedback — no re-rendering during the gesture
 *   3. On touchend (< 2 fingers): commit the final scale via full re-render,
 *      keeping the CSS transform visible until the atomic DOM swap completes
 *
 * Double-tap workflow:
 *   - Detects two taps within DOUBLE_TAP_DELAY_MS and DOUBLE_TAP_RADIUS_PX
 *   - Toggles between fit scale and DOUBLE_TAP_ZOOM × fit scale
 *
 * Swipe-at-boundary workflow (single-page mode only):
 *   - Only triggers if the swipe STARTED at a scroll boundary (or content fits)
 *   - Swipe left while already at the right edge → next page
 *   - Swipe right while already at the left edge → previous page
 *   - This prevents accidental page turns during normal panning
 */
function setupTouchGestures(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const viewer = viewers[containerId];
    if (!viewer) return;

    // Use at the top of setupTouchGestures, after getting viewer:
    const lo = viewer.minScale ?? MIN_SCALE;
    const hi = viewer.maxScale ?? MAX_SCALE;

    // ── Pinch state ──
    let isPinching = false;
    let pinchStartDist = 0;      // Distance between fingers at pinch start
    let pinchStartScale = 1.0;   // PDF scale when pinch began
    let focalCX = 0, focalCY = 0;   // Focal point in content coordinates
    let focalVX = 0, focalVY = 0;   // Focal point in viewport coordinates
    let originVX = 0, originVY = 0; // Initial viewport midpoint (for CSS transform origin)
    // Focal point in PAGE coordinates (relative to the PDF page, not the wrapper).
    // This is independent of centering offsets.
    let focalPageX = 0, focalPageY = 0;

    // ── Double-tap state ──
    let lastTapTime = 0;
    let lastTapX = 0, lastTapY = 0;
    let tapStartTime = 0;           // When the current tap began
    let tapStartX = 0, tapStartY = 0;
    let wasPinching = false;         // Suppress tap detection right after a pinch

    // ── Swipe-at-boundary state ──
    // Captured at touchstart so we know the user was ALREADY at the edge
    // before the swipe began — prevents pan-then-swipe from navigating.
    let swipeStartedAtLeftEdge = false;
    let swipeStartedAtRightEdge = false;

    /** Whether content fits horizontally (no scrollbar needed). 1px tolerance. */
    function fitsH() {
        return container.scrollWidth <= container.clientWidth + 1;
    }

    /** Whether scrolled to (or past) the right edge. 1px tolerance for rounding. */
    function atRightEdge() {
        return container.scrollLeft + container.clientWidth >= container.scrollWidth - 1;
    }

    /** Whether scrolled to the left edge. */
    function atLeftEdge() {
        return container.scrollLeft <= 1;
    }

    function onTouchStart(e) {
        if (e.touches.length === 2) {
            // ── Begin pinch gesture ──
            isPinching = true;
            wasPinching = true;

            pinchStartDist = touchDist(e.touches[0], e.touches[1]);
            pinchStartScale =
                viewer.pinchScale ?? viewer.currentScale ?? viewer.baseScale ?? 1.0;

            // Calculate initial focal point (midpoint of both fingers)
            const rect = container.getBoundingClientRect();
            const mid = touchMid(e.touches[0], e.touches[1]);

            originVX = mid.x - rect.left;   // Viewport-relative X
            originVY = mid.y - rect.top;    // Viewport-relative Y
            focalVX = originVX;
            focalVY = originVY;
            focalCX = originVX + container.scrollLeft;  // Content-relative X
            focalCY = originVY + container.scrollTop;   // Content-relative Y

            // Compute page-relative focal point (subtracting the page's
            // position within the wrapper to remove centering offset)
            const offset = getPageOffset(container);
            focalPageX = focalCX - offset.x;
            focalPageY = focalCY - offset.y;

            // Prepare wrapper for GPU-composited transforms
            if (viewer.wrapper) {
                viewer.wrapper.style.willChange = 'transform';
                viewer.wrapper.style.transformOrigin = '0 0';
            }

            e.preventDefault();
        } else if (e.touches.length === 1) {
            // Record start of potential tap (for double-tap detection)
            tapStartTime = Date.now();
            tapStartX = e.touches[0].clientX;
            tapStartY = e.touches[0].clientY;
            wasPinching = false;

            // Snapshot boundary state at swipe START.
            // The swipe will only navigate if the user was already at
            // the edge before the gesture — not if panning brought them there.
            swipeStartedAtLeftEdge = fitsH() || atLeftEdge();
            swipeStartedAtRightEdge = fitsH() || atRightEdge();
        }
    }

    function onTouchMove(e) {
        if (!isPinching || e.touches.length !== 2) return;
        e.preventDefault();

        // Calculate new scale from finger distance ratio
        const dist = touchDist(e.touches[0], e.touches[1]);
        const target = clamp(pinchStartScale * (dist / pinchStartDist), lo, hi);
        const cssRatio = target / pinchStartScale;

        // Track the moving midpoint so commitPinch uses end-of-gesture coords
        const rect = container.getBoundingClientRect();
        const mid = touchMid(e.touches[0], e.touches[1]);
        focalVX = mid.x - rect.left;
        focalVY = mid.y - rect.top;

        // Apply CSS transform for instant visual feedback.
        // translate() positions the scaled content so the original focal point
        // stays under the fingers; scale() applies the zoom.
        const tx = focalVX - originVX * cssRatio;
        const ty = focalVY - originVY * cssRatio;

        if (viewer.wrapper) {
            viewer.wrapper.style.transform =
                `translate(${tx}px, ${ty}px) scale(${cssRatio})`;
        }
    }

    /**
     * Commit the pinch gesture: trigger a full-resolution re-render at the
     * final scale.  The CSS transform is NOT cleared here — the old wrapper
     * keeps its blurry-but-correctly-positioned appearance until renderPages
     * atomically replaces it with sharp content.
     */
    async function commitPinch() {
        isPinching = false;

        // Read the final CSS scale ratio from the wrapper's transform
        let cssRatio = 1.0;
        if (viewer.wrapper) {
            const m = viewer.wrapper.style.transform.match(/scale\(([\d.]+)\)/);
            if (m) cssRatio = parseFloat(m[1]);
        }

        const finalScale = clamp(pinchStartScale * cssRatio, lo, hi);

        // If scale barely changed, treat it as a no-op (avoids unnecessary re-render)
        if (Math.abs(finalScale - pinchStartScale) < 0.005) {
            if (viewer.wrapper) {
                viewer.wrapper.style.transform = '';
                viewer.wrapper.style.transformOrigin = '';
                viewer.wrapper.style.willChange = '';
            }
            return;
        }

        // Commit the final pinch scale and re-render, then restore scroll
        // using page-relative focal point coordinates
        viewer.pinchScale = finalScale;
        try {
            await renderPages(containerId);
            setScrollForFocalPoint(
                containerId, focalPageX, focalPageY,
                originVX, originVY, pinchStartScale);
        } catch (err) {
            console.warn('[PdfViewer] Pinch commit failed:', err);
        }
    }

    /**
         * Toggle zoom on double-tap: if currently zoomed in beyond 1.3× fit,
         * zoom back to fit; otherwise zoom to DOUBLE_TAP_ZOOM × fit.
         *
         * Recomputes the fit scale fresh from the current page and container
         * dimensions rather than relying on the cached baseScale, which may
         * be stale if the container width changed (e.g. scrollbar appeared).
         */
    async function handleDoubleTap(clientX, clientY) {
        const rect = container.getBoundingClientRect();
        const vpX = clientX - rect.left;
        const vpY = clientY - rect.top;

        // Compute page-relative coordinates for the tap point
        const offset = getPageOffset(container);
        const pageX = vpX + container.scrollLeft - offset.x;
        const pageY = vpY + container.scrollTop - offset.y;

        const current =
            viewer.pinchScale ?? viewer.currentScale ?? viewer.baseScale ?? 1.0;

        // Recompute fit scale fresh from the current page instead of using
        // the cached baseScale, which may be stale after a zoom changed
        // the scrollbar state and therefore the container's clientWidth.
        let fit = viewer.baseScale ?? 1.0;
        try {
            const page = await viewer.pdf.getPage(viewer.currentPage);
            fit = computeScale(page, viewer.zoomValue, container, viewer.rotation);
        } catch { /* fall back to cached baseScale */ }

        // Determine if we're already zoomed in significantly
        const zoomedIn = current > fit * 1.3;
        const oldScale = current;

        if (zoomedIn) {
            // Zoom back to fit — clear pinch scale and cached values so
            // renderPages recomputes everything from the zoomValue cleanly
            viewer.pinchScale = null;
            viewer.baseScale = null;
            viewer.currentScale = null;
        } else {
            // Zoom in to DOUBLE_TAP_ZOOM × fit
            viewer.pinchScale = clamp(fit * DOUBLE_TAP_ZOOM, lo, hi);
        }

        await renderPages(containerId);
        setScrollForFocalPoint(containerId, pageX, pageY, vpX, vpY, oldScale);
    }

    function onTouchEnd(e) {
        // If pinch ended (fewer than 2 fingers remain), commit the zoom
        if (isPinching && e.touches.length < 2) {
            commitPinch().catch(err =>
                console.warn('[PdfViewer] Pinch commit failed:', err));
            return;
        }

        // Don't process taps/swipes immediately after a pinch, or if fingers remain
        if (wasPinching || e.touches.length > 0) return;

        const t = e.changedTouches[0];
        if (!t) return;

        const dt = Date.now() - tapStartTime;
        const dx = t.clientX - tapStartX;   // Signed: positive = finger moved right
        const dy = t.clientY - tapStartY;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        // ── Swipe-at-boundary: page navigation (single-page mode) ──
        // Must be: single-page mode, fast horizontal swipe, AND the swipe
        // started when the scroll was already at the boundary edge.
        if (
            viewer.displayMode === 'single' &&
            dt < SWIPE_MAX_DURATION_MS &&
            absDx > SWIPE_MIN_DISTANCE_PX &&
            absDy < SWIPE_MAX_VERTICAL_PX
        ) {
            // Swipe left (finger moved left, dx < 0) while at right edge → next page
            if (dx < 0 && swipeStartedAtRightEdge) {
                e.preventDefault();
                navigateToPage(containerId, viewer.currentPage + 1);
                lastTapTime = 0;
                return;
            }
            // Swipe right (finger moved right, dx > 0) while at left edge → previous page
            if (dx > 0 && swipeStartedAtLeftEdge) {
                e.preventDefault();
                navigateToPage(containerId, viewer.currentPage - 1);
                lastTapTime = 0;
                return;
            }
        }

        // ── Double-tap detection ──
        // Filter out long presses and drags (only short, stationary taps count)
        if (dt > 250 || absDx > 15 || absDy > 15) {
            lastTapTime = 0;  // Reset — this wasn't a tap
            return;
        }

        // Check if this tap forms a double-tap with the previous one
        const now = Date.now();
        const ddx = Math.abs(t.clientX - lastTapX);
        const ddy = Math.abs(t.clientY - lastTapY);

        if (
            lastTapTime &&
            now - lastTapTime < DOUBLE_TAP_DELAY_MS &&
            ddx < DOUBLE_TAP_RADIUS_PX &&
            ddy < DOUBLE_TAP_RADIUS_PX
        ) {
            // Double-tap confirmed — trigger zoom toggle
            e.preventDefault();
            handleDoubleTap(t.clientX, t.clientY).catch(err =>
                console.warn('[PdfViewer] Double-tap zoom failed:', err));
            lastTapTime = 0;
        } else {
            // First tap — record for potential double-tap
            lastTapTime = now;
            lastTapX = t.clientX;
            lastTapY = t.clientY;
        }
    }

    function onTouchCancel() {
        if (isPinching) {
            isPinching = false;
            // Cancel IS a revert — clear the CSS transform without re-rendering
            if (viewer.wrapper) {
                viewer.wrapper.style.transform = '';
                viewer.wrapper.style.transformOrigin = '';
                viewer.wrapper.style.willChange = '';
            }
        }
    }

    // Register touch listeners (non-passive to allow preventDefault)
    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: false });
    container.addEventListener('touchcancel', onTouchCancel);

    // Store cleanup function for disposePdfViewer
    viewer._gestureCleanup = () => {
        container.removeEventListener('touchstart', onTouchStart);
        container.removeEventListener('touchmove', onTouchMove);
        container.removeEventListener('touchend', onTouchEnd);
        container.removeEventListener('touchcancel', onTouchCancel);
    };
}

// ── Click-and-drag panning ──────────────────────────────────────────────

/**
 * Sets up click-and-drag (mouse) panning so the user can drag the PDF
 * to scroll when the content overflows the container.
 *
 * Uses cursor feedback: 'grab' when hoverable, 'grabbing' while dragging.
 * Only activates when content actually overflows (scrollWidth > clientWidth
 * or scrollHeight > clientHeight).
 *
 * Also supports mouse-swipe page navigation in single-page mode:
 *   - If content fits (no horizontal overflow): a horizontal drag navigates
 *     pages directly (left drag → next page, right drag → previous page).
 *   - If content overflows and the drag STARTED at a scroll boundary:
 *     a horizontal swipe at that boundary navigates pages.
 *   - Normal panning continues to work when not at a boundary.
 *   - Swipe thresholds (distance, duration, vertical tolerance) match
 *     the touch gesture constants for consistent behavior.
 */
function setupDragPan(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const viewer = viewers[containerId];
    if (!viewer) return;

    let isDragging = false;
    let startX = 0, startY = 0;         // Mouse position at drag start
    let startScrollX = 0, startScrollY = 0;  // Scroll position at drag start
    let dragStartTime = 0;              // Timestamp of mousedown (for swipe detection)

    // Snapshot boundary state at drag START so we only navigate when the
    // user was ALREADY at the edge before dragging — not if panning
    // brought them there.
    let swipeStartedAtLeftEdge = false;
    let swipeStartedAtRightEdge = false;

    /** Whether content fits horizontally (no scrollbar needed). 1px tolerance. */
    function fitsH() {
        return container.scrollWidth <= container.clientWidth + 1;
    }

    /** Whether scrolled to the left edge (1px tolerance). */
    function atLeftEdge() {
        return container.scrollLeft <= 1;
    }

    /** Whether scrolled to (or past) the right edge (1px tolerance). */
    function atRightEdge() {
        return container.scrollLeft + container.clientWidth >= container.scrollWidth - 1;
    }

    // Show grab cursor when content overflows
    container.style.cursor = 'grab';

    function onMouseDown(e) {
        // Focus the container so keyboard events (arrow keys) work
        // without requiring the user to tab to it
        container.focus();

        // Only left mouse button, and not when Ctrl is held (that's for zoom)
        if (e.button !== 0 || e.ctrlKey) return;

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startScrollX = container.scrollLeft;
        startScrollY = container.scrollTop;
        dragStartTime = Date.now();

        // Snapshot boundary state at drag START.
        // The swipe will only navigate if the user was already at
        // the edge before the gesture — not if panning brought them there.
        swipeStartedAtLeftEdge = fitsH() || atLeftEdge();
        swipeStartedAtRightEdge = fitsH() || atRightEdge();

        // Only change cursor and pan when content overflows
        const overflowsX = container.scrollWidth > container.clientWidth;
        const overflowsY = container.scrollHeight > container.clientHeight;
        if (overflowsX || overflowsY) {
            container.style.cursor = 'grabbing';
        }
        container.style.userSelect = 'none';  // Prevent text selection during drag

        e.preventDefault();
    }

    function onMouseMove(e) {
        if (!isDragging) return;

        // Only pan when content overflows
        const overflowsX = container.scrollWidth > container.clientWidth;
        const overflowsY = container.scrollHeight > container.clientHeight;
        if (!overflowsX && !overflowsY) return;

        // Calculate how far the mouse moved and scroll inversely
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        container.scrollLeft = startScrollX - dx;
        container.scrollTop = startScrollY - dy;
    }

    function onMouseUp(e) {
        if (!isDragging) return;
        isDragging = false;
        container.style.cursor = 'grab';
        container.style.userSelect = '';

        // ── Mouse swipe-at-boundary: page navigation (single-page mode) ──
        if (viewer.displayMode !== 'single') return;

        const dt = Date.now() - dragStartTime;
        const dx = e.clientX - startX;   // Signed: positive = mouse moved right (dragged right)
        const dy = e.clientY - startY;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        // Must be a fast, primarily horizontal swipe
        if (dt > SWIPE_MAX_DURATION_MS) return;
        if (absDx < SWIPE_MIN_DISTANCE_PX) return;
        if (absDy > SWIPE_MAX_VERTICAL_PX) return;

        // Drag left (mouse moved left, dx < 0) = swipe content left → next page
        // Only if content fits OR we started at the right edge
        if (dx < 0 && swipeStartedAtRightEdge) {
            navigateToPage(containerId, viewer.currentPage + 1);
            return;
        }
        // Drag right (mouse moved right, dx > 0) = swipe content right → previous page
        // Only if content fits OR we started at the left edge
        if (dx > 0 && swipeStartedAtLeftEdge) {
            navigateToPage(containerId, viewer.currentPage - 1);
            return;
        }
    }

    container.addEventListener('mousedown', onMouseDown);
    // Listen on document so dragging outside the container still works
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    // Store cleanup function for disposePdfViewer
    viewer._dragCleanup = () => {
        container.removeEventListener('mousedown', onMouseDown);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    };
}

// ── Ctrl + Mouse-wheel zoom ─────────────────────────────────────────────

/**
 * Sets up Ctrl+mouse-wheel zoom with smooth visual feedback.
 *
 * Workflow:
 *   1. On first Ctrl+wheel event: record baseline scale and focal point
 *      in PAGE coordinates (relative to the PDF page, not the wrapper)
 *   2. On each subsequent event: accumulate scale factor, apply CSS transform
 *      for instant visual feedback (GPU-composited, no re-render)
 *   3. After WHEEL_DEBOUNCE_MS of inactivity: commit to full-resolution render
 *      and restore scroll using the page-relative focal point
 *
 * Uses exponential scaling (Math.exp) so that:
 *   - Mouse wheels (~100 delta per notch) produce ~10% zoom per notch
 *   - Trackpads (~2-10 delta per event) produce smooth sub-percent increments
 *
 * The CSS transform is NOT cleared before the async re-render starts.
 * The old wrapper keeps its transform visible until renderPages atomically
 * replaces it, preventing any flash of un-zoomed content.
 */
function setupWheelZoom(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const viewer = viewers[containerId];
    if (!viewer) return;

    let wheelTimeout = null;
    let accumulatedScale = null;   // Running scale during a wheel burst
    let baseScaleAtStart = null;   // Scale when the burst began
    let originCX = 0, originCY = 0;  // Focal point in content coords (for CSS transform)
    let originVX = 0, originVY = 0;  // Focal point in viewport coords
    // Focal point in PAGE coordinates (relative to the PDF page element).
    // Independent of wrapper centering offsets — survives re-render.
    let originPageX = 0, originPageY = 0;

    function onWheel(e) {
        if (!e.ctrlKey) return;   // Only zoom when Ctrl is held
        e.preventDefault();       // Prevent browser zoom

        // Use the viewer's configurable zoom limits
        const lo = viewer.minScale ?? MIN_SCALE;
        const hi = viewer.maxScale ?? MAX_SCALE;

        const currentScale =
            viewer.pinchScale ?? viewer.currentScale ?? viewer.baseScale ?? 1.0;

        // First event in a new wheel burst — capture the baseline
        if (accumulatedScale === null) {
            accumulatedScale = currentScale;
            baseScaleAtStart = currentScale;

            // Record focal point (cursor position)
            const rect = container.getBoundingClientRect();
            originVX = e.clientX - rect.left;
            originVY = e.clientY - rect.top;
            originCX = originVX + container.scrollLeft;
            originCY = originVY + container.scrollTop;

            // Compute page-relative focal point by subtracting the page
            // element's position within the wrapper (removes centering offset)
            const offset = getPageOffset(container);
            originPageX = originCX - offset.x;
            originPageY = originCY - offset.y;

            // Prepare wrapper for GPU-composited transforms
            if (viewer.wrapper) {
                viewer.wrapper.style.willChange = 'transform';
                viewer.wrapper.style.transformOrigin = '0 0';
            }
        }

        // Apply exponential zoom factor
        const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SPEED);
        accumulatedScale = clamp(accumulatedScale * factor, lo, hi);

        // Apply CSS transform for instant visual feedback
        const cssRatio = accumulatedScale / baseScaleAtStart;
        if (viewer.wrapper) {
            // Translate so the content under the cursor stays fixed.
            // This uses wrapper-relative content coords (originCX/CY) which
            // are correct for the CSS transform on the current wrapper.
            const tx = originCX * (1 - cssRatio);
            const ty = originCY * (1 - cssRatio);
            viewer.wrapper.style.transform =
                `translate(${tx}px, ${ty}px) scale(${cssRatio})`;
        }

        // Debounce: wait for wheel activity to settle before committing
        clearTimeout(wheelTimeout);
        wheelTimeout = setTimeout(() => {
            const finalScale = accumulatedScale;
            // Capture focal point data before resetting burst state
            const pX = originPageX;
            const pY = originPageY;
            const vX = originVX;
            const vY = originVY;
            const oldScale = baseScaleAtStart;

            // Reset burst state before async work
            accumulatedScale = null;
            baseScaleAtStart = null;

            // Re-render at the final scale. This is necessary because the
            // CSS transform is relative to baseScaleAtStart — without
            // re-rendering, the next wheel burst would start with a stale
            // transform and the zoom would visually jump.
            viewer.pinchScale = finalScale;
            renderPages(containerId)
                .then(() => {
                    setScrollForFocalPoint(containerId, pX, pY, vX, vY, oldScale);
                })
                .catch(err => {
                    console.warn('[PdfViewer] Wheel zoom re-render failed:', err);
                });
        }, WHEEL_DEBOUNCE_MS);
    }

    container.addEventListener('wheel', onWheel, { passive: false });

    // Store cleanup function for disposePdfViewer
    viewer._wheelCleanup = () => {
        container.removeEventListener('wheel', onWheel);
        clearTimeout(wheelTimeout);
    };
}

// ── Orientation / resize handling ───────────────────────────────────────

/**
 * Watches the container for size changes (e.g., orientation change, window
 * resize) and re-renders when using relative zoom modes ('page-width',
 * 'page-fit').  Debounced to avoid thrashing during animated resizes.
 *
 * Does NOT re-render when the user has pinch-zoomed (pinchScale !== null),
 * because that would override their manual zoom level.
 */
function setupResizeHandler(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const viewer = viewers[containerId];
    if (!viewer) return;

    let timeout;
    const observer = new ResizeObserver(() => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            // Only re-render for relative zoom modes when not manually zoomed
            if (typeof viewer.zoomValue === 'string' && viewer.pinchScale === null) {
                viewer.baseScale = null;
                viewer.currentScale = null;
                renderPages(containerId).catch(err =>
                    console.warn('[PdfViewer] Resize re-render failed:', err));
            }
        }, 250);
    });

    observer.observe(container);
    viewer._resizeObserver = observer;
}

// ── Base64 decode ───────────────────────────────────────────────────────

/** Convert a base64 string to Uint8Array (for loading PDFs from byte data). */
function base64ToUint8Array(b64) {
    const raw = atob(b64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
}

// ── Public API ──────────────────────────────────────────────────────────

/** Create a fresh viewer state object with default values. */
function createViewerState(pdf, zoomValue, rotation, displayMode) {
    return {
        pdf,                              // PDF.js document proxy
        zoomValue,                        // Current zoom setting (number or string)
        rotation,                         // Current rotation in degrees
        displayMode: displayMode ?? 'single',  // 'single' or 'continuous'
        currentPage: 1,                   // Current page number (used in single mode)
        pinchScale: null,                 // Scale set by pinch/wheel (overrides zoomValue)
        baseScale: null,                  // Cached: scale computed from zoomValue
        currentScale: null,               // Cached: actual scale used in last render
        renderGeneration: 0,              // Incremented each render to cancel stale ones
        wrapper: null,                    // Reference to the current content wrapper div
        minScale: 0.5,                    // Minimum zoom level (set from Blazor)
        maxScale: 4.0,                    // Maximum zoom level (set from Blazor)
    };
}

/**
 * Initialize the PDF viewer from a URL.
 * @param {object} dotNetRef - DotNetObjectReference for calling back into Blazor.
 * @param {number} minScale  - Minimum zoom level from Blazor.
 * @param {number} maxScale  - Maximum zoom level from Blazor.
 * @returns {number} Total number of pages in the PDF.
 */
export async function initialize(containerId, pdfUrl, zoomValue, rotation, displayMode, dotNetRef, minScale, maxScale) {
    await ensurePdfjsLoaded();

    // Dispose any existing viewer for this container
    if (viewers[containerId]) disposePdfViewer(containerId);

    const pdf = await pdfjsLib.getDocument({
        url: pdfUrl,
        cMapUrl: `${PDFJS_CDN}/cmaps/`,
        cMapPacked: true,
    }).promise;

    viewers[containerId] = createViewerState(pdf, zoomValue, rotation, displayMode);
    const viewer = viewers[containerId];
    // Store the .NET reference for JS→Blazor callbacks (e.g. page navigation)
    viewer._dotNetRef = dotNetRef ?? null;
    // Apply min/max zoom limits from Blazor parameters
    if (typeof minScale === 'number') viewer.minScale = minScale;
    if (typeof maxScale === 'number') viewer.maxScale = maxScale;
    await renderPages(containerId);
    setupTouchGestures(containerId);
    setupWheelZoom(containerId);
    setupDragPan(containerId);
    setupKeyboardPan(containerId);
    setupResizeHandler(containerId);
    return pdf.numPages;
}

/**
 * Initialize the PDF viewer from raw byte data (base64 string or byte array).
 * @param {object} dotNetRef - DotNetObjectReference for calling back into Blazor.
 * @param {number} minScale  - Minimum zoom level from Blazor.
 * @param {number} maxScale  - Maximum zoom level from Blazor.
 * @returns {number} Total number of pages in the PDF.
 */
export async function initializeFromData(containerId, pdfData, zoomValue, rotation, displayMode, dotNetRef, minScale, maxScale) {
    await ensurePdfjsLoaded();

    // Dispose any existing viewer for this container
    if (viewers[containerId]) disposePdfViewer(containerId);

    // Accept both base64 strings and byte arrays from Blazor interop
    const data = typeof pdfData === 'string'
        ? base64ToUint8Array(pdfData)
        : new Uint8Array(pdfData);

    const pdf = await pdfjsLib.getDocument({
        data,
        cMapUrl: `${PDFJS_CDN}/cmaps/`,
        cMapPacked: true,
    }).promise;

    viewers[containerId] = createViewerState(pdf, zoomValue, rotation, displayMode);
    const viewer = viewers[containerId];
    // Store the .NET reference for JS→Blazor callbacks (e.g. page navigation)
    viewer._dotNetRef = dotNetRef ?? null;
    // Apply min/max zoom limits from Blazor parameters
    if (typeof minScale === 'number') viewer.minScale = minScale;
    if (typeof maxScale === 'number') viewer.maxScale = maxScale;
    await renderPages(containerId);
    setupTouchGestures(containerId);
    setupWheelZoom(containerId);
    setupDragPan(containerId);
    setupKeyboardPan(containerId);
    setupResizeHandler(containerId);
    return pdf.numPages;
}

/**
 * Update zoom, rotation, and/or display mode without reloading the PDF.
 * Resets any manual pinch/wheel zoom so the new zoomValue takes effect.
 */
export async function updateView(containerId, zoomValue, rotation, displayMode) {
    const viewer = viewers[containerId];
    if (!viewer) return;

    viewer.zoomValue = zoomValue;
    viewer.rotation = rotation;
    if (displayMode !== undefined) viewer.displayMode = displayMode;

    // Reset pinch/wheel zoom so the new zoomValue is applied
    viewer.pinchScale = null;
    viewer.baseScale = null;
    viewer.currentScale = null;

    await renderPages(containerId);
}

/**
 * Navigate to a specific page (single-page mode).
 * Clamps the page number to valid range.  Scrolls to top-left after render.
 */
export async function goToPage(containerId, pageNum) {
    const viewer = viewers[containerId];
    if (!viewer) return;

    const clamped = clamp(pageNum, 1, viewer.pdf.numPages);

    // Skip if already on this page and content is rendered
    if (clamped === viewer.currentPage && viewer.wrapper) return;

    viewer.currentPage = clamped;
    await renderPages(containerId);

    // Reset scroll to top-left for the new page
    const container = document.getElementById(containerId);
    if (container) {
        container.scrollLeft = 0;
        container.scrollTop = 0;
    }
}

/**
 * Dispose the viewer: remove event listeners, disconnect observers,
 * destroy the PDF.js document, and clear the container.
 */
export function disposePdfViewer(containerId) {
    const viewer = viewers[containerId];
    if (viewer) {
        if (viewer._gestureCleanup) viewer._gestureCleanup();
        if (viewer._wheelCleanup) viewer._wheelCleanup();
        if (viewer._dragCleanup) viewer._dragCleanup();
        if (viewer._keyboardCleanup) viewer._keyboardCleanup();
        if (viewer._contextMenuCleanup) viewer._contextMenuCleanup();
        if (viewer._resizeObserver) viewer._resizeObserver.disconnect();
        viewer.pdf.destroy();
        delete viewers[containerId];
    }
    const container = document.getElementById(containerId);
    if (container) container.innerHTML = '';
}

// ── Arrow-key panning ───────────────────────────────────────────────────

/** Pixels to scroll per arrow-key press. */
const ARROW_SCROLL_PX = 60;

/**
 * Sets up arrow-key scrolling and page navigation.
 *
 * Behavior in single-page mode:
 *   - Ctrl+Arrow always navigates pages immediately.
 *   - If content fits (no overflow): Arrow Left/Right navigate pages directly.
 *   - If content overflows: Arrow keys scroll the content.
 *   - At a scroll boundary: the FIRST arrow press at the edge does nothing
 *     (absorbs the keypress). The SECOND consecutive press at the same edge
 *     navigates to the next/previous page. This prevents accidental page
 *     turns when the user is scrolling and hits the boundary.
 *
 * The "second press" state is tracked per direction and resets whenever:
 *   - A different key is pressed
 *   - The scroll position moves away from the boundary
 *   - A page navigation occurs
 */
function setupKeyboardPan(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const viewer = viewers[containerId];
    if (!viewer) return;

    // Make the container focusable so it can receive keydown events
    if (!container.hasAttribute('tabindex')) {
        container.setAttribute('tabindex', '0');
        // Remove the default focus outline — the container border is enough
        container.style.outline = 'none';
    }

    // Tracks whether the user already pressed an arrow key at a boundary
    // and was "warned" (the first press did nothing). The next press in
    // the same direction triggers page navigation.
    let edgeReadyDirection = null; // 'left' | 'right' | null

    /** Whether scrolled to the left edge (1px tolerance). */
    function atLeftEdge() {
        return container.scrollLeft <= 1;
    }

    /** Whether scrolled to (or past) the right edge (1px tolerance). */
    function atRightEdge() {
        return container.scrollLeft + container.clientWidth >= container.scrollWidth - 1;
    }

    function onKeyDown(e) {
        // ── Ctrl+Arrow: always navigate pages immediately in single-page mode ──
        if (e.ctrlKey && viewer.displayMode === 'single') {
            if (e.key === 'ArrowRight') {
                e.preventDefault();
                edgeReadyDirection = null;
                navigateToPage(containerId, viewer.currentPage + 1);
                return;
            }
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                edgeReadyDirection = null;
                navigateToPage(containerId, viewer.currentPage - 1);
                return;
            }
        }

        // ── Plain arrow keys ──
        const overflowsX = container.scrollWidth > container.clientWidth + 1;
        const overflowsY = container.scrollHeight > container.clientHeight + 1;

        // Reset edge state if a non-horizontal arrow key is pressed
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
            edgeReadyDirection = null;
        }

        switch (e.key) {
            case 'ArrowLeft':
                if (viewer.displayMode === 'single') {
                    if (!overflowsX) {
                        // Content fits horizontally — navigate directly
                        e.preventDefault();
                        edgeReadyDirection = null;
                        navigateToPage(containerId, viewer.currentPage - 1);
                        return;
                    }
                    if (atLeftEdge()) {
                        // Already at left edge — check two-press gate
                        e.preventDefault();
                        if (edgeReadyDirection === 'left') {
                            // Second press at left edge → navigate
                            edgeReadyDirection = null;
                            navigateToPage(containerId, viewer.currentPage - 1);
                        } else {
                            // First press at left edge → absorb (do nothing)
                            edgeReadyDirection = 'left';
                        }
                        return;
                    }
                    // Not at edge — scroll normally, reset edge state
                    edgeReadyDirection = null;
                }
                if (overflowsX) {
                    container.scrollLeft -= ARROW_SCROLL_PX;
                    e.preventDefault();
                }
                break;

            case 'ArrowRight':
                if (viewer.displayMode === 'single') {
                    if (!overflowsX) {
                        // Content fits horizontally — navigate directly
                        e.preventDefault();
                        edgeReadyDirection = null;
                        navigateToPage(containerId, viewer.currentPage + 1);
                        return;
                    }
                    if (atRightEdge()) {
                        // Already at right edge — check two-press gate
                        e.preventDefault();
                        if (edgeReadyDirection === 'right') {
                            // Second press at right edge → navigate
                            edgeReadyDirection = null;
                            navigateToPage(containerId, viewer.currentPage + 1);
                        } else {
                            // First press at right edge → absorb (do nothing)
                            edgeReadyDirection = 'right';
                        }
                        return;
                    }
                    // Not at edge — scroll normally, reset edge state
                    edgeReadyDirection = null;
                }
                if (overflowsX) {
                    container.scrollLeft += ARROW_SCROLL_PX;
                    e.preventDefault();
                }
                break;

            case 'ArrowUp':
                if (overflowsY) {
                    container.scrollTop -= ARROW_SCROLL_PX;
                    e.preventDefault();
                }
                break;

            case 'ArrowDown':
                if (overflowsY) {
                    container.scrollTop += ARROW_SCROLL_PX;
                    e.preventDefault();
                }
                break;

            default:
                return; // Don't preventDefault for non-arrow keys
        }
    }

    container.addEventListener('keydown', onKeyDown);

    // Store cleanup function for disposePdfViewer
    viewer._keyboardCleanup = () => {
        container.removeEventListener('keydown', onKeyDown);
    };
}

/**
* Focus the scroll container so it receives keyboard events.
* Called from Blazor after toolbar button clicks to restore
* arrow-key panning without requiring the user to click the PDF again.
*/
export function focusContainer(containerId) {
    const container = document.getElementById(containerId);
    if (container) container.focus();
}

// ── Page navigation helper ──────────────────────────────────────────────

/**
 * Navigate to a page (render + scroll to top + notify Blazor).
 * Shared by keyboard, swipe, and toolbar-triggered navigation.
 * Does nothing if the page is out of range or already current.
 */
function navigateToPage(containerId, newPage) {
    const viewer = viewers[containerId];
    if (!viewer) return;
    if (newPage < 1 || newPage > viewer.pdf.numPages) return;
    if (newPage === viewer.currentPage) return;

    viewer.currentPage = newPage;
    renderPages(containerId)
        .then(() => {
            const c = document.getElementById(containerId);
            if (c) { c.scrollLeft = 0; c.scrollTop = 0; }
            // Notify Blazor of the page change so the toolbar updates
            if (viewer._dotNetRef) {
                viewer._dotNetRef.invokeMethodAsync('OnPageChangedFromJs', newPage);
            }
        })
        .catch(err => console.warn('[PdfViewer] Page nav failed:', err));
}

// ── Programmatic zoom ───────────────────────────────────────────────────

/**
 * Reset zoom to a specific mode ('page-width', 'page-fit') or numeric scale.
 * Clears any pinch/wheel zoom override and re-renders with the given zoom value.
 *
 * @param {string}        containerId - The container element ID
 * @param {string|number} zoomValue   - 'page-width', 'page-fit', or a numeric scale
 */
export async function resetZoom(containerId, zoomValue) {
    const viewer = viewers[containerId];
    if (!viewer) return;

    // Clear any manual pinch/wheel zoom so the new zoomValue takes effect
    viewer.zoomValue = zoomValue;
    viewer.pinchScale = null;
    viewer.baseScale = null;
    viewer.currentScale = null;

    await renderPages(containerId);

    // Reset scroll to top-left after zoom reset
    const container = document.getElementById(containerId);
    if (container) {
        container.scrollLeft = 0;
        container.scrollTop = 0;
    }
}

/**
 * Adjust the current zoom by a signed delta.
 * Positive delta zooms in, negative zooms out.
 * Clamps the result to [minScale, maxScale].
 *
 * @param {string} containerId - The container element ID
 * @param {number} delta       - Amount to add to current scale (e.g. 0.25 = +25%)
 * @param {number} minScale    - Minimum allowed scale
 * @param {number} maxScale    - Maximum allowed scale
 */
export async function zoomBy(containerId, delta, minScale, maxScale) {
    const viewer = viewers[containerId];
    if (!viewer) return;

    const container = document.getElementById(containerId);
    if (!container) return;

    // Determine the current effective scale
    const current =
        viewer.pinchScale ?? viewer.currentScale ?? viewer.baseScale ?? 1.0;

    const newScale = clamp(current + delta, minScale, maxScale);

    // Skip if the scale didn't actually change (already at limit)
    if (Math.abs(newScale - current) < 0.001) return;

    // Apply the new scale as a pinch override and re-render
    viewer.pinchScale = newScale;
    await renderPages(containerId);

    // Scroll to top-left after programmatic zoom
    container.scrollLeft = 0;
    container.scrollTop = 0;
}

// ── Print ───────────────────────────────────────────────────────────────

/**
 * Print a range of PDF pages by rendering them into a hidden iframe
 * and triggering the browser's print dialog.
 *
 * Each page is rendered to a canvas at 2× scale for print-quality output,
 * converted to a data URL, and placed as an <img> in the print document.
 *
 * @param {string} containerId - The container element ID
 * @param {number} startPage   - First page to print (1-based)
 * @param {number} endPage     - Last page to print (1-based, inclusive)
 */
export async function printPdf(containerId, startPage, endPage) {
    const viewer = viewers[containerId];
    if (!viewer) return;

    const { pdf, rotation } = viewer;

    // Render all requested pages to data URLs at print-quality resolution
    const pageImages = [];
    for (let i = startPage; i <= endPage; i++) {
        const page = await pdf.getPage(i);
        // Use 2× scale for crisp print output
        const printScale = 2.0;
        const vp = page.getViewport({ scale: printScale, rotation });

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;

        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);

        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        pageImages.push({
            dataUrl: canvas.toDataURL('image/png'),
            width: vp.width,
            height: vp.height,
        });
    }

    if (pageImages.length === 0) return;

    // Create a hidden iframe for printing
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;top:-10000px;left:-10000px;width:0;height:0';
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) {
        document.body.removeChild(iframe);
        return;
    }

    // Build the print document with each page as a full-page image
    doc.open();
    doc.write(`<!DOCTYPE html><html><head><style>
        @media print {
            body { margin: 0; }
            img {
                display: block;
                max-width: 100%;
                height: auto;
                page-break-after: always;
            }
            img:last-child { page-break-after: avoid; }
        }
        @media screen { body { margin: 0; } }
    </style></head><body>`);

    for (const img of pageImages) {
        doc.write(`<img src="${img.dataUrl}" />`);
    }

    doc.write('</body></html>');
    doc.close();

    // Wait for images to load before printing
    const images = doc.querySelectorAll('img');
    await Promise.all(Array.from(images).map(img =>
        img.complete
            ? Promise.resolve()
            : new Promise(resolve => { img.onload = resolve; img.onerror = resolve; })
    ));

    // Trigger print and clean up the iframe after the dialog closes.
    // Use the 'afterprint' event when available so the iframe stays alive
    // while the user interacts with the print dialog. Fall back to a
    // generous timeout for browsers that don't fire the event.
    const cleanup = () => {
        try { document.body.removeChild(iframe); } catch { /* already removed */ }
    };
    const win = iframe.contentWindow;
    if (win) {
        win.addEventListener('afterprint', cleanup, { once: true });
        // Safety net: remove after 60s even if afterprint never fires
        setTimeout(cleanup, 60_000);
        win.focus();
        win.print();
    } else {
        cleanup();
    }
}

// ── Text search with highlight ──────────────────────────────────────────

/**
 * Strip diacritical marks from a string so that e.g. "Curaçao" matches
 * a search for "curacao". Uses Unicode NFD decomposition to separate
 * base characters from combining marks, then removes the marks.
 */
function stripDiacritics(str) {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Search for text in the PDF and highlight all occurrences with
 * semi-transparent overlays on top of the rendered canvas.
 *
 * Pass an empty string to clear all highlights.
 *
 * In single-page mode, only the current page is searched.
 * In continuous mode, all rendered pages are searched.
 *
 * The search is case-insensitive and diacritics-insensitive,
 * so "curacao" will match "Curaçao".
 *
 * @param {string} containerId - The container element ID
 * @param {string} query       - Text to search for (case-insensitive)
 */
export async function searchText(containerId, query) {
    const viewer = viewers[containerId];
    if (!viewer) return;

    const container = document.getElementById(containerId);
    if (!container) return;

    // Remove any existing highlight overlays
    container.querySelectorAll('.pdf-search-highlight').forEach(el => el.remove());

    // If query is empty, just clear highlights
    if (!query || query.trim() === '') return;

    const { pdf, rotation, displayMode, currentPage } = viewer;
    const startPage = displayMode === 'single' ? currentPage : 1;
    const endPage = displayMode === 'single' ? currentPage : pdf.numPages;

    // Get all rendered .pdf-page divs in the container
    const pageDivs = container.querySelectorAll('.pdf-page');
    if (pageDivs.length === 0) return;

    // Normalize query: strip diacritics and lowercase for accent-insensitive matching
    const normalizedQuery = stripDiacritics(query.toLowerCase());

    // In continuous mode, only iterate over the actually rendered page divs
    // (the pixel budget may have cut off rendering early).
    const renderedCount = pageDivs.length;

    for (let i = startPage; i <= endPage; i++) {
        // Map page number to rendered div index
        const pageIdx = displayMode === 'single' ? 0 : i - startPage;

        // Stop if we've exceeded the number of actually rendered page divs
        if (pageIdx >= renderedCount) break;

        const pageDiv = pageDivs[pageIdx];
        if (!pageDiv) continue;

        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();

        // Determine the scale used for this page's rendering
        const scale = viewer.pinchScale ?? viewer.currentScale ?? viewer.baseScale ?? 1.0;
        const vp = page.getViewport({ scale, rotation });

        // Search each text item for the query (case + diacritics insensitive)
        for (const item of textContent.items) {
            if (!item.str) continue;

            // Normalize the item text the same way as the query
            const normalizedStr = stripDiacritics(item.str.toLowerCase());

            // NFD decomposition may change string length (e.g. "ç" → "c" + combining cedilla → stripped to "c").
            // Build a mapping from normalized-string index back to original-string index
            // so highlight positions use the original (pre-normalization) character widths.
            const normToOrigMap = [];
            let origIdx = 0;
            const origNfd = item.str.normalize('NFD');
            for (let n = 0; n < origNfd.length; n++) {
                const ch = origNfd[n];
                // Combining marks (U+0300–U+036F) are stripped in normalizedStr,
                // so they don't get a slot in the map
                if (!/[\u0300-\u036f]/.test(ch)) {
                    normToOrigMap.push(origIdx);
                }
                origIdx++;
            }
            // Sentinel to simplify end-of-match offset calculation
            normToOrigMap.push(item.str.length);

            let searchIdx = 0;

            // Find all occurrences of the normalized query within the normalized text
            while ((searchIdx = normalizedStr.indexOf(normalizedQuery, searchIdx)) !== -1) {
                // Map normalized match positions back to original string positions
                // to get correct character-width-based offsets
                const origStart = normToOrigMap[searchIdx] ?? searchIdx;
                const origEnd = normToOrigMap[searchIdx + normalizedQuery.length] ?? (searchIdx + normalizedQuery.length);

                // item.transform: [scaleX, skewY, skewX, scaleY, translateX, translateY]
                // item.width/height are in unscaled PDF units.
                const itemTx = item.transform;

                // Font height from the transform's scaleY, falling back to item.height
                const fontHeight = Math.abs(itemTx[3]) || item.height || 10;

                // Estimate character width in PDF units (unscaled)
                const charWidth = item.width / Math.max(item.str.length, 1);
                const matchOffsetX = origStart * charWidth;
                const matchWidth = (origEnd - origStart) * charWidth;

                // The text item's origin in PDF coords is (itemTx[4], itemTx[5]).
                // This is the BASELINE of the text. The top of the glyph is
                // at pdfY + fontHeight (PDF Y-axis points up).
                const pdfX = itemTx[4] + matchOffsetX;
                const pdfY = itemTx[5];

                // Transform the top-left and bottom-right corners from PDF
                // page coordinates to viewport (pixel) coordinates.
                // Top of glyph: pdfY + fontHeight (above baseline in PDF coords)
                // Bottom of glyph: pdfY (baseline)
                const topLeft = pdfjsLib.Util.applyTransform(
                    [pdfX, pdfY + fontHeight], vp.transform
                );
                const bottomRight = pdfjsLib.Util.applyTransform(
                    [pdfX + matchWidth, pdfY], vp.transform
                );

                // Compute the highlight rectangle from the two transformed corners.
                // The viewport transform flips Y (PDF bottom-up → screen top-down),
                // so use min/max for robustness.
                const left = Math.min(topLeft[0], bottomRight[0]);
                const top = Math.min(topLeft[1], bottomRight[1]);
                const width = Math.abs(bottomRight[0] - topLeft[0]);
                const height = Math.abs(bottomRight[1] - topLeft[1]);

                // Skip degenerate highlights (zero-size or NaN)
                if (width < 1 || height < 1 || isNaN(left) || isNaN(top)) {
                    searchIdx += normalizedQuery.length;
                    continue;
                }

                // Create highlight overlay div — neon yellow marker style
                const highlight = document.createElement('div');
                highlight.className = 'pdf-search-highlight';
                highlight.style.cssText =
                    `position:absolute;` +
                    `left:${left}px;` +
                    `top:${top}px;` +
                    `width:${width}px;` +
                    `height:${height}px;` +
                    `background:rgba(255,255,0,0.55);` +
                    `outline:2px solid rgba(255,200,0,0.8);` +
                    `border-radius:2px;` +
                    `pointer-events:none;` +
                    `z-index:10;` +
                    `mix-blend-mode:multiply;`;

                // The page div needs relative positioning for the absolute highlights
                pageDiv.style.position = 'relative';
                pageDiv.appendChild(highlight);

                searchIdx += normalizedQuery.length;
            }
        }
    }

    // Scroll to the first highlight if one was found
    const firstHighlight = container.querySelector('.pdf-search-highlight');
    if (firstHighlight) {
        firstHighlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// ── Download ────────────────────────────────────────────────────────────

/**
 * Download the entire original PDF file.
 *
 * If the viewer was initialized from byte data, reconstructs a Blob from
 * the PDF.js document's raw data. If initialized from a URL, fetches the
 * file and triggers the download.
 *
 * @param {string} containerId - The container element ID
 * @param {string} fileName    - Suggested file name for the download
 */
export async function downloadAllPages(containerId, fileName) {
    const viewer = viewers[containerId];
    if (!viewer) return;

    try {
        // Get the raw PDF bytes from the PDF.js document
        const data = await viewer.pdf.getData();
        const blob = new Blob([data], { type: 'application/pdf' });
        triggerDownload(blob, fileName || 'document.pdf');
    } catch (err) {
        console.warn('[PdfViewer] Download all failed:', err);
    }
}

/**
 * Download the current page as a PNG image.
 *
 * Renders the page at 2× scale for high-quality output, converts the
 * canvas to a Blob, and triggers a browser download.
 *
 * @param {string} containerId - The container element ID
 * @param {number} pageNum     - The page number to download (1-based)
 * @param {string} fileName    - Suggested file name for the download
 */
export async function downloadPage(containerId, pageNum, fileName) {
    const viewer = viewers[containerId];
    if (!viewer) return;

    const { pdf, rotation } = viewer;
    const clamped = Math.max(1, Math.min(pageNum, pdf.numPages));

    try {
        const page = await pdf.getPage(clamped);
        // Use 2× scale for high-quality output
        const downloadScale = 2.0;
        const vp = page.getViewport({ scale: downloadScale, rotation });

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            console.warn('[PdfViewer] Failed to get 2D context for download');
            return;
        }

        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);

        await page.render({ canvasContext: ctx, viewport: vp }).promise;

        // Convert canvas to blob and trigger download
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (blob) {
            triggerDownload(blob, fileName || `page-${clamped}.png`);
        }
    } catch (err) {
        console.warn(`[PdfViewer] Download page ${clamped} failed:`, err);
    }
}

/**
 * Trigger a browser file download from a Blob.
 * Creates a temporary <a> element with a download attribute,
 * clicks it programmatically, then cleans up.
 *
 * @param {Blob}   blob     - The file data to download
 * @param {string} fileName - Suggested file name
 */
function triggerDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // Clean up after a short delay to ensure the download starts
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

// ── Context menu protection ─────────────────────────────────────────────

/**
 * Block or unblock the browser context menu on the PDF viewer container.
 *
 * When blocked, right-click and long-press (mobile) context menus are
 * suppressed, preventing "Save image", "Share", and similar options that
 * could allow the user to extract the PDF content.
 *
 * Also applies CSS to disable image dragging and text selection within
 * the viewer, which are additional vectors for content extraction.
 *
 * @param {string}  containerId - The container element ID
 * @param {boolean} blocked     - true to block, false to unblock
 */
export function setContextMenuBlocked(containerId, blocked) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const viewer = viewers[containerId];
    if (!viewer) return;

    // Clean up any existing handler first
    if (viewer._contextMenuCleanup) {
        viewer._contextMenuCleanup();
        viewer._contextMenuCleanup = null;
    }

    if (blocked) {
        // Prevent the context menu from appearing
        function onContextMenu(e) {
            e.preventDefault();
            return false;
        }

        // Prevent long-press from triggering callout/share on iOS
        container.style.webkitTouchCallout = 'none';
        // Prevent drag-to-save on images/canvases
        container.style.webkitUserDrag = 'none';
        // Prevent text/image selection as an extraction vector
        container.style.userSelect = 'none';

        container.addEventListener('contextmenu', onContextMenu);

        // Store cleanup so it can be removed when protection is toggled off
        // or the viewer is disposed
        viewer._contextMenuCleanup = () => {
            container.removeEventListener('contextmenu', onContextMenu);
            container.style.webkitTouchCallout = '';
            container.style.webkitUserDrag = '';
            container.style.userSelect = '';
        };
    }
}