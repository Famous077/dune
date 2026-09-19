/**
 * Python extraction, the counterpart to the TypeScript pass in `parse.ts`. Same output
 * shape, because everything downstream — chunking, the graph, retrieval — only knows
 * `ParsedFile`.
 *
 * Three things differ from TypeScript and are the whole of this file:
 *
 *   - **Imports resolve through the package tree, not the file system alone.** `a.b.c` can be
 *     `a/b/c.py` or `a/b/c/__init__.py`, and the package root is often a subdirectory, so
 *     each ancestor of the importing file is tried as a root. Relative imports count their
 *     leading dots: one dot is the current package, two is the parent.
 *   - **There are no exports.** Module-level definitions are the public surface, unless the
 *     module declares `__all__`, which is then authoritative.
 *   - **Routes are decorators**, not calls: Flask's `@app.route("/x", methods=["POST"])` and
 *     `@bp.route`, FastAPI's `@app.get("/x")` and `@router.post("/x")`. A router or blueprint
 *     created with a prefix carries it, so the recorded path is the one a request uses.
 */

import path from 'node:path';

import type { Node as SyntaxNode } from 'web-tree-sitter';

import type { ParsedFile } from './parse';

/**
 * A router or blueprint mounted into another one, with the prefix it was mounted under:
 * FastAPI's `router.include_router(articles.router, prefix="/articles")` and Flask's
 * `app.register_blueprint(auth_bp, url_prefix="/auth")`. Both put the prefix at the mount
 * site, in a different file from the routes, so paths are only correct once every file is
 * parsed — see `applyRoutePrefixes`.
 */
export interface RouterMount {
  /** The object doing the mounting: `router` in `router.include_router(...)`. */
  receiver: string;
  /** What is being mounted: `{base: "articles", attribute: "router"}`, or a bare name. */
  base: string;
  attribute: string | null;
  prefix: string;
}

/**
 * What the prefix pass needs and `ParsedFile` has no room for: which object each route was
 * decorated on, where each imported name came from, and every mount.
 */
interface PythonFacts {
  /** One entry per route in `parsed.routes`, in the same order: the decorator's object. */
  routeObjects: string[];
  /** Bound name -> where it is defined: `{bp as auth_bp}` -> `{file, original: "bp"}`. */
  importOrigins: Map<string, { file: string; original: string }>;
  mounts: RouterMount[];
}

const factsByFile = new WeakMap<ParsedFile, PythonFacts>();

