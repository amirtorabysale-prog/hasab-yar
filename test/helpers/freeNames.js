import { readFileSync } from 'node:fs';
import { parseSync } from 'vite';

/**
 * نام‌های آزاد یک فایل: هر شناسه‌ای که خوانده می‌شود ولی در هیچ دامنه‌ای از همان
 * فایل تعریف یا import نشده است.
 *
 * نسخهٔ کوچکی از قاعدهٔ no-undef، روی AST واقعی (پارسر oxc که همراه vite است).
 * برای این ساخته شد که import جاافتاده تا لحظهٔ اجرای همان مسیر دیده نمی‌شود:
 * ساخت موفق است، بیشتر آزمون‌ها سبزند، و فقط درخواستی که به آن خط برسد ۵۰۰
 * می‌گیرد یا صفحه می‌افتد.
 */
export function freeNames(file, code = readFileSync(file, 'utf8')) {
  const result = parseSync(file, code, { lang: /\.jsx$/.test(file) ? 'jsx' : 'js', sourceType: 'module' });
  if (result.errors.length) throw new Error(`${file}: ${result.errors[0].message}`);
  const free = new Set();
  const used = new Set();
  const resolve = (name, scopes) => {
    used.add(name);
    if (!scopes.some((scope) => scope.has(name))) free.add(name);
  };
  const walkPattern = (pattern, scopes) => {
    if (!pattern) return;
    if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') walkPattern(property.argument, scopes);
        else { if (property.computed) walk(property.key, scopes); walkPattern(property.value, scopes); }
      }
    } else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((element) => walkPattern(element, scopes));
    else if (pattern.type === 'AssignmentPattern') { walkPattern(pattern.left, scopes); walk(pattern.right, scopes); }
    else if (pattern.type === 'RestElement') walkPattern(pattern.argument, scopes);
    else if (pattern.type !== 'Identifier') walk(pattern, scopes);
  };
  const walkFunction = (node, scopes) => {
    const scope = new Set(node.params.flatMap((param) => patternNames(param)));
    if (node.type === 'FunctionExpression' && node.id) scope.add(node.id.name);
    const inner = [...scopes, scope];
    node.params.forEach((param) => walkPattern(param, inner));
    walk(node.body, inner);
  };
  const jsxRoot = (name) => (name.type === 'JSXMemberExpression' ? jsxRoot(name.object) : name);
  function walk(node, scopes) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((item) => walk(item, scopes)); return; }
    switch (node.type) {
      case 'Program': case 'BlockStatement': case 'StaticBlock': {
        const inner = [...scopes, declarationsOf(node.body)];
        node.body.forEach((item) => walk(item, inner));
        return;
      }
      case 'SwitchStatement': {
        walk(node.discriminant, scopes);
        const inner = [...scopes, declarationsOf(node.cases.flatMap((item) => item.consequent))];
        node.cases.forEach((item) => { walk(item.test, inner); item.consequent.forEach((statement) => walk(statement, inner)); });
        return;
      }
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': {
        const head = node.type === 'ForStatement' ? node.init : node.left;
        const inner = [...scopes, declarationsOf(head?.type === 'VariableDeclaration' ? [head] : [])];
        for (const key of ['init', 'test', 'update', 'left', 'right', 'body']) walk(node[key], inner);
        return;
      }
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': walkFunction(node, scopes); return;
      case 'ClassDeclaration': case 'ClassExpression': {
        const inner = node.id ? [...scopes, new Set([node.id.name])] : scopes;
        walk(node.superClass, inner);
        walk(node.body, inner);
        return;
      }
      case 'VariableDeclaration': node.declarations.forEach((item) => { walkPattern(item.id, scopes); walk(item.init, scopes); }); return;
      case 'CatchClause': {
        const inner = [...scopes, new Set(patternNames(node.param))];
        walkPattern(node.param, inner);
        walk(node.body, inner);
        return;
      }
      case 'Identifier': resolve(node.name, scopes); return;
      case 'MemberExpression': walk(node.object, scopes); if (node.computed) walk(node.property, scopes); return;
      case 'Property': case 'MethodDefinition': case 'PropertyDefinition': if (node.computed) walk(node.key, scopes); walk(node.value, scopes); return;
      case 'LabeledStatement': walk(node.body, scopes); return;
      case 'ImportDeclaration': case 'BreakStatement': case 'ContinueStatement': case 'MetaProperty': case 'PrivateIdentifier':
      case 'Literal': case 'JSXText': case 'JSXEmptyExpression': case 'JSXClosingElement': case 'JSXOpeningFragment': case 'JSXClosingFragment': return;
      case 'ExportNamedDeclaration': walk(node.declaration, scopes); if (!node.source) node.specifiers.forEach((item) => walk(item.local, scopes)); return;
      case 'ExportDefaultDeclaration': walk(node.declaration, scopes); return;
      case 'AssignmentExpression':
        if (node.left.type === 'ObjectPattern' || node.left.type === 'ArrayPattern') {
          patternNames(node.left).forEach((name) => resolve(name, scopes));
          walkPattern(node.left, scopes);
        } else walk(node.left, scopes);
        walk(node.right, scopes);
        return;
      case 'JSXOpeningElement': {
        // <div> عنصر خود HTML است؛ <Sheet> و <Icons.X> نام‌اند و باید تعریف شده باشند.
        const root = jsxRoot(node.name);
        if (root.type === 'JSXIdentifier' && (node.name.type === 'JSXMemberExpression' || /^[A-Z]/.test(root.name))) resolve(root.name, scopes);
        node.attributes.forEach((item) => walk(item.type === 'JSXSpreadAttribute' ? item.argument : item.value, scopes));
        return;
      }
      default:
        for (const [key, value] of Object.entries(node)) {
          if (key !== 'type' && key !== 'start' && key !== 'end' && key !== 'range' && value && typeof value === 'object') walk(value, scopes);
        }
    }
  }
  walk(result.program, []);
  return free;
}

function patternNames(pattern, out = []) {
  if (!pattern) return out;
  if (pattern.type === 'Identifier') out.push(pattern.name);
  else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((item) => patternNames(item.type === 'RestElement' ? item.argument : item.value, out));
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((item) => patternNames(item, out));
  else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, out);
  else if (pattern.type === 'RestElement') patternNames(pattern.argument, out);
  return out;
}

function declarationsOf(statements) {
  const names = new Set();
  const add = (node) => {
    if (!node) return;
    if (node.type === 'VariableDeclaration') node.declarations.forEach((item) => patternNames(item.id).forEach((name) => names.add(name)));
    else if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) names.add(node.id.name);
    else if (node.type === 'ImportDeclaration') node.specifiers.forEach((item) => names.add(item.local.name));
    else if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') add(node.declaration);
  };
  statements.forEach(add);
  return names;
}
