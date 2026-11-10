/* HTTPException and request-body schemas.
   Bodies are validated with Fastify's JSON Schema (Ajv: coerces "3" to 3 and fills defaults, like
   pydantic's lax mode); a failure answers 422 with a FastAPI-style `detail` list. */

export class HttpError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(typeof detail === 'string' ? detail : `HTTP ${status}`);
  }
}

export function fail(status: number, detail: unknown): never {
  throw new HttpError(status, detail);
}

// --------------------------------------------------------------- schemas
type S = Record<string, unknown>;
const nullable = (s: S): S => ({ ...s, type: [s.type, 'null'] });

export const int = (extra: S = {}): S => ({ type: 'integer', ...extra });
export const str = (extra: S = {}): S => ({ type: 'string', ...extra });
export const bool = (extra: S = {}): S => ({ type: 'boolean', ...extra });
export const anyValue = (extra: S = {}): S => ({ ...extra });
export const dict = (extra: S = {}): S => ({ type: 'object', ...extra });
export const list = (items: S, extra: S = {}): S => ({ type: 'array', items, ...extra });
export const oneOf = (values: (string | number)[], extra: S = {}): S => ({ type: typeof values[0] === 'number' ? 'integer' : 'string', enum: values, ...extra });
/** `x: T | None = None` */
export const optional = (s: S): S => ({ ...nullable(s), default: null });

/** A pydantic model: fields without a `default` are required. */
export function model(fields: Record<string, S>): S {
  return {
    type: 'object',
    properties: fields,
    required: Object.keys(fields).filter(k => !('default' in fields[k])),
  };
}

export const params = (names: string[]): S => model(Object.fromEntries(names.map(n => [n, int()])));
