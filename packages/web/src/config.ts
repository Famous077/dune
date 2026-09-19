/**
 * Repos offered on the connect screen. Both are pre-indexed on the deployed stack, so
 * submitting one returns `alreadyIndexed` and opens the map without a progress screen.
 * The first is the sample the "Load sample codebase" buttons use.
 */
export const SAMPLE_REPOS = [
  { url: 'https://github.com/aashu2006/split-it-wise', name: 'aashu2006/split-it-wise', note: 'Next.js' },
  {
    url: 'https://github.com/gothinkster/node-express-realworld-example-app',
    name: 'gothinkster/node-express-realworld-example-app',
    note: 'Express',
  },
  {
    url: 'https://github.com/nsidnev/fastapi-realworld-example-app',
    name: 'nsidnev/fastapi-realworld-example-app',
    note: 'Python · FastAPI',
  },
] as const;

export const SAMPLE_REPO_URL = SAMPLE_REPOS[0].url;

/** The MCP endpoint, once the service is deployed. Unset hides the MCP section entirely. */
export const MCP_URL: string | null = import.meta.env.VITE_MCP_URL || null;