/** Decorator names that register a route, on any object: app, router, bp, api, v1. */
const ROUTE_DECORATORS = new Set(['route', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** Calls that create something routes hang off, with the prefix keyword each one uses. */
const ROUTER_FACTORIES: Record<string, string> = { APIRouter: 'prefix', Blueprint: 'url_prefix' };

/** Calls that mount one of those under a prefix, and the keyword each one names it with. */
const MOUNT_CALLS: Record<string, string> = { include_router: 'prefix', register_blueprint: 'url_prefix' };

const MAX_CALLEE_LENGTH = 120;

function line(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

function namedChildrenOf(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child): child is SyntaxNode => child !== null);
}

/** Python string literals, including f-strings and the prefixed forms: r"", b'', u"". */
function stringValue(node: SyntaxNode | undefined): string | null {
  if (node === undefined || node.type !== 'string') return null;
  const content = namedChildrenOf(node).find((child) => child.type === 'string_content');
  if (content !== undefined) return content.text;
  return node.text.replace(/^[a-zA-Z]*['"]{1,3}|['"]{1,3}$/g, '');
}

/* ── Import resolution ──────────────────────────────────────────────────────── */

export interface PythonResolver {
  /** `a.b.c` or `.mod` / `..pkg.mod`, relative to the importing file. Null when external. */
  resolve(fromPath: string, specifier: string): string | null;
}

export function createPythonResolver(files: string[]): PythonResolver {
  const fileSet = new Set(files);

  const asModule = (base: string): string | null => {
    const normalised = path.posix.normalize(base);
    if (normalised.startsWith('..')) return null;
    for (const candidate of [`${normalised}.py`, `${normalised}/__init__.py`]) {
      if (fileSet.has(candidate)) return candidate;
    }
    return null;
  };

  return {
    resolve(fromPath, specifier) {
      const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;

      if (dots > 0) {
        // One dot is the package holding this file, each extra dot goes up one more.
        const rest = specifier.slice(dots).split('.').filter(Boolean);
        const parts = path.posix.dirname(fromPath).split('/').filter((part) => part !== '.');
        const up = parts.slice(0, Math.max(0, parts.length - (dots - 1)));
        if (up.length === 0 && dots > 1) return null;
        return asModule([...up, ...rest].join('/'));
      }

      const parts = specifier.split('.').filter(Boolean);
      if (parts.length === 0) return null;

      // The package root is often a subdirectory (app/, src/, backend/), so try the repo
      // root and every ancestor of the importing file, nearest first.
      const ancestors = path.posix.dirname(fromPath).split('/').filter((part) => part !== '.');
      const roots: string[] = [];
      for (let depth = ancestors.length; depth >= 0; depth--) roots.push(ancestors.slice(0, depth).join('/'));

      for (const root of roots) {
        const resolved = asModule([root, ...parts].filter(Boolean).join('/'));
        if (resolved !== null && resolved !== fromPath) return resolved;
      }
      // Not in the repo: the standard library or an installed package.
      return null;
    },
  };
}

/* ── Extraction ─────────────────────────────────────────────────────────────── */

/** `from x import y` binds y; `import a.b as c` binds c; `import a.b` binds a. */
function importedName(node: SyntaxNode): string | null {
  if (node.type === 'aliased_import') return node.childForFieldName('alias')?.text ?? null;
  if (node.type === 'dotted_name') return node.text.split('.')[0] ?? null;
  if (node.type === 'identifier') return node.text;
  return null;
}

function moduleNameOf(node: SyntaxNode): string | null {
  if (node.type === 'dotted_name') return node.text;
  if (node.type === 'relative_import') {
    const prefix = namedChildrenOf(node).find((child) => child.type === 'import_prefix')?.text ?? '';
    const dotted = namedChildrenOf(node).find((child) => child.type === 'dotted_name')?.text ?? '';
    return `${prefix}${dotted}`;
  }
  return null;
}

export function extractPython(filePath: string, source: string, root: SyntaxNode, resolver: PythonResolver): ParsedFile {
  const parsed: ParsedFile = {
    path: filePath,
    language: 'py',
    lineCount: source.split('\n').length,
    imports: [],
    exports: [],
    declarations: [],
    calls: [],
    routes: [],
  };

  const addImport = (specifier: string, names: string[]): string | null => {
    const resolved = resolver.resolve(filePath, specifier);
    parsed.imports.push({ specifier, resolved, names });
    return resolved;
  };

  /** Router and blueprint variables that carry a path prefix, so routes read as requests do. */
  const prefixes = new Map<string, string>();
  /** Names `__all__` lists, when the module declares one. */
  const declaredAll: string[] = [];
  let hasAll = false;
  const topLevelNames: { name: string; isDefault: boolean }[] = [];

  const routePrefix = (object: string): string => prefixes.get(object) ?? '';

  const addRoute = (decorator: SyntaxNode, object: string, method: string, routePath: string, methods: string[]): void => {
    // Left as written; the mount prefix and the final tidy-up happen in applyRoutePrefixes.
    const full = `${routePrefix(object)}${routePath}`;
    const list = methods.length > 0 ? methods : [method];
    for (const verb of list) {
      parsed.routes.push({ method: verb.toLowerCase(), path: full, line: line(decorator) });
      routeObjects.push(object);
    }
  };

  const mounts: RouterMount[] = [];
  const routeObjects: string[] = [];
  const importOrigins = new Map<string, { file: string; original: string }>();

  /** `router.include_router(x.router, prefix=...)`, `app.register_blueprint(bp, url_prefix=...)`. */
  const readInclude = (call: SyntaxNode, keyword: string): void => {
    const args = call.childForFieldName('arguments');
    if (args === null) return;
    const positional = namedChildrenOf(args);
    const first = positional[0];
    if (first === undefined) return;
    // `articles.router`: the module and the object on it. A bare `auth_bp` is the object.
    const base = first.type === 'attribute' ? first.childForFieldName('object')?.text ?? '' : first.text;
    const attribute = first.type === 'attribute' ? first.childForFieldName('attribute')?.text ?? null : null;
    if (base === '') return;
    const receiver = call.childForFieldName('function')?.childForFieldName('object')?.text ?? '';

    let prefix = '';
    for (const arg of positional) {
      if (arg.type !== 'keyword_argument' || arg.childForFieldName('name')?.text !== keyword) continue;
      // A prefix from a settings object cannot be read statically; the rest still helps.
      prefix = stringValue(arg.childForFieldName('value') ?? undefined) ?? '';
    }
    mounts.push({ receiver, base, attribute, prefix: prefix.replace(/\/$/, '') });
  };

  /** `@app.route("/x", methods=["GET", "POST"])`, `@router.post("/x")`. */
  const readDecorator = (decorator: SyntaxNode): void => {
    const call = namedChildrenOf(decorator).find((child) => child.type === 'call');
    const target = call === undefined ? undefined : call.childForFieldName('function');
    if (call === undefined || target === undefined || target === null || target.type !== 'attribute') return;

    const object = target.childForFieldName('object')?.text ?? '';
    const attribute = target.childForFieldName('attribute')?.text ?? '';
    if (!ROUTE_DECORATORS.has(attribute)) return;

    const args = call.childForFieldName('arguments');
    if (args === null) return;
    const positional = namedChildrenOf(args);
    const routePath = stringValue(positional.find((arg) => arg.type === 'string'));
    // Every route decorator takes the path first. FastAPI writes the collection endpoint as
    // `@router.get("")`, so an empty path is real and the mount prefix completes it. Anything
    // that is not a path at all belongs to a different decorator.
    if (routePath === null || (routePath !== '' && !routePath.startsWith('/'))) return;

    const methods: string[] = [];
    for (const arg of positional) {
      if (arg.type !== 'keyword_argument') continue;
      if (arg.childForFieldName('name')?.text !== 'methods') continue;
      const value = arg.childForFieldName('value');
      if (value === null) continue;
      for (const item of namedChildrenOf(value)) {
        const verb = stringValue(item);
        if (verb !== null) methods.push(verb);
      }
    }

    // Flask's @route defaults to GET; FastAPI's decorator is named for its method.
    addRoute(decorator, object, attribute === 'route' ? 'get' : attribute, routePath, methods);
  };

  const addDeclaration = (node: SyntaxNode, kind: string, name: string | null): void => {
    if (name === null) return;
    parsed.declarations.push({ name, kind, startLine: line(node), endLine: node.endPosition.row + 1 });
  };

  const visit = (node: SyntaxNode, depth: number): void => {
    // Module level is depth 0; a class body is depth 1. Deeper definitions are local.
    const topLevel = depth === 0;
    let childDepth = depth;

    switch (node.type) {
      case 'import_statement': {
        for (const child of namedChildrenOf(node)) {
          const module = child.type === 'aliased_import' ? moduleNameOf(child.childForFieldName('name') ?? child) : moduleNameOf(child);
          const bound = importedName(child);
          if (module !== null) addImport(module, bound === null ? [] : [bound]);
        }
        break;
      }

      case 'import_from_statement': {
        const moduleNode = node.childForFieldName('module_name');
        const module = moduleNode === null ? null : moduleNameOf(moduleNode);
        if (module === null) break;

        // `from x import a as b` binds b, and b is the name the rest of the file uses; the
        // original a is what names the submodule file. Both matter, so both are kept.
        const imported: { original: string; bound: string }[] = [];
        for (const child of namedChildrenOf(node)) {
          // Node wrappers are recreated on each access, so nodes compare by id, not identity.
          if (child.id === moduleNode?.id || child.type === 'wildcard_import') continue;
          if (child.type === 'aliased_import') {
            const original = child.childForFieldName('name')?.text ?? null;
            const bound = child.childForFieldName('alias')?.text ?? original;
            if (original !== null && bound !== null) imported.push({ original, bound });
          } else {
            const name = importedName(child);
            if (name !== null) imported.push({ original: name, bound: name });
          }
        }

        const base = addImport(module, imported.map((entry) => entry.bound));
        for (const entry of imported) {
          // Where a name came from, so a blueprint decorated in one file and mounted in
          // another can be recognised as the same object.
          const home = resolver.resolve(filePath, `${module}${module.endsWith('.') ? '' : '.'}${entry.original}`) ?? base;
          if (home !== null) importOrigins.set(entry.bound, { file: home, original: entry.original });
        }
        // `from package import module` names a file, not a symbol: add those edges too.
        for (const entry of imported) {
          const sub = `${module}${module.endsWith('.') ? '' : '.'}${entry.original}`;
          const resolved = resolver.resolve(filePath, sub);
          if (resolved !== null && resolved !== base) {
            parsed.imports.push({ specifier: sub, resolved, names: [entry.bound] });
          }
        }
        break;
      }

      case 'decorated_definition': {
        for (const child of namedChildrenOf(node)) {
          if (child.type === 'decorator') readDecorator(child);
        }
        const definition = node.childForFieldName('definition');
        if (topLevel && definition !== null) {
          // The decorator lines belong to the declaration: a route is read from them.
          const kind = definition.type === 'class_definition' ? 'class' : 'function';
          const name = definition.childForFieldName('name')?.text ?? null;
          addDeclaration(node, kind, name);
          if (name !== null) topLevelNames.push({ name, isDefault: false });
          childDepth = depth + 1;
        }
        break;
      }

      case 'function_definition':
      case 'class_definition': {
        if (topLevel) {
          const kind = node.type === 'class_definition' ? 'class' : 'function';
          const name = node.childForFieldName('name')?.text ?? null;
          addDeclaration(node, kind, name);
          if (name !== null) topLevelNames.push({ name, isDefault: false });
        }
        childDepth = depth + 1;
        break;
      }

      case 'assignment': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        const name = left?.type === 'identifier' ? left.text : null;

        if (name === '__all__' && right !== null) {
          hasAll = true;
          for (const item of namedChildrenOf(right)) {
            const value = stringValue(item);
            if (value !== null) declaredAll.push(value);
          }
        } else if (topLevel && name !== null) {
          topLevelNames.push({ name, isDefault: false });
        }

        // router = APIRouter(prefix="/items"), bp = Blueprint("x", __name__, url_prefix="/x")
        if (name !== null && right !== null && right.type === 'call') {
          const factory = right.childForFieldName('function')?.text ?? '';
          const keyword = ROUTER_FACTORIES[factory.split('.').pop() ?? ''];
          const args = right.childForFieldName('arguments');
          if (keyword !== undefined && args !== null) {
            for (const arg of namedChildrenOf(args)) {
              if (arg.type !== 'keyword_argument' || arg.childForFieldName('name')?.text !== keyword) continue;
              const value = stringValue(arg.childForFieldName('value') ?? undefined);
              if (value !== null) prefixes.set(name, value.replace(/\/$/, ''));
            }
          }
        }
        break;
      }

      case 'call': {
        const callee = node.childForFieldName('function');
        if (callee !== null) {
          parsed.calls.push({ callee: callee.text.slice(0, MAX_CALLEE_LENGTH), line: line(node) });
          const mount = callee.type === 'attribute' ? MOUNT_CALLS[callee.childForFieldName('attribute')?.text ?? ''] : undefined;
          if (mount !== undefined) readInclude(node, mount);
        }
        break;
      }

      default:
        break;
    }

    for (const child of namedChildrenOf(node)) visit(child, childDepth);
  };

  visit(root, 0);

  // `__all__` is the module saying what it exports; otherwise every public top-level name is.
  factsByFile.set(parsed, { routeObjects, importOrigins, mounts });

  parsed.exports = hasAll
    ? declaredAll.map((name) => ({ name, isDefault: false }))
    : topLevelNames.filter((entry) => !entry.name.startsWith('_'));

  return parsed;
}

/**
 * Applies mount prefixes across files, once everything is parsed.
 *
 * The thing a prefix belongs to is a router or blueprint *object*, not a file: Flask's
 * `bp` is created in `app/auth/__init__.py`, decorated with routes in `app/auth/routes.py`
 * and registered under `/auth` in `app/__init__.py`. So each object gets an identity of
 * "the file that defines it, and its name there", names are followed back through imports
 * to that identity, and prefixes accumulate along the mount chain: an app mounts a router
 * under `/api`, which mounts another under `/articles`.
 *
 * A prefix given as a variable (`prefix=settings.api_prefix`) cannot be read from the
 * source, so that link contributes nothing and the path comes out one segment short rather
 * than wrong.
 */
export function applyRoutePrefixes(files: ParsedFile[]): void {
  const python = files.filter((file) => file.language === 'py');
  if (python.length === 0) return;

  const factsFor = (file: ParsedFile): PythonFacts =>
    factsByFile.get(file) ?? { routeObjects: [], importOrigins: new Map(), mounts: [] };
  const byPath = new Map(python.map((file) => [file.path, file]));

  /** `file#name`, following imports back to where the object is defined. */
  const identify = (filePath: string, name: string): string => {
    let currentFile = filePath;
    let currentName = name;
    for (let hop = 0; hop < 5; hop++) {
      const file = byPath.get(currentFile);
      const origin = file === undefined ? undefined : factsFor(file).importOrigins.get(currentName);
      // An import of the module itself, not of a name inside it, ends the chain.
      if (origin === undefined || origin.file === currentFile) break;
      currentFile = origin.file;
      currentName = origin.original;
    }
    return `${currentFile}#${currentName}`;
  };

  /** `x.router` mounted in this file: the module x resolves to a file, and router lives there. */
  const identifyMount = (file: ParsedFile, mount: RouterMount): string | null => {
    if (mount.attribute === null) return identify(file.path, mount.base);
    const candidates = file.imports.filter((entry) => entry.resolved !== null && entry.names.includes(mount.base));
    const match =
      candidates.find((entry) => entry.names.length === 1 && entry.names[0] === mount.base) ?? candidates[0];
    if (match?.resolved === undefined || match.resolved === null) return null;
    return `${match.resolved}#${mount.attribute}`;
  };

  const children = new Map<string, { key: string; prefix: string }[]>();
  const mounted = new Set<string>();
  for (const file of python) {
    for (const mount of factsFor(file).mounts) {
      const target = identifyMount(file, mount);
      if (target === null) continue;
      const parent = identify(file.path, mount.receiver);
      const edges = children.get(parent) ?? [];
      edges.push({ key: target, prefix: mount.prefix });
      children.set(parent, edges);
      mounted.add(target);
    }
  }

  // Prefix per object, walked from the objects nobody mounts. The visited set ends a cycle.
  const prefixOf = new Map<string, string>();
  const visited = new Set<string>();
  const walk = (key: string, prefix: string): void => {
    if (visited.has(key)) return;
    visited.add(key);
    prefixOf.set(key, prefix);
    for (const child of children.get(key) ?? []) walk(child.key, `${prefix}${child.prefix}`);
  };
  for (const key of children.keys()) if (!mounted.has(key)) walk(key, '');
  for (const key of children.keys()) walk(key, '');

  for (const file of python) {
    const { routeObjects } = factsFor(file);
    file.routes.forEach((route, index) => {
      const object = routeObjects[index];
      const prefix = object === undefined ? '' : prefixOf.get(identify(file.path, object)) ?? '';
      // One tidy-up, once every prefix is in place: `/articles` + `""` is `/articles`, not
      // `/articles/`, and a route with no path at all is the root.
      const cleaned = `${prefix}${route.path}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
      route.path = cleaned === '' ? '/' : cleaned;
    });
  }
}
