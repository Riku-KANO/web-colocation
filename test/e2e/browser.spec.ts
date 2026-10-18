// End-to-end tests in real browsers: two participants, the lobby, the XR emulator and host settings.

import { expect, test, type Browser, type Page } from '@playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */
type W = Window & { __colo: any; __xrDevice: any };

async function open(browser: Browser, path: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
  await page.goto(path);
  return page;
}

async function join(browser: Browser, name: string, room: string, extra = ''): Promise<Page> {
  const page = await open(browser, `/?room=${encodeURIComponent(room)}&name=${name}&autojoin=1&lang=en${extra}`);
  await page.waitForFunction(() => !!(window as unknown as W).__colo?.room, null, { timeout: 15_000 });
  return page;
}

/** Screen position of a world point (object or board) on the page's canvas. */
function screenOf(page: Page, what: { object?: string; board?: string; dx?: number }) {
  return page.evaluate(({ object, board, dx }) => {
    const app = (window as unknown as W).__colo;
    const node = object ? app.objects.get(object).root : app.boards.get(board).surface;
    const v = node.getWorldPosition(node.position.clone());
    if (dx) v.x += dx;
    v.project(app.camera);
    const r = app.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }, what);
}

test('moves and drawings made by one participant reach the other', async ({ browser }) => {
  const alice = await join(browser, 'Alice', 'e2e-sync');
  const bob = await join(browser, 'Bob', 'e2e-sync');
  await expect.poll(() => alice.evaluate(() => (window as unknown as W).__colo.peers.size)).toBe(2);

  // Drag the cube with the mouse.
  const cube = await screenOf(alice, { object: 'cube' });
  await alice.mouse.move(cube.x, cube.y);
  await alice.mouse.down();
  await alice.mouse.move(cube.x + 140, cube.y + 30, { steps: 10 });
  await alice.mouse.up();
  const before = -0.35;
  await expect
    .poll(() => bob.evaluate(() => (window as unknown as W).__colo.objects.get('cube').targetP.x))
    .toBeGreaterThan(before + 0.05);

  // Draw a line across the whiteboard.
  const from = await screenOf(alice, { board: 'wb1' });
  await alice.mouse.move(from.x - 60, from.y - 20);
  await alice.mouse.down();
  await alice.mouse.move(from.x + 60, from.y + 20, { steps: 10 });
  await alice.mouse.up();
  await expect.poll(() => bob.evaluate(() => (window as unknown as W).__colo.boards.strokeCount)).toBe(1);
});

test('the lobby lists configured rooms and asks for passcodes', async ({ browser }) => {
  const page = await open(browser, '/?lang=en');
  await expect(page.getByRole('heading', { name: 'Acme XR Rooms' })).toBeVisible();
  await page.getByPlaceholder('e.g. Alex').fill('Carol');
  await page.getByRole('button', { name: /Private room/ }).click();
  await page.locator('input[name="passcode"]').fill('0000');
  // A wrong passcode brings up a prompt; answer it with the right one.
  page.once('dialog', (d) => void d.accept('1234'));
  await page.getByRole('button', { name: 'Join' }).click();
  await page.waitForFunction(() => (window as unknown as W).__colo?.room?.id === 'private', null, { timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as W).__colo.room.template)).toBe('round-table');
});

test('XR (emulated Quest 3): a pen held in the hand writes on the board', async ({ browser }) => {
  const watcher = await join(browser, 'Watcher', 'e2e-xr');
  const xr = await join(browser, 'Quest', 'e2e-xr', '&emulate=quest3');
  await xr.getByRole('button', { name: 'Enter AR' }).click();
  await xr.waitForFunction(() => (window as unknown as W).__colo.renderer.xr.isPresenting);

  await xr.evaluate(async () => {
    const w = window as unknown as W;
    const app = w.__colo;
    const r = w.__xrDevice.controllers.right;
    const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
    await wait(500);
    app.scene.updateMatrixWorld();
    const pen = app.objects.get('pen-black').root;
    const V = pen.position.constructor;
    const p = pen.getWorldPosition(new V());
    r.position.set(p.x, p.y, p.z);
    await wait(200);
    r.updateButtonValue('squeeze', 1);
    await wait(300);
    // Point the controller at the board and sweep the pen tip across it.
    const root = app.frame.root;
    const centre = root.localToWorld(new V(1.0, 0.5, 0));
    const toward = root.localToWorld(new V(0, 0.5, 0)).sub(centre).normalize();
    const yaw = Math.atan2(toward.x, toward.z);
    r.quaternion.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
    for (let i = 0; i <= 15; i++) {
      const onBoard = root.localToWorld(new V(1.0, 0.4 + 0.02 * i, -0.3 + 0.04 * i));
      const c = onBoard.clone().addScaledVector(toward, 0.03 + 0.078 - 0.002);
      r.position.set(c.x, c.y, c.z);
      await wait(40);
    }
    const away = root.localToWorld(new V(0.5, 0.5, 0));
    r.position.set(away.x, away.y, away.z);
    await wait(200);
    r.updateButtonValue('squeeze', 0);
    await wait(200);
  });
  await expect.poll(() => watcher.evaluate(() => (window as unknown as W).__colo.boards.strokeCount)).toBe(1);
  expect(await xr.evaluate(() => (window as unknown as W).__colo.loopErrors)).toBe(0);
});

test('a host changes the layout and permissions for everyone', async ({ browser }) => {
  const host = await join(browser, 'Host', 'e2e-settings');
  const member = await join(browser, 'Member', 'e2e-settings');
  expect(await host.evaluate(() => (window as unknown as W).__colo.self.role)).toBe('host');
  await expect(member.getByRole('button', { name: 'Room settings' })).toBeHidden();

  await host.getByRole('button', { name: 'Room settings' }).click();
  const dialog = host.locator('dialog.settings');
  await dialog.locator('select[name="template"]').selectOption('workshop');
  await dialog.locator('select[name="clearBoard"]').selectOption('hosts');
  await dialog.getByRole('button', { name: 'Apply' }).click();

  await expect.poll(() => member.evaluate(() => (window as unknown as W).__colo.room?.template)).toBe('workshop');
  expect(await member.evaluate(() => [...(window as unknown as W).__colo.boards.all()].length)).toBe(2);
  await expect(member.getByRole('button', { name: 'Clear boards' })).toBeDisabled();
  await expect(host.getByRole('button', { name: 'Clear boards' })).toBeEnabled();
});
