const MAX_JSON_BYTES = 768 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_STRING_BYTES = 256 * 1024;
const MAX_EXPONENT_DIGITS = 4;
const MAX_ABSOLUTE_EXPONENT = 1_000;
const MIN_SAFE_INTEGER = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const HEX_QUAD_PATTERN = /^[0-9A-Fa-f]{4}$/;

function invalidJson(): Error {
  return new Error("Invalid WeChat JSON.");
}

class StrictJsonParser {
  private position = 0;
  private nodes = 0;

  constructor(private readonly input: string) {}

  parse(): unknown {
    if (Buffer.byteLength(this.input, "utf8") > MAX_JSON_BYTES) {
      throw invalidJson();
    }
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.position !== this.input.length) throw invalidJson();
    return value;
  }

  private parseValue(depth: number): unknown {
    if (depth > MAX_JSON_DEPTH || ++this.nodes > MAX_JSON_NODES) {
      throw invalidJson();
    }

    const character = this.input[this.position];
    if (character === "{") return this.parseObject(depth);
    if (character === "[") return this.parseArray(depth);
    if (character === '"') return this.parseString();
    if (character === "t") return this.parseLiteral("true", true);
    if (character === "f") return this.parseLiteral("false", false);
    if (character === "n") return this.parseLiteral("null", null);
    if (character === "-" || (character >= "0" && character <= "9")) {
      return this.parseNumber();
    }
    throw invalidJson();
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.position += 1;
    const value = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.input[this.position] === "}") {
      this.position += 1;
      return value;
    }

    while (true) {
      if (this.input[this.position] !== '"') throw invalidJson();
      const key = this.parseString();
      if (keys.has(key)) throw invalidJson();
      keys.add(key);
      this.skipWhitespace();
      if (this.input[this.position] !== ":") throw invalidJson();
      this.position += 1;
      this.skipWhitespace();
      value[key] = this.parseValue(depth + 1);
      this.skipWhitespace();

      const separator = this.input[this.position];
      if (separator === "}") {
        this.position += 1;
        return value;
      }
      if (separator !== ",") throw invalidJson();
      this.position += 1;
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): unknown[] {
    this.position += 1;
    const value: unknown[] = [];
    this.skipWhitespace();
    if (this.input[this.position] === "]") {
      this.position += 1;
      return value;
    }

    while (true) {
      value.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const separator = this.input[this.position];
      if (separator === "]") {
        this.position += 1;
        return value;
      }
      if (separator !== ",") throw invalidJson();
      this.position += 1;
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.position += 1;
    let value = "";
    while (this.position < this.input.length) {
      const character = this.input[this.position++];
      if (character === '"') {
        if (Buffer.byteLength(value, "utf8") > MAX_JSON_STRING_BYTES) {
          throw invalidJson();
        }
        return value;
      }
      if (character === "\\") {
        value += this.parseEscape();
      } else {
        if (character.charCodeAt(0) <= 0x1f) throw invalidJson();
        value += character;
      }
      if (value.length > MAX_JSON_STRING_BYTES) throw invalidJson();
    }
    throw invalidJson();
  }

  private parseEscape(): string {
    const escape = this.input[this.position++];
    switch (escape) {
      case '"':
      case "\\":
      case "/":
        return escape;
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hexadecimal = this.input.slice(this.position, this.position + 4);
        if (!HEX_QUAD_PATTERN.test(hexadecimal)) throw invalidJson();
        this.position += 4;
        return String.fromCharCode(Number.parseInt(hexadecimal, 16));
      }
      default:
        throw invalidJson();
    }
  }

  private parseLiteral<T>(literal: string, value: T): T {
    if (this.input.slice(this.position, this.position + literal.length) !== literal) {
      throw invalidJson();
    }
    this.position += literal.length;
    return value;
  }

  private parseNumber(): number {
    const negative = this.input[this.position] === "-";
    if (negative) this.position += 1;

    const integerStart = this.position;
    if (this.input[this.position] === "0") {
      this.position += 1;
      if (this.isDigit(this.input[this.position])) throw invalidJson();
    } else {
      if (!this.isNonzeroDigit(this.input[this.position])) throw invalidJson();
      while (this.isDigit(this.input[this.position])) this.position += 1;
    }
    const integerDigits = this.input.slice(integerStart, this.position);

    let fractionDigits = "";
    if (this.input[this.position] === ".") {
      this.position += 1;
      const fractionStart = this.position;
      if (!this.isDigit(this.input[this.position])) throw invalidJson();
      while (this.isDigit(this.input[this.position])) this.position += 1;
      fractionDigits = this.input.slice(fractionStart, this.position);
    }

    let exponent = 0;
    if (
      this.input[this.position] === "e" ||
      this.input[this.position] === "E"
    ) {
      this.position += 1;
      const exponentNegative = this.input[this.position] === "-";
      if (this.input[this.position] === "+" || exponentNegative) {
        this.position += 1;
      }
      const exponentStart = this.position;
      if (!this.isDigit(this.input[this.position])) throw invalidJson();
      while (this.isDigit(this.input[this.position])) this.position += 1;
      const exponentDigits = this.input.slice(exponentStart, this.position);
      if (exponentDigits.length > MAX_EXPONENT_DIGITS) throw invalidJson();
      exponent = Number(exponentDigits);
      if (exponent > MAX_ABSOLUTE_EXPONENT) throw invalidJson();
      if (exponentNegative) exponent = -exponent;
    }

    const rawCoefficient = `${integerDigits}${fractionDigits}`;
    let firstSignificantDigit = 0;
    while (
      firstSignificantDigit < rawCoefficient.length &&
      rawCoefficient[firstSignificantDigit] === "0"
    ) {
      firstSignificantDigit += 1;
    }
    if (firstSignificantDigit === rawCoefficient.length) {
      return negative ? -0 : 0;
    }

    let coefficient = rawCoefficient.slice(firstSignificantDigit);
    const scale = exponent - fractionDigits.length;
    if (scale < 0) {
      const requiredTrailingZeros = -scale;
      if (requiredTrailingZeros > coefficient.length) throw invalidJson();
      for (
        let index = coefficient.length - requiredTrailingZeros;
        index < coefficient.length;
        index += 1
      ) {
        if (coefficient[index] !== "0") throw invalidJson();
      }
      coefficient = coefficient.slice(0, -requiredTrailingZeros) || "0";
    } else {
      if (coefficient.length + scale > 16) throw invalidJson();
      coefficient += "0".repeat(scale);
    }

    if (coefficient.length > 16) throw invalidJson();
    let integer: bigint;
    try {
      integer = BigInt(coefficient);
    } catch {
      throw invalidJson();
    }
    if (negative) integer = -integer;
    if (integer < MIN_SAFE_INTEGER || integer > MAX_SAFE_INTEGER) {
      throw invalidJson();
    }
    return Number(integer);
  }

  private isDigit(value: string | undefined): boolean {
    return value !== undefined && value >= "0" && value <= "9";
  }

  private isNonzeroDigit(value: string | undefined): boolean {
    return value !== undefined && value >= "1" && value <= "9";
  }

  private skipWhitespace(): void {
    while (
      this.input[this.position] === " " ||
      this.input[this.position] === "\t" ||
      this.input[this.position] === "\r" ||
      this.input[this.position] === "\n"
    ) {
      this.position += 1;
    }
  }
}

export function parseStrictWechatJson(input: string): unknown {
  return new StrictJsonParser(input).parse();
}
