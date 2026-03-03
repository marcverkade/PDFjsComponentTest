# Blazor PDF Viewer Component

A feature-rich, dependency-free PDF viewer component for Blazor WebAssembly. Built on [PDF.js](https://mozilla.github.io/pdf.js/) (loaded lazily from CDN), it provides a native-app-like PDF viewing experience with touch gestures, keyboard navigation, zoom controls, search, print, download, and content protection — all without server-side dependencies.

![.NET 10](https://img.shields.io/badge/.NET-10-512BD4?logo=dotnet)
![Blazor WASM](https://img.shields.io/badge/Blazor-WebAssembly-512BD4?logo=blazor)
![PDF.js](https://img.shields.io/badge/PDF.js-4.6.82-orange)

---

## Features

- Single page and continuous scroll display modes
- Zoom: pinch-to-zoom, Ctrl+wheel, double-tap, toolbar buttons, programmatic API
- Pan: click-and-drag (mouse), touch scroll, arrow key scrolling
- Touch gestures: pinch-to-zoom, double-tap toggle, swipe page navigation
- Keyboard navigation: arrow keys to scroll/navigate, Ctrl+Arrow for instant page change
- Mouse swipe: drag-at-boundary page navigation in single-page mode
- Text search with highlighted results (case and diacritics insensitive)
- Print support (all pages or page range) at 2x resolution
- Download: full PDF or current page as PNG
- Content protection: disable download and/or print, block context menu and long-press
- Mobile-first: compact toolbar on small screens, responsive layout
- iOS Safari zoom prevention: browser pinch-zoom blocked outside the viewer
- Performance: lazy PDF.js CDN loading, canvas pixel budgets for Safari/iOS, render generation cancellation
- Auto-focus: arrow keys work immediately on page load without clicking

---

## Installation

The component is self-contained. Copy these files into your Blazor WebAssembly project:

    Components/
        PdfViewer.razor            Main component (markup and C# logic)
        PdfViewer.razor.css        Scoped styles (toolbar, mobile layout)
        PdfViewerEnums.cs          PdfZoom, PdfOrientation, PdfDisplayMode enums

    wwwroot/js/
        pdfViewerInterop.js        JavaScript interop (PDF.js, gestures, zoom)

No NuGet packages required. PDF.js is loaded automatically from CDN (jsdelivr.net) on first use.

---

## Quick Start

### Minimal example — load from URL

    <PdfViewer PDFFileName="pdf/sample.pdf"
               ZoomPercentage="PdfZoom.FullWidth"
               Height="80vh" />

Place your PDF file in the server project's wwwroot/pdf/ folder (not the .Client project).

### Load from file upload

    <InputFile OnChange="OnFileSelected" accept=".pdf" />

    @if (pdfBytes is not null)
    {
        <PdfViewer @ref="viewer"
                   PDFData="@pdfBytes"
                   ZoomPercentage="PdfZoom.FullWidth"
                   DisplayMode="PdfDisplayMode.SinglePage"
                   Orientation="PdfOrientation.Portrait"
                   MinZoom="0.1"
                   MaxZoom="5.0"
                   Height="70vh" />
    }

    @code {
        private PdfViewer? viewer;
        private byte[]? pdfBytes;

        private async Task OnFileSelected(InputFileChangeEventArgs e)
        {
            await using var stream = e.File.OpenReadStream(maxAllowedSize: 50 * 1024 * 1024);
            using var ms = new MemoryStream();
            await stream.CopyToAsync(ms);
            pdfBytes = ms.ToArray();
        }
    }

### Full-featured example with programmatic control

    <PdfViewer @ref="viewer"
               PDFFileName="pdf/document.pdf"
               ZoomPercentage="PdfZoom.FullWidth"
               Orientation="PdfOrientation.Portrait"
               DisplayMode="PdfDisplayMode.SinglePage"
               PreventDownload="false"
               PreventPrinting="false"
               MinZoom="0.1"
               MaxZoom="5.0"
               ZoomRate="0.25"
               Width="100%"
               Height="70vh"
               CssClass="my-custom-class" />

    <button @onclick="() => viewer?.ZoomInAsync()">Zoom In</button>
    <button @onclick="() => viewer?.ZoomOutAsync()">Zoom Out</button>
    <button @onclick="() => viewer?.SetZoomAsync(PdfZoom.FullWidth)">Fit Width</button>
    <button @onclick="() => viewer?.PrintAsync()">Print All</button>
    <button @onclick="() => viewer?.PrintAsync(1, 3)">Print Pages 1-3</button>
    <button @onclick="() => viewer?.DownloadAllAsync("my-doc.pdf")">Download PDF</button>
    <button @onclick="() => viewer?.DownloadCurrentPageAsync()">Download Page as PNG</button>
    <button @onclick="() => viewer?.SearchAsync("hello")">Search</button>
    <button @onclick="() => viewer?.SearchAsync(null)">Clear Search</button>

    @code {
        private PdfViewer? viewer;
    }

---

## Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| PDFFileName | string | "" | URL or relative path to a PDF file. Ignored when PDFData is provided. |
| PDFData | byte[]? | null | Raw PDF bytes (e.g. from InputFile). Takes priority over PDFFileName. |
| ZoomPercentage | PdfZoom | Percent100 | Initial zoom level. |
| Orientation | PdfOrientation | Portrait | Display orientation (Portrait or Landscape). |
| DisplayMode | PdfDisplayMode | SinglePage | SinglePage (one page with navigation) or Continuous (all pages in a scroll). |
| Width | string? | "100%" | CSS width of the viewer container (e.g. "800px", "100%"). |
| Height | string? | null | CSS height (e.g. "700px", "80vh"). If unset, grows to fit content up to 100vh. |
| CssClass | string? | null | Additional CSS class(es) for the outer container. |
| MinZoom | double | 0.5 | Minimum zoom level (0.0-10.0). Clamps all zoom methods and gestures. |
| MaxZoom | double | 4.0 | Maximum zoom level (0.0-10.0). Clamps all zoom methods and gestures. |
| ZoomRate | double | 0.25 | Default step size for ZoomInAsync() / ZoomOutAsync() without arguments. |
| PreventDownload | bool | false | Blocks download API, context menu, long-press, and image dragging. |
| PreventPrinting | bool | false | Blocks print API methods. |

### Enum: PdfZoom

| Value | Scale | Description |
|---|---|---|
| Percent25 | 0.25 | 25% zoom |
| Percent50 | 0.50 | 50% zoom |
| Percent100 | 1.00 | 100% zoom (actual size) |
| Percent150 | 1.50 | 150% zoom |
| Percent200 | 2.00 | 200% zoom |
| FullPage | auto | Fit entire page within container |
| FullWidth | auto | Fit page width to container |

### Enum: PdfOrientation

| Value | Rotation | Description |
|---|---|---|
| Portrait | 0 degrees | Normal orientation |
| Landscape | 90 degrees | Rotated 90 degrees clockwise |

### Enum: PdfDisplayMode

| Value | Description |
|---|---|
| SinglePage | Shows one page at a time with navigation buttons |
| Continuous | Renders all pages in a vertical scroll |

---

## Public Methods

Access these via @ref on the component.

| Method | Description |
|---|---|
| ZoomInAsync() | Zoom in by the configured ZoomRate (default 25%). |
| ZoomInAsync(decimal amount) | Zoom in by a custom amount. |
| ZoomOutAsync() | Zoom out by the configured ZoomRate. |
| ZoomOutAsync(decimal amount) | Zoom out by a custom amount. |
| SetZoomAsync(PdfZoom zoom) | Reset zoom to a specific level, clearing pinch/wheel overrides. |
| PrintAsync() | Print all pages. Blocked when PreventPrinting is true. |
| PrintAsync(int start, int end) | Print a page range (1-based, inclusive). |
| SearchAsync(string? text) | Search and highlight text. Pass null or empty to clear highlights. |
| DownloadAllAsync(string? name) | Download the full PDF. Blocked when PreventDownload is true. |
| DownloadCurrentPageAsync(string? name) | Download current page as PNG. Blocked when PreventDownload is true. |

### Public Properties

| Property | Type | Description |
|---|---|---|
| CurrentScale | double? | Current effective zoom ratio (e.g. 1.25 = 125%). Null until first render. |

---

## Touch Gestures (Mobile / Tablet)

| Gesture | Action |
|---|---|
| Pinch (two fingers) | Zoom in/out with GPU-accelerated visual feedback. Focal point stays under fingers. |
| Double-tap | Toggle between fit-to-width and 2.5x zoom. Centers on the tap point. |
| Single-finger drag | Pan/scroll when content is zoomed and overflows. |
| Swipe left at right edge | Navigate to next page (single-page mode). |
| Swipe right at left edge | Navigate to previous page (single-page mode). |
| Swipe when content fits | Navigate pages directly (no boundary needed). |

Swipe navigation only triggers when the swipe started at the scroll boundary. Panning to the edge and continuing does not accidentally navigate.

---

## Mouse Interactions (Desktop)

| Action | Result |
|---|---|
| Click and drag | Pan/scroll the PDF when content overflows. Cursor shows grab / grabbing. |
| Ctrl + mouse wheel | Zoom in/out with focal point under cursor. Exponential scaling for smooth feel. |
| Drag-swipe left at right edge | Navigate to next page (single-page mode, fast horizontal drag). |
| Drag-swipe right at left edge | Navigate to previous page. |
| Drag-swipe when content fits | Navigate pages directly. |
| Click on viewer | Focus the viewer for keyboard navigation. |

Ctrl+wheel zoom uses CSS transforms during the gesture for 60fps visual feedback, then commits a full-resolution re-render when scrolling stops.

---

## Keyboard Navigation

| Key | Action |
|---|---|
| Left / Right arrow | Scroll horizontally when zoomed. Navigate pages when content fits. |
| Up / Down arrow | Scroll vertically when content overflows the viewer height. |
| Ctrl + Left arrow | Go to previous page (instant, single-page mode). |
| Ctrl + Right arrow | Go to next page (instant, single-page mode). |
| Arrow at boundary (1st press) | Absorbed — prevents accidental page turn while scrolling. |
| Arrow at boundary (2nd press) | Navigates to next/previous page. |

The viewer auto-focuses on load so arrow keys work immediately. All toolbar buttons use tabindex="-1" so Tab never steals focus from the viewer.

---

## Built-in Toolbar

The component includes an integrated toolbar that adapts to the display mode.

### Single-page mode

    [first] [prev]  [ 3 ] / 12  [next] [last]  |  [-] Zoom: 125% [+]  |  Portrait  |  Single

- First / Last page buttons (skip to start/end icons)
- Previous / Next page buttons (triangle icons)
- Editable page number input — type a number and press Enter to jump directly
- Zoom out (-) and zoom in (+) buttons (25% per click)
- Current zoom percentage (updates live on pinch/wheel/programmatic changes)
- Current orientation label
- Current display mode label
- Lock icon with "Protected" when PreventDownload or PreventPrinting is active

### Continuous mode

    12 page(s)  |  [-] Zoom: 100% [+]  |  Portrait  |  Continuous

### Mobile layout (below 768px)

The toolbar shrinks automatically with smaller fonts, reduced padding and gaps. Orientation and display mode labels are hidden. Zoom buttons and page navigation remain fully functional.

---

## Content Protection

| Parameter | Effect |
|---|---|
| PreventDownload = true | DownloadAllAsync and DownloadCurrentPageAsync silently return. Right-click context menu blocked. Long-press menu blocked on iOS/Android. Image dragging and text selection disabled on the viewer. |
| PreventPrinting = true | PrintAsync silently returns. |
| Both true | PDF is view-only — no saving, downloading, or printing. Toolbar shows a lock icon with "Protected" indicator. |

**Note:** Client-side protection is a deterrent, not absolute security. A determined user with dev tools can still access the PDF data. For true document security, use server-side DRM or watermarking.

---

## iOS Safari Zoom Prevention

iOS Safari ignores the viewport meta tag's user-scalable=no since iOS 10. This project includes a multi-layered approach to prevent the browser itself from zooming while still allowing pinch-to-zoom inside the PDF viewer.

| Layer | What it blocks | iOS Safari |
|---|---|---|
| Viewport meta tag | Browser zoom on Android Chrome | Ignored since iOS 10 |
| CSS touch-action: pan-x pan-y on html/body | Multi-touch zoom gestures | Works |
| JS touchmove handler | Pinch-to-zoom outside PDF viewer | Works |
| JS gesturestart/gesturechange handlers | Safari-specific zoom gesture | Works |
| JS touchend handler | Double-tap-to-zoom outside PDF viewer | Works |
| CSS overscroll-behavior: none | iOS bounce/rubber-band scroll | Works |

All JS handlers check if the touch originated inside the PDF viewer's scroll container (css class: pdf-viewer-pages). If it did, the event passes through to the component's own gesture handlers. Everything outside gets blocked.

The script is placed in App.razor before the closing body tag. The CSS rules are in wwwroot/app.css on the html, body selector.

---

## Responsive Design

The component is fully responsive.

| Viewport | Behavior |
|---|---|
| Desktop (768px and above) | Full toolbar with all labels, standard button sizes |
| Mobile (below 768px) | Compact toolbar: smaller fonts (0.75rem), reduced padding, hidden orientation/display labels, smaller nav buttons |

The demo page (PDF.razor) hides desktop-only controls on mobile:

**Hidden on mobile:** File picker, orientation select, zoom presets, display mode select, print/download buttons, protection toggles, zoom step controls.

**Visible on mobile:** Compact search bar, full PdfViewer with toolbar (navigation and zoom), all touch gestures (pinch, swipe, double-tap).

---

## Technical Details

### PDF.js Integration

- Version: 4.6.82 (loaded from jsDelivr CDN)
- Loading: Lazy ESM import — PDF.js is only downloaded when the first PDF is loaded
- Worker: Separate web worker for parsing (also from CDN)
- CMap: Character maps loaded from CDN for CJK font support

### Rendering Pipeline

1. Pages rendered to canvas elements in a detached DOM fragment
2. Atomic DOM swap — old content replaced in one step (no flash)
3. Render generation counter — stale renders are automatically cancelled
4. Device pixel ratio aware — sharp rendering on Retina/HiDPI displays

### Memory Safety (iOS Safari)

iOS Safari enforces hard limits on canvas memory (approximately 256 MB). The viewer enforces:

| Budget | Limit | Purpose |
|---|---|---|
| Per-canvas pixels | 8 MP | Prevents single-page crash on high zoom |
| Total pixels (continuous) | 50 MP (approx 200 MB) | Prevents multi-page memory exhaustion |
| DPR scaling | Automatic | Reduces backing-store resolution when budget would be exceeded |

### Zoom Architecture

| Phase | Technique | Purpose |
|---|---|---|
| During gesture | CSS transform: scale() | 60fps GPU-composited feedback, no re-render |
| After gesture | Full canvas re-render | Sharp content at final resolution |
| Scroll restore | Page-relative focal point | Content under cursor/finger stays fixed |

### Focal Point Scroll

After every zoom re-render, the scroll position is restored so the point under the cursor (or finger midpoint) stays in the same viewport position. This uses page-relative coordinates that survive the DOM swap, independent of wrapper centering offsets.

---

## Project Structure

    PDFjsComponentTest/
        PDFjsComponentTest/                       Server project (ASP.NET Core host)
            wwwroot/pdf/                           Static PDF files served from here
            wwwroot/app.css                        Global styles + iOS zoom prevention CSS
            Components/App.razor                   Root HTML + iOS zoom prevention script
            Components/Layout/                     MainLayout, NavMenu

        PDFjsComponentTest.Client/                 Blazor WebAssembly client
            Components/
                PdfViewer.razor                    Main component (markup + C# logic)
                PdfViewer.razor.css                Scoped styles + mobile responsive
                PdfViewerEnums.cs                  PdfZoom, PdfOrientation, PdfDisplayMode
            Pages/
                PDF.razor                          Demo page with all controls
            wwwroot/js/
                pdfViewerInterop.js                JS interop module
                    PDF.js bootstrap               Lazy CDN loading
                    Page rendering                 Canvas render + atomic DOM swap
                    Touch gestures                 Pinch, double-tap, swipe
                    Click-and-drag pan             Mouse drag + swipe-at-boundary
                    Ctrl+wheel zoom                Exponential zoom + CSS transform
                    Arrow-key panning              Two-press boundary gate
                    Text search                    Diacritics-insensitive highlighting
                    Print                          Hidden iframe, 2x resolution
                    Download                       Blob + anchor download trigger
                    Context menu protection        Block right-click and long-press

---

## Contributing

1. Fork the repository
2. Create a feature branch (git checkout -b feature/amazing-feature)
3. Commit your changes (git commit -m "Add amazing feature")
4. Push to the branch (git push origin feature/amazing-feature)
5. Open a Pull Request

---

## Acknowledgments

- [PDF.js](https://mozilla.github.io/pdf.js/) by Mozilla — the rendering engine
- [jsDelivr](https://www.jsdelivr.com/) — CDN hosting for PDF.js