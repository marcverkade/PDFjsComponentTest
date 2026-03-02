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
        'display:inline-flex;flex-direction:column;align-items:center;' +
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
            'box-shadow:0 2px 8px rgba(0,0,0,.3);flex-shrink:0';

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
 * Sets up touch event handlers for pinch-to-zoom and double-tap-to-zoom.
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
 */
function setupTouchGestures(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const viewer = viewers[containerId];
    if (!viewer) return;

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
        }
    }

    function onTouchMove(e) {
        if (!isPinching || e.touches.length !== 2) return;
        e.preventDefault();

        // Calculate new scale from finger distance ratio
        const dist = touchDist(e.touches[0], e.touches[1]);
        const target = clamp(pinchStartScale * (dist / pinchStartDist), MIN_SCALE, MAX_SCALE);
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

        const finalScale = clamp(pinchStartScale * cssRatio, MIN_SCALE, MAX_SCALE);

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
        const fit = viewer.baseScale ?? 1.0;

        // Determine if we're already zoomed in significantly
        const zoomedIn = current > fit * 1.3;
        const oldScale = current;
        viewer.pinchScale = zoomedIn
            ? null  // Zoom back to fit
            : clamp(fit * DOUBLE_TAP_ZOOM, MIN_SCALE, MAX_SCALE);  // Zoom in

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

        // Don't process taps immediately after a pinch, or if fingers remain
        if (wasPinching || e.touches.length > 0) return;

        const t = e.changedTouches[0];
        if (!t) return;

        // Filter out long presses and drags (only short, stationary taps count)
        const dt = Date.now() - tapStartTime;
        const dx = Math.abs(t.clientX - tapStartX);
        const dy = Math.abs(t.clientY - tapStartY);

        if (dt > 250 || dx > 15 || dy > 15) {
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
 */
function setupDragPan(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const viewer = viewers[containerId];
    if (!viewer) return;

    let isDragging = false;
    let startX = 0, startY = 0;         // Mouse position at drag start
    let startScrollX = 0, startScrollY = 0;  // Scroll position at drag start

    // Show grab cursor when content overflows
    container.style.cursor = 'grab';

    function onMouseDown(e) {
        // Focus the container so keyboard events (arrow keys) work
        // without requiring the user to tab to it
        container.focus();

        // Only left mouse button, and not when Ctrl is held (that's for zoom)
        if (e.button !== 0 || e.ctrlKey) return;

        // Only pan when content overflows
        const overflowsX = container.scrollWidth > container.clientWidth;
        const overflowsY = container.scrollHeight > container.clientHeight;
        if (!overflowsX && !overflowsY) return;

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startScrollX = container.scrollLeft;
        startScrollY = container.scrollTop;

        container.style.cursor = 'grabbing';
        container.style.userSelect = 'none';  // Prevent text selection during drag

        e.preventDefault();
    }

    function onMouseMove(e) {
        if (!isDragging) return;

        // Calculate how far the mouse moved and scroll inversely
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        container.scrollLeft = startScrollX - dx;
        container.scrollTop = startScrollY - dy;
    }

    function onMouseUp() {
        if (!isDragging) return;
        isDragging = false;
        container.style.cursor = 'grab';
        container.style.userSelect = '';
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
        accumulatedScale = clamp(accumulatedScale * factor, MIN_SCALE, MAX_SCALE);

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
    };
}

/**
 * Initialize the PDF viewer from a URL.
 * @param {object} dotNetRef - DotNetObjectReference for calling back into Blazor.
 * @returns {number} Total number of pages in the PDF.
 */
export async function initialize(containerId, pdfUrl, zoomValue, rotation, displayMode, dotNetRef) {
    await ensurePdfjsLoaded();

    // Dispose any existing viewer for this container
    if (viewers[containerId]) disposePdfViewer(containerId);

    const pdf = await pdfjsLib.getDocument({
        url: pdfUrl,
        cMapUrl: `${PDFJS_CDN}/cmaps/`,
        cMapPacked: true,
    }).promise;

    viewers[containerId] = createViewerState(pdf, zoomValue, rotation, displayMode);
    // Store the .NET reference for JS→Blazor callbacks (e.g. page navigation)
    viewers[containerId]._dotNetRef = dotNetRef ?? null;
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
 * @returns {number} Total number of pages in the PDF.
 */
export async function initializeFromData(containerId, pdfData, zoomValue, rotation, displayMode, dotNetRef) {
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
    // Store the .NET reference for JS→Blazor callbacks (e.g. page navigation)
    viewers[containerId]._dotNetRef = dotNetRef ?? null;
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
 * Sets up arrow-key scrolling so the user can pan the PDF when it
 * overflows the container. The container must be focusable (tabindex)
 * to receive keyboard events.
 *
 * Also handles Ctrl+ArrowLeft/Right to navigate between pages
 * in single-page mode.
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

    function onKeyDown(e) {
        // ── Ctrl+Arrow: page navigation in single-page mode ──
        if (e.ctrlKey && viewer.displayMode === 'single') {
            if (e.key === 'ArrowRight') {
                e.preventDefault();
                navigateToPage(containerId, viewer.currentPage + 1);
                return;
            }
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                navigateToPage(containerId, viewer.currentPage - 1);
                return;
            }
        }

        // ── Plain arrow keys: scroll panning ──
        const overflowsX = container.scrollWidth > container.clientWidth;
        const overflowsY = container.scrollHeight > container.clientHeight;
        if (!overflowsX && !overflowsY) return;

        switch (e.key) {
            case 'ArrowLeft':
                if (overflowsX) container.scrollLeft -= ARROW_SCROLL_PX;
                break;
            case 'ArrowRight':
                if (overflowsX) container.scrollLeft += ARROW_SCROLL_PX;
                break;
            case 'ArrowUp':
                if (overflowsY) container.scrollTop -= ARROW_SCROLL_PX;
                break;
            case 'ArrowDown':
                if (overflowsY) container.scrollTop += ARROW_SCROLL_PX;
                break;
            default:
                return; // Don't preventDefault for non-arrow keys
        }
        e.preventDefault();
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