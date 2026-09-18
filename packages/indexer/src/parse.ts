/**
 * Pipeline step 3 — Parse.
 *
 * The goal is a module-level graph, not semantic analysis: imports, exports, declarations
 * and call sites are enough to answer "where does this belong". Type resolution, the
 * cross-file call graph, dynamic imports and package boundaries are deliberately skipped.
 *
 * A parse failure on one file never fails the batch — the path and the error are recorded
 * and the walk continues.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Language, Parser } from 'web-tree-sitter';
import type { Node as SyntaxNode } from 'web-tree-sitter';

import { IndexerError } from './lib/errors';

/** The output shape from `docs/01-BACKEND.md`, "Tree-sitter extraction". */
export interface ParsedFile {
  path: string;
  language: 'ts' | 'tsx' | 'js' | 'jsx';
  lineCount: number;
  imports: { specifier: string; resolved: string | null; names: string[] }[];
  exports: { name: string; isDefault: boolean }[];
  declarations: { name: string; kind: string; startLine: number; endLine: number }[];
  calls: { callee: string; line: number }[];
  routes: { method: string; path: string; line: number }[];
}

export interface ParseFailure {
  path: string;
  reason: string;
}

export interface ParseResult {
  files: ParsedFile[];
  failures: ParseFailure[];
  /** Parsed, but the tree contains error nodes. Kept — partial extraction beats none. */
  syntaxErrors: string[];
}

export interface ParseOptions {
  /** The cloned working tree. */
  rootDir: string;
  /** Repo-relative paths to parse. */
  files: string[];
  /** Every kept file, so an import can resolve to a file that is not itself parsed. */
  allFiles: string[];
}

/** Resolution order for a specifier without an extension. */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'] as const;

/** A call chain longer than this is noise; the first part is what retrieval matches on. */
const MAX_CALLEE_LENGTH = 120;

const ROUTE_CALLEE = /^(app|router)\.(get|post|put|delete|use)$/;

/* ── Grammars ───────────────────────────────────────────────────────────────── */

/**
 * The `.wasm` grammars are on disk, never fetched at runtime. `GRAMMAR_DIR` overrides the
 * location, which is how the Lambda will point at its bundled copy.
 */
function findGrammarDir(): string {
  const override = process.env['GRAMMAR_DIR'];
  if (override !== undefined && override !== '') return override;

  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new IndexerError(
    'INDEX_FAILED',
    'The TypeScript grammars are missing. Run npm install, or set GRAMMAR_DIR to the directory holding the tree-sitter .wasm files.',
  );
}

interface Grammars {
  /** .ts */
  typescript: Parser;
  /** .tsx, .jsx and .js — the TSX grammar handles all three. */
  tsx: Parser;
}

async function loadGrammars(): Promise<Grammars> {
  const dir = findGrammarDir();
  await Parser.init();

  const load = async (file: string): Promise<Parser> => {
    const language = await Language.load(path.join(dir, file));
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  };

  return {
    typescript: await load('tree-sitter-typescript.wasm'),
    tsx: await load('tree-sitter-tsx.wasm'),
  };
}

function languageOf(filePath: string): ParsedFile['language'] {
  const extension = path.posix.extname(filePath).toLowerCase();
  switch (extension) {
    case '.ts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    case '.jsx':
      return 'jsx';
    default:
      return 'js';
  }
}

/* ── Import resolution ──────────────────────────────────────────────────────── */

export interface ModuleResolver {
  /** Repo-relative path, or null for a bare specifier (an external dependency). */
  resolve(fromPath: string, specifier: string): string | null;
}

interface Alias {
  /** Everything before the `*`, e.g. `@/`. An exact mapping has no wildcard. */
  prefix: string;
  wildcard: boolean;
  targets: string[];
}

/**
 * tsconfig and jsconfig allow comments and trailing commas, which JSON.parse does not.
 * This strips both well enough for a config file; a file it cannot read yields no aliases,
 * which costs edges rather than breaking the parse.
 */
function parseJsonc(text: string): unknown {
  const withoutComments = text
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*$)|(\/\*[\s\S]*?\*\/)/gm, (match, line: string | undefined, block: string | undefined) =>
      line !== undefined || block !== undefined ? '' : match,
    )
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(withoutComments);
}

/**
 * Path aliases from the repo's tsconfig or jsconfig. Next.js projects lean on `@/*`, and
 * without this almost every internal import in one resolves to nothing and the graph comes
 * out as a field of unconnected nodes.
 */
