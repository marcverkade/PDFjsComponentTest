let pdfjsLib = null;
const viewers = {};

const PDFJS_VERSION = '4.6.82';
const PDFJS_CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;

async function ensurePdfjsLoaded() {
    if (pdfjsLib) return;
    pdfjsLib = await import(`${PDFJS_CDN}/build/pdf.min.mjs`);
    pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/build/pdf.worker.min.mjs`;
}

function computeScale(page, zoomValue, container, rotation) {
    if (typeof zoomValue === 'number') {
        return zoomValue;
    }

    const viewport = page.getViewport({ scale: 1.0, rotation });
    const availableWidth = container.clientWidth - 24;
    const availableHeight = container.clientHeight - 24;

    if (zoomValue === 'page-width') {
        return availableWidth / viewport.width;
    }
    if (zoomValue === 'page-fit') {
        return Math.min(
            availableWidth / viewport.width,
            availableHeight / viewport.height
        );
    }

    return 1.0;
}

async function renderAllPages(containerId) {
    const viewer = viewers[containerId];
    if (!viewer) return;

    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '';
    const { pdf, zoomValue, rotation } = viewer;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const scale = computeScale(page, zoomValue, container, rotation);
        const viewport = page.getViewport({ scale, rotation });

        const pageDiv = document.createElement('div');
        pageDiv.className = 'pdf-page';
        pageDiv.style.width = `${viewport.width}px`;
        pageDiv.style.height = `${viewport.height}px`;
        pageDiv.style.background = '#fff';
        pageDiv.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
        pageDiv.style.flexShrink = '0';

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        context.scale(dpr, dpr);

        pageDiv.appendChild(canvas);
        container.appendChild(pageDiv);

        await page.render({ canvasContext: context, viewport }).promise;
    }
}

function base64ToUint8Array(base64) {
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
        bytes[i] = raw.charCodeAt(i);
    }
    return bytes;
}

export async function initialize(containerId, pdfUrl, zoomValue, rotation) {
    await ensurePdfjsLoaded();

    if (viewers[containerId]) {
        disposePdfViewer(containerId);
    }

    const pdf = await pdfjsLib.getDocument({
        url: pdfUrl,
        cMapUrl: `${PDFJS_CDN}/cmaps/`,
        cMapPacked: true
    }).promise;

    viewers[containerId] = { pdf, zoomValue, rotation };
    await renderAllPages(containerId);
    return pdf.numPages;
}

export async function initializeFromData(containerId, pdfData, zoomValue, rotation) {
    await ensurePdfjsLoaded();

    if (viewers[containerId]) {
        disposePdfViewer(containerId);
    }

    // Blazor IJSRuntime sends byte[] as a base64-encoded string via JSON serialization.
    // pdf.js needs a Uint8Array, so decode it first.
    const data = typeof pdfData === 'string'
        ? base64ToUint8Array(pdfData)
        : new Uint8Array(pdfData);

    const pdf = await pdfjsLib.getDocument({
        data: data,
        cMapUrl: `${PDFJS_CDN}/cmaps/`,
        cMapPacked: true
    }).promise;

    viewers[containerId] = { pdf, zoomValue, rotation };
    await renderAllPages(containerId);
    return pdf.numPages;
}

export async function updateView(containerId, zoomValue, rotation) {
    const viewer = viewers[containerId];
    if (!viewer) return;

    viewer.zoomValue = zoomValue;
    viewer.rotation = rotation;
    await renderAllPages(containerId);
}

export function disposePdfViewer(containerId) {
    const viewer = viewers[containerId];
    if (viewer) {
        viewer.pdf.destroy();
        delete viewers[containerId];
    }

    const container = document.getElementById(containerId);
    if (container) {
        container.innerHTML = '';
    }
}