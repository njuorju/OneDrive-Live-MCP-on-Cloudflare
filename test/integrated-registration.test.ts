import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerIntegratedTools, type IntegratedContext } from '../src/integrated-tools.js';

const EXPECTED = [
  'create_source_snapshot','query_source_snapshot','compare_snapshot_to_live','inspect_document','calculate_file_hashes','find_source_duplicates',
  'scan_visual_sources','list_document_visuals','render_document_page','fetch_document_visual_for_analysis','fetch_document_visual_original',
  'save_document_visual','create_visual_contact_sheet','find_visual_duplicates','copy_item','create_integrity_plan','validate_integrity_plan',
  'execute_integrity_plan','get_integrity_plan_status','diff_scope_before_after','validate_catalogue','classify_administrative_files','get_job_status',
] as const;

function mockContext(): IntegratedContext {
  return {
    env: { COOKIE_ENCRYPTION_KEY: 'test', BROWSER: {} as BrowserRun, IMAGES: {} as ImagesBinding, MAX_ORIGINAL_FILE_MB: '25' },
    userId: 'fixture-user',
    storage: {
      async get(){return undefined;}, async put(){}, async delete(){return true;}, async list(){return new Map();},
    },
  } as IntegratedContext;
}

test('all integrated tools register exactly once', () => {
  const server = new McpServer({name:'fixture',version:'1'});
  registerIntegratedTools(server, mockContext);
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  assert.deepEqual(Object.keys(tools).sort(), [...EXPECTED].sort());
});

test('no generic permanent-delete or recycle-bin-emptying tool is exposed', () => {
  const server = new McpServer({name:'fixture',version:'1'});
  registerIntegratedTools(server, mockContext);
  const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  assert.equal(names.some(name => /(^|_)(delete|permanent_delete|empty_recycle_bin)($|_)/i.test(name)), false);
});

test('destructive execution is confined to validated-plan tool', () => {
  const server = new McpServer({name:'fixture',version:'1'});
  registerIntegratedTools(server, mockContext);
  const tools = (server as unknown as { _registeredTools: Record<string, { annotations?: { destructiveHint?: boolean } }> })._registeredTools;
  const destructive = Object.entries(tools).filter(([,tool]) => tool.annotations?.destructiveHint).map(([name])=>name);
  assert.deepEqual(destructive, ['execute_integrity_plan']);
});

test('every integrated tool publishes explicit discoverable input properties', () => {
  const server = new McpServer({name:'fixture',version:'1'});
  registerIntegratedTools(server, mockContext);
  const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema?: { def?: { shape?: Record<string, unknown> | (() => Record<string, unknown>) } } }> })._registeredTools;
  for (const name of EXPECTED) {
    const rawShape = tools[name]?.inputSchema?.def?.shape;
    const shape = typeof rawShape === 'function' ? rawShape() : rawShape;
    assert.ok(shape && Object.keys(shape).length > 0, `${name} must expose explicit input properties`);
  }
  const renderShapeRaw = tools.render_document_page.inputSchema?.def?.shape;
  const renderShape = typeof renderShapeRaw === 'function' ? renderShapeRaw() : renderShapeRaw;
  assert.ok(renderShape && 'pageOrSlide' in renderShape && 'dpi' in renderShape && 'cropRegion' in renderShape);
});
