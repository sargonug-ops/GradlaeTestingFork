interface PositionedItem {
    text: string;
    x: number;
    y: number;
}

export async function extractPdfTextInBrowser(file: File): Promise<string> {
    const pdfjs = await import('pdfjs-dist');

    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;
    const pages: string[] = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items
            .map((item) => ('str' in item ? item.str : ''))
            .join('\n');
        pages.push(text);
    }

    return pages.join('\n');
}

// Reconstruct visual rows from positioned text fragments: group items by
// their y coordinate, then order each row left-to-right by x.
function positionedItemsToText(items: PositionedItem[]): string {
    const sorted = [...items].sort((a, b) => {
        const yDelta = b.y - a.y;
        return Math.abs(yDelta) > 2 ? yDelta : a.x - b.x;
    });

    const rows: Array<{ y: number; items: PositionedItem[] }> = [];
    const rowTolerance = 3;

    for (const item of sorted) {
        const row = rows.find(existing => Math.abs(existing.y - item.y) <= rowTolerance);
        if (row) {
            row.items.push(item);
            row.y = (row.y + item.y) / 2;
        } else {
            rows.push({ y: item.y, items: [item] });
        }
    }

    return rows
        .sort((a, b) => b.y - a.y)
        .map(row => row.items
            .sort((a, b) => a.x - b.x)
            .map(item => item.text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim())
        .filter(Boolean)
        .join('\n');
}

// UAccess transcripts (and many other academic PDFs) place two terms side by
// side in separate columns. Reading such a page as a single set of y-rows
// merges the left and right column into one line, which hides every course in
// the right column from the row-based parser. When a page clearly has content
// on both halves, split it at the page midpoint and read each column on its
// own so no course rows are lost. Single-column pages fall through unchanged.
function splitIntoColumns(items: PositionedItem[], pageWidth: number): PositionedItem[][] {
    if (items.length === 0 || !Number.isFinite(pageWidth) || pageWidth <= 0) {
        return [items];
    }

    const midX = pageWidth / 2;
    const left = items.filter(item => item.x < midX);
    const right = items.filter(item => item.x >= midX);
    const threshold = items.length * 0.2;

    if (left.length >= threshold && right.length >= threshold) {
        return [left, right];
    }

    return [items];
}

export async function extractPdfTextWithLayoutInBrowser(file: File): Promise<string> {
    const pdfjs = await import('pdfjs-dist');

    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;
    const pages: string[] = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const positionedItems: PositionedItem[] = content.items.flatMap((item) => {
            if (!('str' in item) || !item.str.trim()) return [];
            const transform = 'transform' in item && Array.isArray(item.transform)
                ? item.transform
                : [1, 0, 0, 1, 0, 0];

            return [{
                text: item.str.trim(),
                x: Number(transform[4]) || 0,
                y: Number(transform[5]) || 0,
            }];
        });

        const columns = splitIntoColumns(positionedItems, viewport.width);
        const pageText = columns
            .map(column => positionedItemsToText(column))
            .filter(Boolean)
            .join('\n');

        pages.push(`--- PAGE ${pageNumber} ---\n${pageText}`);
    }

    return pages.join('\n');
}
