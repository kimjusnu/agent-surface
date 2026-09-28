/**
 * Shared A2UI v0.9 fixtures.
 *
 * The catalog uses the canonical `common_types.json#/$defs/...` references the
 * real wire format carries. That matters: `schema_loader` turns a bare
 * `{type:'string'}` property into a plain `z.string()`, so a `DataBinding`
 * object on that property would be rejected by the `.strict()` component
 * schema. `DynamicString` is the union `[z.string(), DataBindingSchema,
 * FunctionCallSchema]`, which is what actually admits bindings.
 */

export const TEST_CATALOG_ID = 'agent-surface-test';

export const TEST_CATALOG = {
  catalogId: TEST_CATALOG_ID,
  components: {
    Column: {
      properties: { children: { $ref: 'common_types.json#/$defs/ChildList' } },
    },
    Text: {
      properties: { text: { $ref: 'common_types.json#/$defs/DynamicString' } },
    },
    Button: {
      properties: {
        label: { $ref: 'common_types.json#/$defs/DynamicString' },
        onClick: { $ref: 'common_types.json#/$defs/Action' },
      },
    },
    Card: {
      properties: {
        header: { $ref: 'common_types.json#/$defs/ComponentId' },
        body: { $ref: 'common_types.json#/$defs/ComponentId' },
      },
    },
  },
} as const;

/** Catalog with no declared children prop, for the "no child refs" path. */
export const FLAT_CATALOG = {
  catalogId: 'flat',
  components: {
    Text: { properties: { text: { $ref: 'common_types.json#/$defs/DynamicString' } } },
  },
} as const;

export const CREATE_SURFACE_V09 = {
  version: 'v0.9',
  createSurface: { surfaceId: 's1', catalogId: TEST_CATALOG_ID, sendDataModel: true },
} as const;

export const UPDATE_COMPONENTS_V09 = {
  version: 'v0.9',
  updateComponents: {
    surfaceId: 's1',
    components: [
      { id: 'root', component: 'Column', children: ['greeting', 'cta'] },
      { id: 'greeting', component: 'Text', text: { path: '/user/name' } },
      {
        id: 'cta',
        component: 'Button',
        label: 'Continue',
        onClick: { event: { name: 'continue' } },
      },
    ],
  },
} as const;

export const UPDATE_DATA_MODEL_V09 = {
  version: 'v0.9',
  updateDataModel: { surfaceId: 's1', path: '/user/name', value: 'Ada' },
} as const;

export const DELETE_SURFACE_V09 = {
  version: 'v0.9',
  deleteSurface: { surfaceId: 's1' },
} as const;

/**
 * A full A2UI v0.9 conversation as one JSONL stream: a multi-line body, a CRLF
 * line, a blank separator, and a malformed line the reader must survive.
 */
export const A2UI_V0_9_JSONL = [
  '{"version":"v0.9","createSurface":{"surfaceId":"s1","catalogId":"agent-surface-test","sendDataModel":true}}',
  '{"version":"v0.9","updateComponents":{"surfaceId":"s1","components":[{"id":"root","component":"Column","children":["greeting"]},{"id":"greeting","component":"Text","text":{"path":"/user/name"}}]}}',
  '{"version":"v0.9.1","updateDataModel":{"surfaceId":"s1","path":"/user/name","value":"Ada Lovelace"}}',
  '',
  '{"version":"v0.9","deleteSurface":{"surfaceId":"s1"}}',
].join('\n');

/** The same stream with one line broken, to exercise tolerance. */
export const A2UI_V0_9_JSONL_WITH_BAD_LINE = [
  CREATE_SURFACE_V09,
  '{"version":"v0.9","updateComponents":{',
  UPDATE_DATA_MODEL_V09,
  DELETE_SURFACE_V09,
]
  .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
  .join('\n');
