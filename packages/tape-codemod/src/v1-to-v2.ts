/**
 * v1-to-v2 — collapse tape-react's deprecated render-phase pair
 *
 *   const s = useStream(client, CHANNEL, OPTS?);
 *   useCoalesced(s, FIELD, POLICY);   // any number, same function body
 *
 * into the declarative v2 hook
 *
 *   const s = useSubscription(client, {
 *     channel: CHANNEL,
 *     policy: { FIELD: POLICY, ... }, // omitted when there were none
 *     ...OPTS properties               // priority / snapshot, verbatim
 *   });
 *
 * and rewrite the '@lalitheswaran11-stack/tape-react' import (drop useStream /
 * useCoalesced once unreferenced, add useSubscription once, preserve all
 * other specifiers and aliases; aliased imports of the two hooks are
 * resolved by local name).
 *
 * The transform is conservative. Whenever a call site cannot be migrated
 * provably-safely it is left byte-for-byte untouched and annotated with
 *   // TODO(tape-codemod): manual migration needed — <reason>
 * Bail-outs: non-object-literal OPTS (or OPTS containing a spread); a
 * useCoalesced whose stream variable was not created by a useStream in the
 * same function; a FIELD or POLICY expression that cannot be lifted
 * verbatim (literals, identifiers, and object literals of those are fine);
 * useCoalesced inside a conditional or loop. A non-literal CHANNEL is NOT
 * a bail-out — any channel expression passes through.
 *
 * Idempotent: running it over already-migrated (or annotated) code
 * changes nothing.
 */

import type {
  API,
  ASTPath,
  CallExpression,
  FileInfo,
  JSCodeshift,
  ObjectExpression,
  Options,
  Transform,
} from 'jscodeshift';

const PKG = '@lalitheswaran11-stack/tape-react';
const TODO_MARKER = 'TODO(tape-codemod)';
const TODO_PREFIX = 'TODO(tape-codemod): manual migration needed';

// ast-types NodePath generics fight every traversal helper; a single loose
// alias keeps the transform readable without sacrificing the typed core API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPath = ASTPath<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
]);

interface CoalescedMember {
  stmtPath: AnyPath; // the ExpressionStatement to delete
  field: AnyNode; // string literal or identifier
  policy: AnyNode; // liftable-verbatim expression
}

interface StreamGroup {
  callPath: ASTPath<CallExpression>;
  stmtPath: AnyPath; // the VariableDeclaration statement
  /** Set when the useStream side itself cannot be migrated. */
  bailReason: string | null;
  /** Set when any member useCoalesced bailed (member carries the comment). */
  poisoned: boolean;
  members: CoalescedMember[];
}

