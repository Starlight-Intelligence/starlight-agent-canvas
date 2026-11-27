import { expect, test, type Locator, type Page } from '@playwright/test';

// The demo world is a synthetic fixture (tests/fixtures/worlds/demo.world.json).
// The server keeps edits in memory, so tests do not change the fixture file.

async function ready(page: Page) {
  await page.waitForFunction(() => Number(document.querySelector('.wc')?.getAttribute('data-total-nodes') ?? 0) > 0);
}

/**
 * The node version the inspector shows ("v7" -> 7). Versions come from one
 * world-wide counter, so after a change the number goes up but its exact
 * value depends on earlier writes to the shared demo world.
 */
async function versionOf(inspector: Locator): Promise<number> {
  const text = await inspector.locator('.wc-inspector-version').textContent();
  return Number(/^v(\d+)$/.exec(text?.trim() ?? '')?.[1] ?? Number.NaN);
}

test.describe('world canvas', () => {
  test('stress route renders only what is in view out of 10,000 nodes', async ({ page }) => {
    await page.goto('/world/stress?at=3000,2400&zoom=0.6');
    await ready(page);
    const wc = page.locator('.wc');
    await expect(wc).toHaveAttribute('data-total-nodes', '10000');
    await expect(wc).toHaveAttribute('data-level', 'card');
    await expect.poll(async () => Number(await wc.getAttribute('data-rendered-nodes'))).toBeGreaterThan(0);
    const dom = await page.locator('.react-flow__node').count();
    expect(dom).toBeGreaterThan(0);
    expect(dom).toBeLessThan(600);
  });

  test('cluster zoom shows regions with counts and no node text', async ({ page }) => {
    await page.goto('/world/stress');
    await ready(page);
    await expect(page.locator('.wc')).toHaveAttribute('data-level', 'cluster');
    await expect(page.locator('.wn')).toHaveCount(0);
    await expect(page.locator('.wr.is-cluster').first()).toBeVisible();
  });

  test('search jumps to a node and opens the inspector', async ({ page }) => {
    await page.goto('/world/demo');
    await ready(page);
    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox', { name: 'Search nodes' })).toBeFocused();
    await page.keyboard.type('Lantern');
    await page.keyboard.press('Enter');
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await expect(inspector.getByLabel('Title')).toHaveValue('Lantern keeper');
    await expect(page.locator('.wc')).toHaveAttribute('data-level', 'full');
    await expect(page.locator('.react-flow__node[data-id="n_gen_0"] .wn.is-selected')).toBeVisible();
  });

  test('editing writes an updateNode op with baseVersion and shows it in activity', async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 0) < 1100, 'activity rail starts closed on small screens');
    await page.goto('/world/demo?node=n_gen_1');
    await ready(page);
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    const before = await versionOf(inspector);
    await inspector.getByLabel('Summary').fill('A harbor where the sea is glass.');
    await inspector.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => versionOf(inspector)).toBeGreaterThan(before);
    const activity = page.getByRole('complementary', { name: 'Activity' });
    await expect(activity.getByText('Edited Harbor of glass')).toBeVisible();
    await expect(activity.locator('.wc-act--confirmed .wc-harness', { hasText: 'human' }).first()).toBeVisible();
  });

  test('propose canon sets proposed, never canon', async ({ page }, info) => {
    // The server keeps state across tests, so each project uses its own node.
    await page.goto(`/world/demo?node=${info.project.name === 'mobile' ? 'n_gen_4' : 'n_gen_2'}`);
    await ready(page);
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await inspector.getByRole('button', { name: 'Propose canon' }).click();
    await expect(inspector.locator('.wc-canon--proposed')).toBeVisible();
    await expect(page.locator('.wc-canon--canon')).toHaveCount(0);
  });

  test('relation picker adds an edge', async ({ page }, info) => {
    await page.goto(`/world/demo?node=${info.project.name === 'mobile' ? 'n_gen_5' : 'n_gen_0'}`);
    await ready(page);
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await inspector.getByLabel('Relation', { exact: true }).selectOption('located-at');
    await inspector.getByLabel('Target node').fill('Harbor');
    await inspector.getByRole('listbox').getByRole('button', { name: /Harbor of glass/ }).click();
    await inspector.getByRole('button', { name: 'Add relation' }).click();
    await expect(page.getByRole('status')).toContainText('Relation added');
    await expect(inspector.getByRole('button', { name: 'Located at Harbor of glass' })).toBeVisible();
  });

  test('arrow keys move selection between nodes with a visible focus ring', async ({ page }) => {
    await page.goto('/world/demo?at=600,500&zoom=0.8');
    await ready(page);
    await page.locator('.wc-stage .react-flow__pane').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('ArrowRight');
    const focused = page.locator('.react-flow__node:focus');
    await expect(focused).toHaveCount(1);
    const first = await focused.getAttribute('data-id');
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => page.locator('.react-flow__node:focus').getAttribute('data-id')).not.toBe(first);
    const ring = await page.locator('.react-flow__node:focus .wn').evaluate((el) => getComputedStyle(el).boxShadow);
    expect(ring).not.toBe('none');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toHaveCount(0);
  });

  test('timeline and map views render', async ({ page }) => {
    await page.goto('/world/demo');
    await ready(page);
    await page.getByRole('radio', { name: 'Timeline' }).click();
    await expect(page.locator('.wc')).toHaveAttribute('data-view', 'timeline');
    await expect.poll(() => page.locator('.react-flow__node').count()).toBeGreaterThan(1);
    await page.getByRole('radio', { name: 'Map' }).click();
    await expect(page.locator('.wr--map').first()).toBeVisible();
    await page.locator('.react-flow__node-region').first().click();
    await expect(page.locator('.wc')).toHaveAttribute('data-view', 'graph');
  });

  test('reduced motion turns off node transitions', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100/world/demo?at=600,500&zoom=0.8');
    await ready(page);
    const transition = await page.locator('.wn').first().evaluate((el) => getComputedStyle(el).transitionDuration);
    // globals.css clamps durations to 0.01ms under reduced motion.
    expect(transition.split(',').every((d) => parseFloat(d) < 0.001)).toBe(true);
    await context.close();
  });

  test('the ops route refuses cross-origin and non-JSON writes', async ({ request }) => {
    const op = { ops: [{ op: 'updateNode', id: 'n_gen_7', baseVersion: 1, patch: { title: 'Forged' } }] };
    const cross = await request.post('/api/worlds/demo/ops', { headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, data: JSON.stringify(op) });
    expect(cross.status()).toBe(403);
    const plain = await request.post('/api/worlds/demo/ops', { headers: { 'content-type': 'text/plain' }, data: JSON.stringify(op) });
    expect(plain.status()).toBe(415);
    const world = await (await request.get('/api/worlds/demo')).json();
    expect(world.nodes.find((n: { id: string }) => n.id === 'n_gen_7').title).not.toBe('Forged');
  });

  test('the add node shortcut only works in graph view', async ({ request, page }) => {
    const before = (await (await request.get('/api/worlds/demo')).json()).nodes.length;
    await page.goto('/world/demo');
    await ready(page);
    await page.getByRole('radio', { name: 'Timeline' }).click();
    await expect(page.locator('.wc')).toHaveAttribute('data-view', 'timeline');
    await page.locator('.wc-stage .react-flow__pane').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('n');
    await page.waitForTimeout(500);
    const after = (await (await request.get('/api/worlds/demo')).json()).nodes.length;
    expect(after).toBe(before);
  });

  test('dragging a node keeps unsaved inspector edits', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'drag is a desktop pointer interaction');
    await page.goto('/world/demo?node=n_gen_6&zoom=1');
    await ready(page);
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    const before = await versionOf(inspector);
    await inspector.getByLabel('Summary').fill('Draft that must survive a move');
    const box = await page.locator('.react-flow__node[data-id="n_gen_6"]').boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 40, box!.y + 20);
    await page.mouse.down();
    await page.mouse.move(box!.x + 120, box!.y + 60, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => versionOf(inspector)).toBeGreaterThan(before);
    await expect(inspector.getByLabel('Summary')).toHaveValue('Draft that must survive a move');
  });

  test('a rejected save keeps the draft and shows it as unsaved', async ({ page }, info) => {
    const id = info.project.name === 'mobile' ? 'n_gen_9' : 'n_gen_8';
    await page.route('**/api/worlds/demo/ops', (route) =>
      route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'STALE_VERSION', message: 'stale' } }) }),
    );
    await page.goto(`/world/demo?node=${id}`);
    await ready(page);
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    const before = await versionOf(inspector);
    await inspector.getByLabel('Summary').fill('Draft the server refused');
    await inspector.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.wc-toast')).toContainText('changed elsewhere');
    // The rollback and reload have landed: the node is back at its server version.
    await expect.poll(() => versionOf(inspector)).toBe(before);
    await expect(inspector.getByLabel('Summary')).toHaveValue('Draft the server refused');
    await expect(inspector.getByText('Not saved. Your draft is kept')).toBeVisible();
    await expect(inspector.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  test('Escape inside an inspector field closes it and returns focus to the node', async ({ page }) => {
    await page.goto('/world/demo?node=n_gen_10&zoom=1');
    await ready(page);
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await inspector.getByLabel('Summary').focus();
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
    await expect(page.locator('.react-flow__node[data-id="n_gen_10"]')).toBeFocused();
  });

  test('closing the inspector from the keyboard returns focus to the node', async ({ page }) => {
    await page.goto('/world/demo?node=n_gen_12&zoom=1');
    await ready(page);
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await inspector.getByRole('button', { name: 'Close inspector' }).focus();
    await page.keyboard.press('Enter');
    await expect(inspector).toHaveCount(0);
    await expect(page.locator('.react-flow__node[data-id="n_gen_12"]')).toBeFocused();
  });

  test('on mobile, Tab from the inspector sheet does not reach canvas nodes behind it', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'the inspector is a sheet over the canvas only on narrow screens');
    await page.goto('/world/demo?node=n_gen_0&zoom=1');
    await ready(page);
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await inspector.getByRole('button', { name: 'Close inspector' }).focus();
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.wc-stage .react-flow')))).toBe(false);
    }
  });

  test('arrow keys reach a node beyond the rendered area and pan to it', async ({ page, request }, info) => {
    const mobile = info.project.name === 'mobile';
    const id = `n_far_${info.project.name}`;
    const start = mobile ? 'n_gen_23' : 'n_gen_7';
    // Right of the right-most column, far outside the rendered (padded) viewport at this zoom.
    await request.post('/api/worlds/demo/ops', {
      headers: { 'content-type': 'application/json' },
      data: { ops: [{ op: 'addNode', node: { id, kind: 'note', title: `Far beacon ${info.project.name}`, position: { x: 3400, y: mobile ? 620 : 230 } } }] },
    });
    await page.goto(`/world/demo?node=${start}&zoom=1.5`);
    await ready(page);
    await expect(page.locator(`.react-flow__node[data-id="${id}"]`)).toHaveCount(0);
    await page.locator(`.react-flow__node[data-id="${start}"]`).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.react-flow__node:focus')).toHaveAttribute('data-id', id);
    await expect(page.getByRole('complementary', { name: 'Inspector' }).getByLabel('Title')).toHaveValue(`Far beacon ${info.project.name}`);
  });

  test('arrow keys move between timeline nodes at cluster zoom', async ({ page }) => {
    await page.goto('/world/demo?view=timeline');
    await ready(page);
    await expect.poll(() => page.locator('.react-flow__node').count()).toBeGreaterThan(1);
    const wc = page.locator('.wc');
    for (let i = 0; i < 12 && (await wc.getAttribute('data-level')) !== 'cluster'; i++) {
      await page.locator('.wc-stage .react-flow__pane').click({ position: { x: 10, y: 10 } });
      await page.keyboard.press('-');
      await page.waitForTimeout(450);
    }
    await expect(wc).toHaveAttribute('data-level', 'cluster');
    await page.locator('.wc-stage .react-flow__pane').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('ArrowRight');
    const focused = page.locator('.react-flow__node:focus');
    await expect(focused).toHaveCount(1);
    expect(await focused.getAttribute('data-id')).toMatch(/^n_/);
  });
});
