import { expect, test, type Page } from '@playwright/test';

// The demo world is a synthetic fixture (tests/fixtures/worlds/demo.world.json).
// The server keeps edits in memory, so tests do not change the fixture file.

async function ready(page: Page) {
  await page.waitForFunction(() => Number(document.querySelector('.wc')?.getAttribute('data-total-nodes') ?? 0) > 0);
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
    await expect(inspector.getByText('v1', { exact: true })).toBeVisible();
    await inspector.getByLabel('Summary').fill('A harbor where the sea is glass.');
    await inspector.getByRole('button', { name: 'Save changes' }).click();
    await expect(inspector.getByText('v2', { exact: true })).toBeVisible();
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
});