export async function readPathAliases(rootDir: string): Promise<Alias[]> {
  for (const configName of ['tsconfig.json', 'jsconfig.json']) {
    const configPath = path.join(rootDir, configName);
    if (!existsSync(configPath)) continue;

    try {
      const config = parseJsonc(await readFile(configPath, 'utf8')) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const baseUrl = config.compilerOptions?.baseUrl ?? '.';
      const paths = config.compilerOptions?.paths;
      if (paths === undefined) return [];

      const aliases: Alias[] = [];
      for (const [pattern, targets] of Object.entries(paths)) {
        const wildcard = pattern.endsWith('*');
        aliases.push({
          prefix: wildcard ? pattern.slice(0, -1) : pattern,
          wildcard,
          targets: targets.map((target) => {
            const withoutStar = target.endsWith('*') ? target.slice(0, -1) : target;
            return path.posix.normalize(path.posix.join(baseUrl, withoutStar));
          }),
        });
      }
      return aliases;
    } catch {
      // A config we cannot read is not a reason to fail the index.
      return [];
    }
  }

  return [];
}

export function createResolver(files: string[], aliases: Alias[]): ModuleResolver {
  const fileSet = new Set(files);

  const tryCandidates = (base: string): string | null => {
    const normalised = path.posix.normalize(base).replace(/^\.\//, '');
    if (normalised.startsWith('..')) return null;

    const candidates = [normalised];

    // `./thing.js` in TypeScript ESM usually means `./thing.ts` on disk.
    const jsExtension = /\.(js|jsx)$/.exec(normalised);
    if (jsExtension !== null) {
      const stem = normalised.slice(0, -jsExtension[0].length);
      candidates.push(`${stem}.ts`, `${stem}.tsx`);
    }

    for (const extension of EXTENSIONS) candidates.push(`${normalised}${extension}`);
    for (const extension of EXTENSIONS) candidates.push(`${normalised}/index${extension}`);

    for (const candidate of candidates) {
      if (fileSet.has(candidate)) return candidate;
    }
    return null;
  };

  return {
    resolve(fromPath, specifier) {
      if (specifier.startsWith('.')) {
        return tryCandidates(path.posix.join(path.posix.dirname(fromPath), specifier));
      }

      for (const alias of aliases) {
        if (alias.wildcard && specifier.startsWith(alias.prefix)) {
          const rest = specifier.slice(alias.prefix.length);
          for (const target of alias.targets) {
            const resolved = tryCandidates(path.posix.join(target, rest));
            if (resolved !== null) return resolved;
          }
        } else if (!alias.wildcard && specifier === alias.prefix) {
          for (const target of alias.targets) {
            const resolved = tryCandidates(target);
            if (resolved !== null) return resolved;
          }
        }
      }

      // A bare specifier is an external dependency. Recorded on the node, never an edge.
      return null;
    },
  };
}

/* ── Extraction ─────────────────────────────────────────────────────────────── */

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}

function line(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

function namedChildrenOf(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child): child is SyntaxNode => child !== null);
}

function importedNames(statement: SyntaxNode): string[] {
  const names: string[] = [];

  for (const child of namedChildrenOf(statement)) {
    if (child.type !== 'import_clause') continue;

    for (const clausePart of namedChildrenOf(child)) {
      if (clausePart.type === 'identifier') {
        names.push(clausePart.text); // default import
      } else if (clausePart.type === 'namespace_import') {
        const identifier = namedChildrenOf(clausePart)[0];
        if (identifier !== undefined) names.push(identifier.text);
      } else if (clausePart.type === 'named_imports') {
        for (const specifier of namedChildrenOf(clausePart)) {
          const name = specifier.childForFieldName('name');
          if (name !== null) names.push(name.text);
        }
      }
    }
  }

  return names;
}

function declaredNames(declaration: SyntaxNode): string[] {
  const direct = declaration.childForFieldName('name');
  if (direct !== null) return [direct.text];

  // const a = 1, b = 2
  const names: string[] = [];
  for (const child of namedChildrenOf(declaration)) {
    if (child.type !== 'variable_declarator') continue;
    const name = child.childForFieldName('name');
    if (name !== null && name.type === 'identifier') names.push(name.text);
  }
  return names;
}

/**
 * Everything the graph and, later, retrieval needs from one file. Extraction never throws
 * on a shape it does not recognise; it records what it understands and moves on.
 */
