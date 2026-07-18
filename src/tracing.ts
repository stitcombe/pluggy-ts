/**
 * Tracing utils.
 * Port of pluggy/_tracing.py.
 *
 * `TagTracerSub` instances are callable, like in Python: `log("hello")`.
 * This is achieved by returning a function from the constructor whose
 * prototype is set to the class prototype.
 */

export type Writer = (message: string) => unknown;
export type Processor = (tags: readonly string[], args: readonly unknown[]) => unknown;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export class TagTracer {
  private _tags2proc: Map<string, Processor> = new Map();
  private _writer: Writer | null = null;
  indent = 0;

  get(name: string): TagTracerSub {
    return new TagTracerSub(this, [name]);
  }

  _format_message(tags: readonly string[], args: readonly unknown[]): string {
    let extra: Record<string, unknown> = {};
    if (isPlainObject(args[args.length - 1])) {
      extra = args[args.length - 1] as Record<string, unknown>;
      args = args.slice(0, -1);
    }

    const content = args.map(String).join(" ");
    const indent = "  ".repeat(this.indent);

    const lines = [`${indent}${content} [${tags.join(":")}]\n`];

    for (const [name, value] of Object.entries(extra)) {
      lines.push(`${indent}    ${name}: ${value}\n`);
    }

    return lines.join("");
  }

  _processmessage(tags: readonly string[], args: readonly unknown[]): void {
    if (this._writer !== null && args.length) {
      this._writer(this._format_message(tags, args));
    }
    const processor = this._tags2proc.get(tags.join(":"));
    if (processor) {
      processor(tags, args);
    }
  }

  setwriter(writer: Writer | null): void {
    this._writer = writer;
  }

  setprocessor(tags: string | readonly string[], processor: Processor): void {
    const key = typeof tags === "string" ? tags : tags.join(":");
    this._tags2proc.set(key, processor);
  }
}

export interface TagTracerSub {
  (...args: unknown[]): void;
}

export class TagTracerSub {
  declare root: TagTracer;
  declare tags: readonly string[];

  constructor(root: TagTracer, tags: readonly string[]) {
    const self = ((...args: unknown[]): void => {
      self.root._processmessage(self.tags, args);
    }) as unknown as TagTracerSub;
    Object.setPrototypeOf(self, new.target.prototype);
    self.root = root;
    self.tags = tags;
    return self;
  }

  get(name: string): TagTracerSub {
    return new (this.constructor as typeof TagTracerSub)(this.root, [
      ...this.tags,
      name,
    ]);
  }
}
