type JsonSchema = Record<string, unknown>;

type SchemaOptions = Record<string, unknown>;

function applyOptions(base: JsonSchema, options?: SchemaOptions): JsonSchema {
  return options == null ? base : { ...base, ...options };
}

export const Type = {
  String(options?: SchemaOptions): JsonSchema {
    return applyOptions({ type: "string" }, options);
  },

  Boolean(options?: SchemaOptions): JsonSchema {
    return applyOptions({ type: "boolean" }, options);
  },

  Integer(options?: SchemaOptions): JsonSchema {
    return applyOptions({ type: "integer" }, options);
  },

  Array(items: JsonSchema, options?: SchemaOptions): JsonSchema {
    return applyOptions(
      {
        type: "array",
        items
      },
      options
    );
  },

  Literal(value: string | number | boolean): JsonSchema {
    return {
      const: value,
      type: typeof value
    };
  },

  Union(items: JsonSchema[], options?: SchemaOptions): JsonSchema {
    return applyOptions(
      {
        anyOf: items
      },
      options
    );
  },

  Optional(schema: JsonSchema): JsonSchema {
    return {
      ...schema,
      __optional: true
    };
  },

  Object(properties: Record<string, JsonSchema>, options?: SchemaOptions): JsonSchema {
    const required = Object.entries(properties)
      .filter(([, schema]) => schema.__optional !== true)
      .map(([key]) => key);
    const normalizedProperties = Object.fromEntries(
      Object.entries(properties).map(([key, schema]) => {
        if (schema.__optional === true) {
          const { __optional: _optional, ...rest } = schema;
          return [key, rest];
        }
        return [key, schema];
      })
    );
    return applyOptions(
      {
        type: "object",
        properties: normalizedProperties,
        additionalProperties: false,
        ...(required.length > 0 ? { required } : {})
      },
      options
    );
  }
};