function extractFile(filePath: string, source: string, root: SyntaxNode, resolver: ModuleResolver): ParsedFile {
  const parsed: ParsedFile = {
    path: filePath,
    language: languageOf(filePath),
    lineCount: source.split('\n').length,
    imports: [],
    exports: [],
    declarations: [],
    calls: [],
    routes: [],
  };

  const addImport = (specifier: string, names: string[]): void => {
    parsed.imports.push({ specifier, resolved: resolver.resolve(filePath, specifier), names });
  };

  const addDeclaration = (node: SyntaxNode, kind: string, name: string | null): void => {
    if (name === null) return;
    parsed.declarations.push({
      name,
      kind,
      startLine: line(node),
      endLine: node.endPosition.row + 1,
    });
  };

  /**
   * `insideDeclaration` keeps the declaration list at module and class-body level. Nested
   * arrow functions inside a React component are not separate declarations, and recording
   * them would give chunking overlapping boundaries later.
   */
  const visit = (node: SyntaxNode, insideDeclaration: boolean): void => {
    let nowInside = insideDeclaration;

    switch (node.type) {
      case 'import_statement': {
        const source_ = node.childForFieldName('source');
        if (source_ !== null) addImport(stripQuotes(source_.text), importedNames(node));
        break;
      }

      case 'export_statement': {
        const isDefault = node.children.some((child) => child?.type === 'default');
        const declaration = node.childForFieldName('declaration');
        const reExportSource = node.childForFieldName('source');

        if (reExportSource !== null) {
          // A one-hop re-export is a real dependency. Chains beyond one hop are skipped.
          addImport(stripQuotes(reExportSource.text), []);
        }

        if (declaration !== null) {
          for (const name of declaredNames(declaration)) {
            parsed.exports.push({ name, isDefault });
          }
        }

        for (const child of namedChildrenOf(node)) {
          if (child.type !== 'export_clause') continue;
          for (const specifier of namedChildrenOf(child)) {
            const alias = specifier.childForFieldName('alias');
            const name = specifier.childForFieldName('name');
            const exported = alias ?? name;
            if (exported !== null) {
              parsed.exports.push({ name: exported.text, isDefault: exported.text === 'default' });
            }
          }
        }

        if (isDefault && declaration === null) {
          parsed.exports.push({ name: 'default', isDefault: true });
        }
        break;
      }

      case 'function_declaration':
      case 'generator_function_declaration':
      case 'class_declaration': {
        if (!insideDeclaration) {
          const kind = node.type === 'class_declaration' ? 'class' : 'function';
          addDeclaration(node, kind, node.childForFieldName('name')?.text ?? null);
          nowInside = true;
        }
        break;
      }

      case 'method_definition': {
        if (!insideDeclaration) {
          addDeclaration(node, 'method', node.childForFieldName('name')?.text ?? null);
          nowInside = true;
        }
        break;
      }

      case 'variable_declarator': {
        const value = node.childForFieldName('value');
        const isFunction =
          value !== null && (value.type === 'arrow_function' || value.type === 'function_expression');
        if (!insideDeclaration && isFunction) {
          addDeclaration(node, 'arrow', node.childForFieldName('name')?.text ?? null);
          nowInside = true;
        }
        break;
      }

      case 'call_expression': {
        const callee = node.childForFieldName('function');
        if (callee !== null) {
          const text = callee.text.slice(0, MAX_CALLEE_LENGTH);
          // The callee is stored as raw text. Resolving it to a declaration is expensive
          // and error-prone; retrieval matches on the text instead.
          parsed.calls.push({ callee: text, line: line(node) });

          const route = ROUTE_CALLEE.exec(text);
          if (route !== null) {
            const args = node.childForFieldName('arguments');
            const first = args === null ? undefined : namedChildrenOf(args)[0];
            // Registrations without a path — app.use(cors()) — are not route entries.
            if (first !== undefined && first.type === 'string') {
              parsed.routes.push({
                method: route[2] ?? '',
                path: stripQuotes(first.text),
                line: line(node),
              });
            }
          }
        }
        break;
      }

      default:
        break;
    }

    for (const child of namedChildrenOf(node)) visit(child, nowInside);
  };

  visit(root, false);
  return parsed;
}

/* ── Entry point ────────────────────────────────────────────────────────────── */

export async function parseRepo(options: ParseOptions): Promise<ParseResult> {
  const grammars = await loadGrammars();
  const aliases = await readPathAliases(options.rootDir);
  const resolver = createResolver(options.allFiles, aliases);

  const files: ParsedFile[] = [];
  const failures: ParseFailure[] = [];
  const syntaxErrors: string[] = [];

  for (const filePath of options.files) {
    try {
      const source = await readFile(path.join(options.rootDir, filePath), 'utf8');
      const parser = languageOf(filePath) === 'ts' ? grammars.typescript : grammars.tsx;
      const tree = parser.parse(source);

      if (tree === null) {
        failures.push({ path: filePath, reason: 'The parser returned no tree.' });
        continue;
      }

      try {
        if (tree.rootNode.hasError) syntaxErrors.push(filePath);
        files.push(extractFile(filePath, source, tree.rootNode, resolver));
      } finally {
        // Trees are held in WASM memory and are not garbage collected.
        tree.delete();
      }
    } catch (err) {
      failures.push({ path: filePath, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { files, failures, syntaxErrors };
}