const transform: Transform = (file: FileInfo, api: API, _options: Options) => {
  const j: JSCodeshift = api.jscodeshift;
  const root = j(file.source);

  // -------------------------------------------------------------------------
  // Resolve local names bound by imports from the tape-react package.

  const tapeImportPaths: AnyPath[] = [];
  root.find(j.ImportDeclaration).forEach((path) => {
    if (path.node.source.value === PKG) tapeImportPaths.push(path);
  });
  if (tapeImportPaths.length === 0) return null;

  const streamLocals = new Set<string>();
  const coalescedLocals = new Set<string>();
  let subscriptionLocal: string | null = null;

  for (const decl of tapeImportPaths) {
    for (const spec of decl.node.specifiers ?? []) {
      if (spec.type !== 'ImportSpecifier') continue;
      const imported: string = spec.imported.name;
      const local: string = spec.local?.name ?? imported;
      if (imported === 'useStream') streamLocals.add(local);
      else if (imported === 'useCoalesced') coalescedLocals.add(local);
      else if (imported === 'useSubscription') subscriptionLocal = local;
    }
  }
  if (streamLocals.size === 0 && coalescedLocals.size === 0) return null;

  const programNode = root.get().node.program ?? root.get().node;

  let changed = false;

  // -------------------------------------------------------------------------
  // Traversal helpers

  /** Nearest enclosing function path; null at module scope. */
  function enclosingFunction(path: AnyPath): AnyPath | null {
    let p: AnyPath | null = path.parent ?? null;
    while (p != null) {
      if (FUNCTION_TYPES.has(p.node.type)) return p;
      if (p.node.type === 'Program') return null;
      p = p.parent ?? null;
    }
    return null;
  }

  /** The node whose direct-child statements form a scope's "top level". */
  function scopeBody(fn: AnyPath | null): AnyNode {
    return fn === null ? programNode : fn.node.body;
  }

  function isStatementNode(node: AnyNode): boolean {
    const t: string = node.type;
    return t.endsWith('Statement') || t.endsWith('Declaration');
  }

  /** Closest ancestor path (inclusive) that is a statement. */
  function closestStatement(path: AnyPath): AnyPath {
    let p: AnyPath = path;
    while (p.parent != null && !isStatementNode(p.node)) p = p.parent;
    return p;
  }

  function addTodo(stmtPath: AnyPath, reason: string): void {
    const node = stmtPath.node as {
      comments?: Array<{ value?: unknown }> | null;
    };
    const comments = node.comments ?? [];
    // Idempotency: never stack a second marker onto an annotated site.
    if (
      comments.some(
        (c) => typeof c.value === 'string' && c.value.includes(TODO_MARKER),
      )
    ) {
      return;
    }
    const comment = j.commentLine(` ${TODO_PREFIX} — ${reason}`, true, false);
    node.comments = [...comments, comment] as typeof node.comments;
    changed = true;
  }

  // -------------------------------------------------------------------------
  // Liftability — what we are willing to move verbatim into the spec.

  function isStringLiteral(node: AnyNode): boolean {
    return (
      node.type === 'StringLiteral' ||
      (node.type === 'Literal' && typeof node.value === 'string')
    );
  }

  function isLiteralNode(node: AnyNode): boolean {
    if (
      node.type === 'StringLiteral' ||
      node.type === 'NumericLiteral' ||
      node.type === 'BooleanLiteral' ||
      node.type === 'NullLiteral' ||
      node.type === 'BigIntLiteral' ||
      node.type === 'Literal'
    ) {
      return true;
    }
    return node.type === 'TemplateLiteral' && node.expressions.length === 0;
  }

  /** Literals, identifiers, ±numeric, and object literals thereof. */
  function isLiftable(node: AnyNode): boolean {
    if (isLiteralNode(node)) return true;
    if (node.type === 'Identifier') return true;
    if (
      node.type === 'UnaryExpression' &&
      (node.operator === '-' || node.operator === '+') &&
      isLiteralNode(node.argument)
    ) {
      return true;
    }
    if (node.type === 'ObjectExpression') {
      return node.properties.every(
        (prop: AnyNode) =>
          (prop.type === 'ObjectProperty' || prop.type === 'Property') &&
          prop.computed !== true &&
          isLiftable(prop.value),
      );
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Pass 1: collect useStream call sites, grouped by enclosing scope.

  /** scope body node → (stream variable name → group) */
  const groupsByScope = new Map<AnyNode, Map<string, StreamGroup>>();

  root.find(j.CallExpression).forEach((path) => {
    const callee = path.node.callee;
    if (callee.type !== 'Identifier' || !streamLocals.has(callee.name)) return;

    const declarator = path.parent;
    const declaration = declarator?.parent;
    const fn = enclosingFunction(path);
    const body = scopeBody(fn);
    const conforming =
      declarator != null &&
      declarator.node.type === 'VariableDeclarator' &&
      declarator.node.init === path.node &&
      declarator.node.id.type === 'Identifier' &&
      declaration != null &&
      declaration.node.type === 'VariableDeclaration' &&
      declaration.parent?.node === body;

    if (!conforming) {
      addTodo(
        closestStatement(path),
        'expected `const stream = useStream(...)` as a top-level statement of the component function',
      );
      return;
    }

    // Validate the useStream side up front; a bad OPTS bails the whole
    // group (its useCoalesced statements must stay behind with it).
    let bailReason: string | null = null;
    const args = path.node.arguments;
    if (args.length < 2 || args.length > 3) {
      bailReason = 'unexpected number of useStream arguments';
    } else if (args.length === 3) {
      const opts = args[2] as AnyNode;
      if (opts.type !== 'ObjectExpression') {
        bailReason = 'options argument is not an inline object literal';
      } else if (
        (opts as ObjectExpression).properties.some(
          (p: AnyNode) =>
            p.type === 'SpreadElement' || p.type === 'SpreadProperty',
        )
      ) {
        bailReason = 'options object contains a spread';
      }
    }

    let perScope = groupsByScope.get(body);
    if (perScope === undefined) {
      perScope = new Map();
      groupsByScope.set(body, perScope);
    }
    perScope.set(declarator.node.id.name, {
      callPath: path,
      stmtPath: declaration,
      bailReason,
      poisoned: false,
      members: [],
    });
  });

  // -------------------------------------------------------------------------
  // Pass 2: attach useCoalesced call sites to their stream's group.

  root.find(j.CallExpression).forEach((path) => {
    const callee = path.node.callee;
    if (callee.type !== 'Identifier' || !coalescedLocals.has(callee.name)) {
      return;
    }

    const fn = enclosingFunction(path);
    const body = scopeBody(fn);
    const stmt = closestStatement(path);
    const args = path.node.arguments;
    const streamArg = args[0] as AnyNode | undefined;

    const group =
      streamArg !== undefined && streamArg.type === 'Identifier'
        ? groupsByScope.get(body)?.get(streamArg.name)
        : undefined;
    if (group === undefined) {
      addTodo(
        stmt,
        'stream is not a variable created by a useStream in the same function',
      );
      return;
    }

    const structural =
      stmt.node.type === 'ExpressionStatement' &&
      stmt.node.expression === path.node &&
      stmt.parent?.node === body;
    if (!structural) {
      addTodo(stmt, 'useCoalesced inside a conditional or loop');
      group.poisoned = true;
      return;
    }

    if (args.length !== 3) {
      addTodo(stmt, 'unexpected number of useCoalesced arguments');
      group.poisoned = true;
      return;
    }
    const field = args[1] as AnyNode;
    const policy = args[2] as AnyNode;
    if (!isStringLiteral(field) && field.type !== 'Identifier') {
      addTodo(
        stmt,
        'dynamic field expression cannot be lifted into the policy object',
      );
      group.poisoned = true;
      return;
    }
    if (!isLiftable(policy)) {
      addTodo(stmt, 'policy expression cannot be lifted verbatim');
      group.poisoned = true;
      return;
    }
    group.members.push({ stmtPath: stmt, field, policy });
  });

  // -------------------------------------------------------------------------
  // Pass 3: rewrite each intact group.

  const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  let transformedAny = false;

  for (const perScope of groupsByScope.values()) {
    for (const group of perScope.values()) {
      if (group.bailReason !== null) {
        addTodo(group.stmtPath, group.bailReason);
        continue;
      }
      if (group.poisoned) continue; // offending member carries the comment

      const call = group.callPath.node;
      const clientArg = call.arguments[0] as AnyNode;
      const channelArg = call.arguments[1] as AnyNode;
      const optsArg = (call.arguments[2] as ObjectExpression | undefined) ?? null;

      const channelProp = j.objectProperty(j.identifier('channel'), channelArg);
      if (channelArg.type === 'Identifier' && channelArg.name === 'channel') {
        channelProp.shorthand = true;
      }
      const specProps: AnyNode[] = [channelProp];

      if (group.members.length > 0) {
        const policyProps = group.members.map((m) => {
          if (m.field.type === 'Identifier') {
            const prop = j.objectProperty(m.field, m.policy);
            prop.computed = true;
            return prop;
          }
          const name = m.field.value as string;
          const key = IDENT_RE.test(name)
            ? j.identifier(name)
            : j.stringLiteral(name);
          return j.objectProperty(key, m.policy);
        });
        specProps.push(
          j.objectProperty(
            j.identifier('policy'),
            j.objectExpression(policyProps),
          ),
        );
      }

      if (optsArg !== null) specProps.push(...(optsArg.properties as AnyNode[]));

      call.callee = j.identifier(subscriptionLocal ?? 'useSubscription');
      call.arguments = [clientArg, j.objectExpression(specProps)];
      for (const m of group.members) m.stmtPath.prune();
      transformedAny = true;
      changed = true;
    }
  }

  // -------------------------------------------------------------------------
  // Pass 4: rewrite the tape-react import declarations.

  if (transformedAny && subscriptionLocal === null) {
    const first = tapeImportPaths[0] as AnyPath;
    first.node.specifiers = [
      ...(first.node.specifiers ?? []),
      j.importSpecifier(j.identifier('useSubscription')),
    ];
    subscriptionLocal = 'useSubscription';
  }

  /** True references only: skips import specifiers, member/property keys. */
  function isReferenced(name: string): boolean {
    return (
      root
        .find(j.Identifier, { name })
        .filter((p) => {
          const parent = p.parent?.node as AnyNode;
          if (parent == null) return true;
          const t: string = parent.type;
          if (
            t === 'ImportSpecifier' ||
            t === 'ImportDefaultSpecifier' ||
            t === 'ImportNamespaceSpecifier'
          ) {
            return false;
          }
          if (
            (t === 'MemberExpression' || t === 'OptionalMemberExpression') &&
            parent.property === p.node &&
            parent.computed !== true
          ) {
            return false;
          }
          if (
            (t === 'ObjectProperty' || t === 'Property') &&
            parent.key === p.node &&
            parent.computed !== true
          ) {
            return false;
          }
          return true;
        })
        .size() > 0
    );
  }

  for (const decl of tapeImportPaths) {
    const specs: AnyNode[] = decl.node.specifiers ?? [];
    const kept = specs.filter((spec: AnyNode) => {
      if (spec.type !== 'ImportSpecifier') return true;
      const imported: string = spec.imported.name;
      if (imported !== 'useStream' && imported !== 'useCoalesced') return true;
      const local: string = spec.local?.name ?? imported;
      return isReferenced(local);
    });
    if (kept.length === specs.length) continue;
    changed = true;
    if (kept.length === 0) decl.prune();
    else decl.node.specifiers = kept;
  }

  return changed ? root.toSource({ quote: 'single' }) : null;
};

export const parser = 'tsx';
export default transform;
