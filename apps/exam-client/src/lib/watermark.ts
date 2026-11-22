const escapeXml = (s: string) =>
    s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function watermarkTile(text: string): string {
    const w = Math.round(text.length * 8.2 + 160);
    const h = 152;
    const line = (x: number, y: number) =>
        `<text x="${x}" y="${y}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="13" fill="#232323">${escapeXml(text)}</text>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${line(0, 40)}${line(-w / 2, 116)}${line(w / 2, 116)}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
