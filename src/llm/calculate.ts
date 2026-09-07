export function calculate(expression: string): number {
  if (!expression.trim() || expression.length > 500) throw new Error('Expression must contain 1–500 characters.');
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[^\s]/g) ?? [];
  let position = 0;
  function primary(): number {
    const token = tokens[position++];
    if (token === '(') {
      const value = sum();
      if (tokens[position++] !== ')') throw new Error('Missing closing parenthesis.');
      return value;
    }
    if (!token || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token))
      throw new Error('Expected a number or parenthesis.');
    return Number(token);
  }
  function power(): number {
    const left = primary();
    if (tokens[position] !== '^') return left;
    position++;
    return left ** unary();
  }
  function unary(): number {
    if (tokens[position] === '+' || tokens[position] === '-') {
      const sign = tokens[position++];
      return (sign === '-' ? -1 : 1) * unary();
    }
    return power();
  }
  function product(): number {
    let value = unary();
    while (['*', '/', '%'].includes(tokens[position] ?? '')) {
      const operator = tokens[position++];
      const right = unary();
      if ((operator === '/' || operator === '%') && right === 0) throw new Error('Division by zero.');
      value = operator === '*' ? value * right : operator === '/' ? value / right : value % right;
    }
    return value;
  }
  function sum(): number {
    let value = product();
    while (tokens[position] === '+' || tokens[position] === '-') {
      const operator = tokens[position++];
      const right = product();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }
  const value = sum();
  if (position !== tokens.length) throw new Error('Unexpected token.');
  if (!Number.isFinite(value)) throw new Error('Result is not finite.');
  return value;
}
