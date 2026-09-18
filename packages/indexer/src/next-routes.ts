/**
 * Next.js App Router routes. A Next.js app has no `app.get('/x')` calls to find — it routes
 * by file path — so without this the route table of any Next.js repo is empty, and "where
 * do I change the group page" questions lose their most useful context.
 *
 *   app/page.jsx                         -> /                    (method "page")
 *   app/group/[groupId]/page.jsx         -> /group/[groupId]
 *   app/(marketing)/about/page.tsx       -> /about               route groups drop out
 *   app/api/users/route.ts  export GET   -> GET /api/users       one entry per handler
 *
 * Dynamic segments — `[groupId]`, `[...slug]`, `[[...slug]]` — are kept as written. Private
 * folders (`_components`) are not routable; parallel-route slots (`@modal`) drop out.
 *
 * Detection is gated on a `next.config.*` file: `app/` and `src/app/` beside it are the
 * route roots. That keeps an Express repo's unrelated `app/` directory out of it, and finds
 * each app in a monorepo.
 */

import path from 'node:path';

import type { ParsedFile } from './parse';

const NEXT_CONFIG = /(^|\/)next\.config\.(js|mjs|cjs|ts|mts)$/;
const ROUTE_FILE = /^(page|route)\.(js|jsx|ts|tsx)$/;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function appRoots(allFiles: string[]): string[] {
  const roots: string[] = [];
  for (const file of allFiles) {
    if (!NEXT_CONFIG.test(file)) continue;
    const base = path.posix.dirname(file);
    for (const dir of ['app', 'src/app']) roots.push(base === '.' ? dir : `${base}/${dir}`);
  }
  return roots;
}

/** The URL for a route file's directory segments, or null when it is not routable. */
export function urlPath(segments: string[]): string | null {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith('_')) return null; // private folder
    if (segment.startsWith('(') && segment.endsWith(')')) continue; // route group
    if (segment.startsWith('@')) continue; // parallel-route slot
    parts.push(segment);
  }
  return `/${parts.join('/')}`;
}

/**
 * Adds App Router routes to the parsed files' own route lists, alongside any Express-style
 * registrations already found, so the route table, the file summaries and the graph's
 * `route` kind all pick them up. Returns how many routes it added.
 */
export function addNextRoutes(files: ParsedFile[], allFiles: string[]): number {
  const roots = appRoots(allFiles);
  if (roots.length === 0) return 0;

  let added = 0;
  for (const file of files) {
    const root = roots.find((candidate) => file.path.startsWith(`${candidate}/`));
    if (root === undefined) continue;

    const segments = file.path.slice(root.length + 1).split('/');
    const filename = segments.pop() ?? '';
    const match = ROUTE_FILE.exec(filename);
    if (match === null) continue;

    const url = urlPath(segments);
    if (url === null) continue;

    if (match[1] === 'page') {
      file.routes.push({ method: 'page', path: url, line: 1 });
      added += 1;
      continue;
    }

    // route.ts: one entry per exported HTTP handler, at the handler's own line.
    for (const exported of file.exports) {
      if (!HTTP_METHODS.has(exported.name)) continue;
      const declaration = file.declarations.find((entry) => entry.name === exported.name);
      file.routes.push({ method: exported.name.toLowerCase(), path: url, line: declaration?.startLine ?? 1 });
      added += 1;
    }
  }
  return added;
}
