/**
 * A small, safe expression evaluator for calculated tests (no eval).
 * Supports numbers, analyte codes as variables, + - * / ^, parentheses, comparisons
 * (< > <= >= ==) and the functions min, max, pow, abs, log, ln, exp, sqrt, if(cond, a, b).
 * Extra variables: AGE (years) and FEMALE (1 or 0).
 *
 * Examples: "CHOL - HDL - TG / 5" (Friedewald LDL),
 * "142 * pow(min(CREA / if(FEMALE, 0.7, 0.9), 1), if(FEMALE, -0.241, -0.302)) * pow(max(CREA / if(FEMALE, 0.7, 0.9), 1), -1.2) * pow(0.9938, AGE) * if(FEMALE, 1.012, 1)"
 */

type Token =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: '('; v: '(' }
  | { t: ')'; v: ')' }
  | { t: ','; v: ',' };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE]/.test(src[j]!)) {
        if ((src[j] === 'e' || src[j] === 'E') && /[+-]/.test(src[j + 1] ?? '')) j++;
        j++;
      }
      out.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.%#]/.test(src[j]!)) j++;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '=='].includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/^<>'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ t: c, v: c } as Token);
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${c}" in formula`);
  }
  return out;
}

type Node =
  | { k: 'num'; v: number }
  | { k: 'var'; name: string }
  | { k: 'neg'; e: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'call'; fn: string; args: Node[] };

const PRECEDENCE: Record<string, number> = { '<': 1, '>': 1, '<=': 1, '>=': 1, '==': 1, '+': 2, '-': 2, '*': 3, '/': 3, '^': 4 };
const FUNCTIONS = new Set(['min', 'max', 'pow', 'abs', 'log', 'ln', 'exp', 'sqrt', 'if']);

function parse(tokens: Token[]): Node {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function primary(): Node {
    const tok = next();
    if (!tok) throw new Error('Unexpected end of formula');
    if (tok.t === 'num') return { k: 'num', v: tok.v };
    if (tok.t === 'op' && tok.v === '-') return { k: 'neg', e: unary() };
    if (tok.t === 'op' && tok.v === '+') return unary();
    if (tok.t === '(') {
      const e = expr(0);
      if (next()?.t !== ')') throw new Error('Missing closing parenthesis');
      return e;
    }
    if (tok.t === 'id') {
      const lower = tok.v.toLowerCase();
      if (FUNCTIONS.has(lower) && peek()?.t === '(') {
        next();
        const args: Node[] = [];
        if (peek()?.t !== ')') {
          for (;;) {
            args.push(expr(0));
            if (peek()?.t === ',') {
              next();
              continue;
            }
            break;
          }
        }
        if (next()?.t !== ')') throw new Error(`Missing ")" after ${tok.v}(`);
        return { k: 'call', fn: lower, args };
      }
      return { k: 'var', name: tok.v };
    }
    throw new Error(`Unexpected token "${tok.v}"`);
  }

  function unary(): Node {
    return primary();
  }

  function expr(minPrec: number): Node {
    let left = unary();
    for (;;) {
      const tok = peek();
      if (!tok || tok.t !== 'op') break;
      const prec = PRECEDENCE[tok.v];
      if (prec === undefined || prec < minPrec) break;
      next();
      // ^ is right-associative, everything else left-associative.
      const right = expr(tok.v === '^' ? prec : prec + 1);
      left = { k: 'bin', op: tok.v, l: left, r: right };
    }
    return left;
  }

  const result = expr(0);
  if (pos < tokens.length) throw new Error(`Unexpected "${tokens[pos]!.v}" in formula`);
  return result;
}

function evaluate(node: Node, vars: Record<string, number | null | undefined>): number {
  switch (node.k) {
    case 'num':
      return node.v;
    case 'var': {
      const v = vars[node.name] ?? vars[node.name.toUpperCase()];
      if (v === null || v === undefined || Number.isNaN(v)) throw new MissingVariable(node.name);
      return v;
    }
    case 'neg':
      return -evaluate(node.e, vars);
    case 'bin': {
      const l = evaluate(node.l, vars);
      const r = evaluate(node.r, vars);
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? Number.NaN : l / r;
        case '^': return Math.pow(l, r);
        case '<': return l < r ? 1 : 0;
        case '>': return l > r ? 1 : 0;
        case '<=': return l <= r ? 1 : 0;
        case '>=': return l >= r ? 1 : 0;
        case '==': return l === r ? 1 : 0;
      }
      throw new Error(`Unknown operator ${node.op}`);
    }
    case 'call': {
      if (node.fn === 'if') {
        if (node.args.length !== 3) throw new Error('if() needs three arguments');
        return evaluate(node.args[0]!, vars) ? evaluate(node.args[1]!, vars) : evaluate(node.args[2]!, vars);
      }
      const a = node.args.map((x) => evaluate(x, vars));
      switch (node.fn) {
        case 'min': return Math.min(...a);
        case 'max': return Math.max(...a);
        case 'pow': return Math.pow(a[0]!, a[1]!);
        case 'abs': return Math.abs(a[0]!);
        case 'log': return Math.log10(a[0]!);
        case 'ln': return Math.log(a[0]!);
        case 'exp': return Math.exp(a[0]!);
        case 'sqrt': return Math.sqrt(a[0]!);
      }
      throw new Error(`Unknown function ${node.fn}`);
    }
  }
}

class MissingVariable extends Error {
  constructor(public variable: string) {
    super(`Missing value for ${variable}`);
  }
}

const cache = new Map<string, Node>();
function compiled(formula: string): Node {
  let node = cache.get(formula);
  if (!node) {
    node = parse(tokenize(formula));
    cache.set(formula, node);
  }
  return node;
}

/** Evaluate a formula; returns null when an input value is missing or the result isn't finite. */
export function evaluateFormula(formula: string, vars: Record<string, number | null | undefined>): number | null {
  try {
    const v = evaluate(compiled(formula), vars);
    return Number.isFinite(v) ? v : null;
  } catch (e) {
    if (e instanceof MissingVariable) return null;
    throw e;
  }
}

/** Variables a formula uses, excluding function names and the built-ins AGE and FEMALE. */
export function formulaVariables(formula: string): string[] {
  const names = new Set<string>();
  const walk = (n: Node) => {
    if (n.k === 'var') names.add(n.name);
    else if (n.k === 'neg') walk(n.e);
    else if (n.k === 'bin') {
      walk(n.l);
      walk(n.r);
    } else if (n.k === 'call') n.args.forEach(walk);
  };
  walk(compiled(formula));
  names.delete('AGE');
  names.delete('FEMALE');
  return [...names];
}

/** Throws a readable error when a formula can't be parsed. */
export function validateFormula(formula: string): void {
  parse(tokenize(formula));
}
